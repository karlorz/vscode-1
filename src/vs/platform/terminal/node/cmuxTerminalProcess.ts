/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../log/common/log.js';
import { FlowControlConstants, IProcessProperty, IProcessPropertyMap, IProcessReadyEvent, IShellLaunchConfig, ITerminalChildProcess, ITerminalLaunchError, ITerminalLaunchResult, ITerminalProcessOptions, ProcessPropertyType, TerminalShellType } from '../common/terminal.js';
import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';
import { Socket } from 'net';

/**
 * CmuxTerminalProcess connects to a cmux-xterm server instead of spawning
 * a local PTY via node-pty. This enables persistent terminal sessions that
 * survive server restarts and can be reattached.
 *
 * Communication:
 * - HTTP POST /api/tabs to create sessions
 * - HTTP GET /api/tabs to list sessions
 * - HTTP DELETE /api/tabs/:id to terminate sessions
 * - WebSocket /ws/:id for I/O
 */
export class CmuxTerminalProcess extends Disposable implements ITerminalChildProcess {
	readonly id = 0;
	readonly shouldPersist = true; // cmux sessions persist

	private _properties: IProcessPropertyMap = {
		cwd: '',
		initialCwd: '',
		fixedDimensions: { cols: undefined, rows: undefined },
		title: '',
		shellType: undefined,
		hasChildProcesses: true,
		resolvedShellLaunchConfig: {},
		overrideDimensions: undefined,
		failedShellIntegrationActivation: false,
		usedShellIntegrationInjection: undefined,
		shellIntegrationInjectionFailureReason: undefined,
	};

	private _cmuxSessionId: string | undefined;
	private _socket: Socket | undefined;
	private _exitCode: number | undefined;
	private readonly _initialCwd: string;
	private readonly _cmuxUrl: string;

	private _isPtyPaused: boolean = false;
	private _unacknowledgedCharCount: number = 0;

	get exitMessage(): string | undefined { return undefined; }
	get currentTitle(): string { return this._properties.title; }
	get shellType(): TerminalShellType | undefined { return this._properties.shellType; }
	get hasChildProcesses(): boolean { return this._properties.hasChildProcesses; }

	private readonly _onProcessData = this._register(new Emitter<string>());
	readonly onProcessData = this._onProcessData.event;
	private readonly _onProcessReady = this._register(new Emitter<IProcessReadyEvent>());
	readonly onProcessReady = this._onProcessReady.event;
	private readonly _onDidChangeProperty = this._register(new Emitter<IProcessProperty>());
	readonly onDidChangeProperty = this._onDidChangeProperty.event;
	private readonly _onProcessExit = this._register(new Emitter<number>());
	readonly onProcessExit = this._onProcessExit.event;

	constructor(
		readonly shellLaunchConfig: IShellLaunchConfig,
		cwd: string,
		private _cols: number,
		private _rows: number,
		_env: Record<string, string | undefined>,
		_executableEnv: Record<string, string | undefined>,
		_options: ITerminalProcessOptions,
		@ILogService private readonly _logService: ILogService,
		cmuxUrl?: string,
		existingSessionId?: string
	) {
		super();
		this._initialCwd = cwd;
		this._cmuxUrl = cmuxUrl || process.env['CMUX_XTERM_URL'] || 'http://127.0.0.1:39383';
		this._cmuxSessionId = existingSessionId;
		this._properties[ProcessPropertyType.InitialCwd] = this._initialCwd;
		this._properties[ProcessPropertyType.Cwd] = this._initialCwd;

		this._register(toDisposable(() => {
			this._closeSocket();
		}));
	}

	async start(): Promise<ITerminalLaunchError | ITerminalLaunchResult | undefined> {
		try {
			// If we have an existing session ID, just connect to it
			if (this._cmuxSessionId) {
				this._logService.trace('CmuxTerminalProcess: Attaching to existing session', this._cmuxSessionId);
			} else {
				// Create a new cmux session
				const response = await this._createCmuxSession();
				this._cmuxSessionId = response.id;
				this._logService.trace('CmuxTerminalProcess: Created new session', this._cmuxSessionId);
			}

			// Connect WebSocket for I/O
			await this._connectWebSocket();

			// Fire ready event with a pseudo-PID (use session ID hash)
			const pseudoPid = this._hashSessionId(this._cmuxSessionId!);
			this._onProcessReady.fire({
				pid: pseudoPid,
				cwd: this._initialCwd,
				windowsPty: undefined
			});

			return undefined;
		} catch (err) {
			this._logService.error('CmuxTerminalProcess: Failed to start', err);
			return { message: `Failed to create cmux session: ${(err as Error).message}` };
		}
	}

