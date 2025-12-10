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
import WebSocket from 'ws';

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
	private _ws: WebSocket | undefined;
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
		private readonly _options: ITerminalProcessOptions,
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
			this._closeWebSocket();
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

		const wsUrl = this._cmuxUrl.replace(/^http/, 'ws') + `/ws/${this._cmuxSessionId}`;
		this._logService.trace('CmuxTerminalProcess: Connecting WebSocket', wsUrl);

		return new Promise((resolve, reject) => {
			this._ws = new WebSocket(wsUrl);

			this._ws.on('open', () => {
				this._logService.trace('CmuxTerminalProcess: WebSocket connected');
				resolve();
			});

			this._ws.on('message', (data: Buffer | string) => {
				const text = typeof data === 'string' ? data : data.toString('utf-8');

				// Handle flow control
				this._unacknowledgedCharCount += text.length;
				if (!this._isPtyPaused && this._unacknowledgedCharCount > FlowControlConstants.HighWatermarkChars) {
					this._logService.trace(`CmuxTerminalProcess: Flow control pause (${this._unacknowledgedCharCount} > ${FlowControlConstants.HighWatermarkChars})`);
					this._isPtyPaused = true;
					// Note: cmux doesn't support pause/resume yet, so this is informational only
				}

				this._onProcessData.fire(text);
			});

			this._ws.on('close', (code, reason) => {
				this._logService.trace('CmuxTerminalProcess: WebSocket closed', code, reason.toString());
				this._exitCode = code === 1000 ? 0 : 1;
				this._onProcessExit.fire(this._exitCode);
			});

			this._ws.on('error', (err) => {
				this._logService.error('CmuxTerminalProcess: WebSocket error', err);
				if (this._ws?.readyState !== WebSocket.OPEN) {
					reject(err);
				}
			});
		});
	}

	private _closeWebSocket(): void {
		if (this._ws) {
			this._ws.close();
			this._ws = undefined;
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

		this._closeWebSocket();
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
		if (this._store.isDisposed || !this._ws || this._ws.readyState !== WebSocket.OPEN) {
			return;
		}
		this._logService.trace('CmuxTerminalProcess: input', data.length, 'chars');
		this._ws.send(data);
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
		if (this._store.isDisposed || !this._ws || this._ws.readyState !== WebSocket.OPEN) {
			return;
		}
		this._cols = cols;
		this._rows = rows;
		this._logService.trace('CmuxTerminalProcess: resize', cols, rows);

		// Send resize control message
		const controlMsg = JSON.stringify({
			type: 'resize',
			cols,
			rows
		});
		this._ws.send(controlMsg);
	}

	clearBuffer(): void {
		// cmux doesn't have a clear buffer command yet
		this._logService.trace('CmuxTerminalProcess: clearBuffer (no-op)');
	}

	acknowledgeDataEvent(charCount: number): void {
		this._unacknowledgedCharCount = Math.max(this._unacknowledgedCharCount - charCount, 0);
		this._logService.trace(`CmuxTerminalProcess: Flow control ack ${charCount} chars (unacknowledged: ${this._unacknowledgedCharCount})`);
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
