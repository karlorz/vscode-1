# Gitea Actions Workflow for VSCode Server Build & Release

This workflow enables automatic builds and releases on Gitea when mirroring from GitHub.

## Prerequisites

- **Gitea 1.21+** (contains fixes for mirror sync triggering Actions)
- **Gitea Actions enabled** in `app.ini`
- **act_runner** installed and registered

## Setup Guide

### 1. Enable Gitea Actions

Add to your Gitea `app.ini`:

```ini
[actions]
ENABLED = true
DEFAULT_ACTIONS_URL = https://github.com
```

Restart Gitea after changes.

### 2. Install and Register Runner

```bash
# Download act_runner (check for latest version)
wget https://gitea.com/gitea/act_runner/releases/download/v0.2.11/act_runner-0.2.11-linux-amd64
chmod +x act_runner-0.2.11-linux-amd64

# Generate runner config
./act_runner-0.2.11-linux-amd64 generate-config > config.yaml

# Register runner (get token from Gitea: Site Admin → Actions → Runners)
./act_runner-0.2.11-linux-amd64 register \
  --instance https://your-gitea.com \
  --token <runner-registration-token> \
  --name my-runner

# Start runner (use systemd for production)
./act_runner-0.2.11-linux-amd64 daemon --config config.yaml
```

### 3. Create Mirror Repository

1. Go to Gitea → **+** → **New Migration**
2. Select **GitHub** as source
3. Enter: `https://github.com/karlorz/vscode-1.git`
4. Check **This repository will be a mirror**
5. Set **Mirror Interval** (e.g., `10m` for 10 minutes)
6. Click **Migrate Repository**

### 4. Enable Actions on Mirror Repository

1. Go to mirrored repo → **Settings** → **Repository**
2. Scroll to **Advanced Settings**
3. Enable **Actions**
4. Save

### 5. Add Required Secret

1. Go to repo → **Settings** → **Actions** → **Secrets**
2. Add new secret:
   - **Name:** `GITEA_TOKEN`
   - **Value:** Your Gitea personal access token

To create a token:
1. Go to **User Settings** → **Applications**
2. Generate new token with `write:repository` scope

### 6. (Optional) Enable Faster Sync

For faster mirroring (instead of interval):

1. Go to repo → **Settings** → **Repository**
2. Enable **Sync when new commits are pushed**

Or set up a GitHub webhook to trigger Gitea sync.

## How It Works

```
GitHub                          Gitea
──────                          ─────
push tag v1.0.0
       │
       └──────────────────────► Mirror syncs tag
                                       │
                                       ▼
                                Actions triggered
                                (on: push: tags: ['v*'])
                                       │
                                       ▼
                                Build job runs
                                (linux-x64, linux-arm64)
                                       │
                                       ▼
                                Release job runs
                                (creates release + uploads artifacts)
```

## Workflow Triggers

| Event | Trigger |
|-------|---------|
| Push to `main`, `master`, `feat/**` | Build only |
| Push tag `v*` | Build + Release |
| Pull request to `main`, `master` | Build only |

## Artifacts

The workflow produces:

- `vscode-server-linux-x64-web.tar.gz`
- `vscode-server-linux-arm64-web.tar.gz` (requires arm64 runner)

## Enabling ARM64 Builds

1. Set up a self-hosted arm64 runner
2. Edit `build-serve-web.yml`, uncomment the arm64 matrix entry:

```yaml
matrix:
  include:
    - os: ubuntu-latest
      arch: x64
    - os: ubuntu-latest
      arch: arm64
      runs-on: self-hosted-arm64  # your arm64 runner label
```

## Troubleshooting

### Actions not triggering after mirror sync

- Ensure Gitea is **1.21+** (earlier versions had a bug with branch/tag filters)
- Verify Actions is enabled on the repository
- Check runner is online: **Settings** → **Actions** → **Runners**

### Release creation fails

- Verify `GITEA_TOKEN` secret is set correctly
- Token needs `write:repository` scope
- Check Gitea API is accessible from runner

### Build fails with memory errors

- The workflow allocates 8GB swap space
- Ensure runner has sufficient disk space
- Check `NODE_OPTIONS: --max-old-space-size=8192` is set

### Runner not picking up jobs

```bash
# Check runner status
./act_runner-0.2.11-linux-amd64 daemon --config config.yaml

# View logs for errors
journalctl -u act_runner -f  # if using systemd
```

## Reference

- [Gitea Actions Documentation](https://docs.gitea.com/usage/actions/overview)
- [Gitea Mirror Documentation](https://docs.gitea.com/usage/repo-mirror)
- [act_runner Releases](https://gitea.com/gitea/act_runner/releases)
- [Issue #24824 - Mirror sync trigger fix](https://github.com/go-gitea/gitea/issues/24824)
