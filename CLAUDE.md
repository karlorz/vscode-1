# VSCode Fork

## Patch Workflow

All source changes via patches only.

```bash
# Make changes, then:
./scripts/update-patch.sh <name> [files]   # Create/update patch
./scripts/unapply-patches.sh                # Revert before commit
git add patches/ && git commit              # Commit patch files
./scripts/apply-patches.sh                  # Re-apply for testing
```

## Testing

```bash
./scripts/apply-patches.sh
./scripts/code-server.sh --user-data-dir .vscode-test-web --without-connection-token --port 8080
```

## Hidden serve-web Flags

`--disable-workspace-trust`, `--disable-telemetry`, `--default-folder`, `--default-workspace`, `--enable-sync`