	private _hashSessionId(sessionId: string): number {
		// Generate a pseudo-PID from session ID for compatibility
		let hash = 0;
		for (let i = 0; i < sessionId.length; i++) {
			const char = sessionId.charCodeAt(i);
			hash = ((hash << 5) - hash) + char;
			hash = hash & hash; // Convert to 32bit integer
		}
		return Math.abs(hash);
	}

	private async _createCmuxSession(): Promise<{ id: string; ws_url: string }> {
		const url = new URL('/api/tabs', this._cmuxUrl);
		const body = JSON.stringify({
			cmd: this.shellLaunchConfig.executable || undefined,
			args: this.shellLaunchConfig.args || [],
			cols: this._cols,
			rows: this._rows
		});

		return new Promise((resolve, reject) => {
			const protocol = url.protocol === 'https:' ? https : http;
			const req = protocol.request(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(body)
				}
			}, (res) => {
				let data = '';
				res.on('data', chunk => data += chunk);
				res.on('end', () => {
					if (res.statusCode === 200) {
						try {
							resolve(JSON.parse(data));
						} catch (e) {
							reject(new Error(`Invalid JSON response: ${data}`));
						}
					} else {
						reject(new Error(`HTTP ${res.statusCode}: ${data}`));
					}
				});
			});

			req.on('error', reject);
			req.write(body);
			req.end();
		});
	}

	private async _connectWebSocket(): Promise<void> {
		if (!this._cmuxSessionId) {
			throw new Error('No session ID');
		}

		const url = new URL(`/ws/${this._cmuxSessionId}`, this._cmuxUrl);
		const isSecure = url.protocol === 'https:';
		const port = url.port || (isSecure ? '443' : '80');
		const key = crypto.randomBytes(16).toString('base64');

		this._logService.trace('CmuxTerminalProcess: Connecting WebSocket', url.toString());

		return new Promise((resolve, reject) => {
			const options = {
				host: url.hostname,
				port: parseInt(port, 10),
				path: url.pathname,
				headers: {
					'Connection': 'Upgrade',
					'Upgrade': 'websocket',
					'Sec-WebSocket-Key': key,
					'Sec-WebSocket-Version': '13'
				}
			};

			const req = (isSecure ? https : http).request(options);

			req.on('upgrade', (res, socket) => {
				this._socket = socket;

				socket.on('data', (data: Buffer) => {
					// Parse WebSocket frames
					const frames = this._parseWebSocketFrames(data);
					for (const frame of frames) {
						if (frame.opcode === 0x01 || frame.opcode === 0x02) { // Text or Binary
							const text = frame.payload.toString('utf-8');

							// Handle flow control
							this._unacknowledgedCharCount += text.length;
							if (!this._isPtyPaused && this._unacknowledgedCharCount > FlowControlConstants.HighWatermarkChars) {
								this._logService.trace(`CmuxTerminalProcess: Flow control pause`);
								this._isPtyPaused = true;
							}

							this._onProcessData.fire(text);
						} else if (frame.opcode === 0x08) { // Close
							this._exitCode = 0;
							this._onProcessExit.fire(this._exitCode);
						}
					}
				});

				socket.on('close', () => {
					this._logService.trace('CmuxTerminalProcess: Socket closed');
					this._exitCode = this._exitCode ?? 0;
					this._onProcessExit.fire(this._exitCode);
				});

				socket.on('error', (err) => {
					this._logService.error('CmuxTerminalProcess: Socket error', err);
				});

				resolve();
			});

			req.on('error', reject);
			req.end();
		});
	}

	private _parseWebSocketFrames(data: Buffer): Array<{ opcode: number; payload: Buffer }> {
		const frames: Array<{ opcode: number; payload: Buffer }> = [];
		let offset = 0;

		while (offset < data.length) {
			if (offset + 2 > data.length) {
				break;
			}

			const byte1 = data[offset];
			const byte2 = data[offset + 1];
			const opcode = byte1 & 0x0F;
			const masked = (byte2 & 0x80) !== 0;
			let payloadLength = byte2 & 0x7F;
			offset += 2;

			if (payloadLength === 126) {
				if (offset + 2 > data.length) {
					break;
				}
				payloadLength = data.readUInt16BE(offset);
				offset += 2;
			} else if (payloadLength === 127) {
				if (offset + 8 > data.length) {
					break;
				}
				payloadLength = Number(data.readBigUInt64BE(offset));
				offset += 8;
			}

			let maskKey: Buffer | undefined;
			if (masked) {
				if (offset + 4 > data.length) {
					break;
				}
				maskKey = data.subarray(offset, offset + 4);
				offset += 4;
			}

			if (offset + payloadLength > data.length) {
				break;
			}
			let payload = data.subarray(offset, offset + payloadLength);
			offset += payloadLength;

			if (maskKey) {
				payload = Buffer.from(payload);
				for (let i = 0; i < payload.length; i++) {
					payload[i] ^= maskKey[i % 4];
				}
			}

			frames.push({ opcode, payload });
		}

		return frames;
	}

	private _createWebSocketFrame(data: string | Buffer): Buffer {
		const payload = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
		const opcode = typeof data === 'string' ? 0x01 : 0x02; // Text or Binary

		// Client frames MUST be masked
		const mask = crypto.randomBytes(4);
		const maskedPayload = Buffer.from(payload);
		for (let i = 0; i < maskedPayload.length; i++) {
			maskedPayload[i] ^= mask[i % 4];
		}

		let header: Buffer;
		if (payload.length < 126) {
			header = Buffer.alloc(6);
			header[0] = 0x80 | opcode; // FIN + opcode
			header[1] = 0x80 | payload.length; // Masked + length
			mask.copy(header, 2);
		} else if (payload.length < 65536) {
			header = Buffer.alloc(8);
			header[0] = 0x80 | opcode;
			header[1] = 0x80 | 126;
			header.writeUInt16BE(payload.length, 2);
			mask.copy(header, 4);
		} else {
			header = Buffer.alloc(14);
			header[0] = 0x80 | opcode;
			header[1] = 0x80 | 127;
			header.writeBigUInt64BE(BigInt(payload.length), 2);
			mask.copy(header, 10);
		}

		return Buffer.concat([header, maskedPayload]);
	}

	private _closeSocket(): void {
		if (this._socket) {
			this._socket.destroy();
			this._socket = undefined;
		}
	}

	shutdown(immediate: boolean): void {
		this._logService.trace('CmuxTerminalProcess: shutdown', { immediate });

		if (immediate) {
			// Delete the cmux session
			this._deleteCmuxSession().catch(err => {
				this._logService.error('CmuxTerminalProcess: Failed to delete session', err);
			});
		}

		this._closeSocket();
		this._onProcessExit.fire(this._exitCode || 0);
		this.dispose();
	}

	private async _deleteCmuxSession(): Promise<void> {
		if (!this._cmuxSessionId) {
			return;
		}

		const url = new URL(`/api/tabs/${this._cmuxSessionId}`, this._cmuxUrl);

		return new Promise((resolve, reject) => {
			const protocol = url.protocol === 'https:' ? https : http;
			const req = protocol.request(url, {
				method: 'DELETE'
			}, (res) => {
				if (res.statusCode === 204 || res.statusCode === 200) {
					resolve();
				} else {
					let data = '';
					res.on('data', chunk => data += chunk);
					res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${data}`)));
				}
			});

			req.on('error', reject);
			req.end();
		});
	}

	input(data: string, _isBinary: boolean = false): void {
		if (this._store.isDisposed || !this._socket || this._socket.destroyed) {
			return;
		}
		this._logService.trace('CmuxTerminalProcess: input', data.length, 'chars');
		const frame = this._createWebSocketFrame(data);
		this._socket.write(frame);
	}

	sendSignal(signal: string): void {
		this._logService.trace('CmuxTerminalProcess: sendSignal', signal);
		// TODO: Implement signal sending via cmux control message
		// For now, SIGTERM/SIGKILL will trigger session deletion
		if (signal === 'SIGTERM' || signal === 'SIGKILL') {
			this.shutdown(true);
		}
	}

	async processBinary(data: string): Promise<void> {
		this.input(data, true);
	}

	async refreshProperty<T extends ProcessPropertyType>(type: T): Promise<IProcessPropertyMap[T]> {
		switch (type) {
			case ProcessPropertyType.Cwd:
				return this._properties.cwd as IProcessPropertyMap[T];
			case ProcessPropertyType.InitialCwd:
				return this._properties.initialCwd as IProcessPropertyMap[T];
			case ProcessPropertyType.Title:
				return this.currentTitle as IProcessPropertyMap[T];
			default:
				return this.shellType as IProcessPropertyMap[T];
		}
	}

	async updateProperty<T extends ProcessPropertyType>(type: T, value: IProcessPropertyMap[T]): Promise<void> {
		if (type === ProcessPropertyType.FixedDimensions) {
			this._properties.fixedDimensions = value as IProcessPropertyMap[ProcessPropertyType.FixedDimensions];
		}
	}

	resize(cols: number, rows: number): void {
		if (this._store.isDisposed || !this._socket || this._socket.destroyed) {
			return;
		}
		this._cols = cols;
		this._rows = rows;
		this._logService.trace('CmuxTerminalProcess: resize', cols, rows);

		// Send resize control message as JSON text frame
		const controlMsg = JSON.stringify({
			type: 'resize',
			cols,
			rows
		});
		const frame = this._createWebSocketFrame(controlMsg);
		this._socket.write(frame);
	}

	clearBuffer(): void {
		// cmux doesn't have a clear buffer command yet
		this._logService.trace('CmuxTerminalProcess: clearBuffer (no-op)');
	}

	acknowledgeDataEvent(charCount: number): void {
		this._unacknowledgedCharCount = Math.max(this._unacknowledgedCharCount - charCount, 0);
		this._logService.trace(`CmuxTerminalProcess: Flow control ack ${charCount} chars`);
		if (this._isPtyPaused && this._unacknowledgedCharCount < FlowControlConstants.LowWatermarkChars) {
			this._logService.trace(`CmuxTerminalProcess: Flow control resume`);
			this._isPtyPaused = false;
		}
	}

	clearUnacknowledgedChars(): void {
		this._unacknowledgedCharCount = 0;
		this._isPtyPaused = false;
		this._logService.trace('CmuxTerminalProcess: Cleared all unacknowledged chars');
	}

	async setUnicodeVersion(_version: '6' | '11'): Promise<void> {
		// No-op for cmux
	}

	getInitialCwd(): Promise<string> {
		return Promise.resolve(this._initialCwd);
	}

	async getCwd(): Promise<string> {
		return this._properties.cwd || this._initialCwd;
	}

	getWindowsPty(): undefined {
		return undefined;
	}

	/**
	 * Get the cmux session ID for this terminal
	 */
	getCmuxSessionId(): string | undefined {
		return this._cmuxSessionId;
	}
}

/**
 * Utility function to list all existing cmux sessions
 */
export async function listCmuxSessions(cmuxUrl?: string): Promise<string[]> {
	const url = new URL('/api/tabs', cmuxUrl || process.env['CMUX_XTERM_URL'] || 'http://127.0.0.1:39383');

	return new Promise((resolve, reject) => {
		const protocol = url.protocol === 'https:' ? https : http;
		const req = protocol.request(url, {
			method: 'GET'
		}, (res) => {
			let data = '';
			res.on('data', chunk => data += chunk);
			res.on('end', () => {
				if (res.statusCode === 200) {
					try {
						resolve(JSON.parse(data));
					} catch (e) {
						reject(new Error(`Invalid JSON response: ${data}`));
					}
				} else {
					reject(new Error(`HTTP ${res.statusCode}: ${data}`));
				}
			});
		});

		req.on('error', reject);
		req.end();
	});
}

/**
 * Check if cmux backend is available
 */
export function isCmuxEnabled(): boolean {
	return !!process.env['CMUX_XTERM_URL'];
}
