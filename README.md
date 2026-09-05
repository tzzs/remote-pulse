# Remote Pulse

**English** | [简体中文](README.zh-CN.md)

<p align="center">
  <img src="images/icon.png" width="96" height="96" alt="Remote Pulse icon" />
</p>

Continuously track your Remote-SSH host's CPU / memory / disk / network / GPU / Docker status — as quiet yet always-at-a-glance as VS Code's native latency indicator — without breaking your coding flow.

## Why Remote Pulse

Most similar extensions just move a full dashboard into the status bar: dense, and permanently on display. Remote Pulse takes a different approach:

| Aspect | Common approach elsewhere | Remote Pulse |
|---|---|---|
| Always-on footprint | CPU\|MEM\|DISK all shown flat | Just 1 icon + 1 core number by default; everything else lives in the tooltip |
| Visual tone | Value-driven coloring at all times | Neutral by default; only colors up when a threshold is crossed |
| Interaction | Some require opening a sidebar | Click to pop a lightweight Webview — no persistent space used, no trace left after closing |
| Resource cost | Some poll via spawned subprocesses | Reads `/proc` directly; zero steady-state subprocess overhead for core metrics |
| Context awareness | Polls at the same rate whether focused or not | Automatically throttles when the window loses focus |

## Preview

```
Default: $(pulse) 23%
Alert:   $(warning) 92%   ← status bar background turns warning/critical color
```

Hover to expand the tooltip:

```
Remote host: dev-gpu-01 (192.168.x.x)
─────────────────────
CPU     ▁▃▅▇▆▄▂  23%  (8 cores)
Memory  ▂▂▃▄▄▃▂  61%  (9.8G / 16G)
Uptime  12d 4h
─────────────────────
Click to view the trend chart
```

Click the status bar item to open a line chart of the last 30 minutes of CPU/memory history (a Webview that's destroyed on close — nothing stays resident in memory).

## Features

- **CPU**: overall usage and core count (delta-based `/proc/stat` calculation, not loadavg)
- **Memory**: usage percentage and used/total (uses `MemAvailable` rather than `MemFree`, which better reflects what's actually available)
- **Disk**: per-mount-point usage (virtual filesystems are filtered out automatically; shows the top 3 by usage by default, or specify mount points manually)
- **Network**: upload/download rate (disabled by default to keep the tooltip uncluttered)
- **GPU**: VRAM usage, utilization, temperature (requires `nvidia-smi`; the module simply stays inactive if it's unavailable)
- **Docker**: running container count plus per-container CPU/memory usage (requires access to `/var/run/docker.sock`; degrades silently without permission)
- **Threshold alerts**: the status bar changes color when CPU/memory crosses a threshold, with an optional system notification (fires once per crossing into the critical state, so it won't spam you)
- **History trend**: a tooltip sparkline plus a Webview line chart on click
- **Adaptive polling**: automatically throttles once the window loses focus, reducing load on the remote machine
- **Localized UI**: commands, settings, and the status bar/webview text follow VS Code's display language (English by default, with a 简体中文 translation)

## Installation

Download the `.vsix` file from [Releases](../../releases), then in VS Code run:

```
Extensions: Install from VSIX...
```

Or install from the command line:

```bash
code --install-extension remote-pulse-0.1.0.vsix
```

Once installed, connect to a Linux remote host over Remote-SSH and the metrics will show up in the status bar (the extension declares `extensionKind: workspace`, so it automatically runs on the remote extension host — no extra setup required).

## Configuration

| Setting | Default | Description |
|---|---|---|
| `remotePulse.refreshInterval` | `2000` | Refresh interval for high-frequency foreground metrics (CPU/memory), in ms |
| `remotePulse.backgroundInterval` | `15000` | Throttled refresh interval once the window loses focus, in ms |
| `remotePulse.heavyMetricInterval` | `10000` | Independent polling interval for low-frequency metrics like GPU/Docker, in ms |
| `remotePulse.statusBarMetric` | `cpu` | Primary metric shown in the status bar: `cpu` \| `memory` |
| `remotePulse.warningThreshold` | `80` | Warning threshold (%) |
| `remotePulse.criticalThreshold` | `95` | Critical threshold (%) |
| `remotePulse.template` | `"$(pulse) ${value}%"` | Status bar display template |
| `remotePulse.enableGpu` | `true` | Whether to detect and show GPU info |
| `remotePulse.enableDocker` | `true` | Whether to detect and show Docker container info |
| `remotePulse.enableNetwork` | `false` | Whether to show network upload/download rate |
| `remotePulse.enableNotifications` | `false` | Whether to show a system notification when the critical threshold is crossed |
| `remotePulse.diskMountPoints` | `[]` | Mount points to monitor; leave empty to auto-select the top 3 by usage |

## Commands

- `Remote Pulse: Show Trend Chart` (`remotePulse.showTrend`, also bound to clicking the status bar item)
- `Remote Pulse: Refresh Now` (`remotePulse.refresh`)

## Edge Cases

- **Non-Linux remote hosts**: CPU/memory automatically fall back to Node.js's `os` module (slightly less precise); the network module is hidden entirely since there's no cross-platform equivalent
- **First connection**: the status bar initially shows a `$(sync~spin)` loading state
- **Collection failure** (permissions / network flakiness): shows `$(circle-slash)`, with the reason explained in the tooltip — no intrusive error notifications
- **GPU/Docker unavailable**: probed once at startup; if missing or unauthorized, the module simply stays inactive rather than retrying repeatedly

## Development

```bash
npm install
npm run build     # compile with tsc into out/
npm test          # build, then run the unit tests under test/ (node:test)
npm run package   # vsce package to produce a .vsix
```

Open this project in VS Code and press `F5` to launch an Extension Development Host for live debugging (locally on macOS/Windows, CPU/memory fall back to the `os` module path, so you can verify the core interactions even without a remote Linux host).

## CI / Release Pipeline

The repository has three workflows configured (`.github/workflows/`):

| Workflow | Trigger | Purpose |
|---|---|---|
| `ci.yml` | Every push/PR to `main` | `npm ci` → build → unit tests → `vsce package` smoke check |
| `release-please.yml` | Push to `main` | Maintains a "Release PR" automatically based on [Conventional Commits](https://www.conventionalcommits.org/) messages (bumps the `package.json` version + `CHANGELOG.md`); merging it automatically tags a version and creates a GitHub Release |
| `publish.yml` | A GitHub Release is published (`release: published`) | Build → test → package the `.vsix` → attach it to the Release → publish to the VS Code Marketplace (`vsce publish`) and Open VSX (`ovsx publish`) |

In short, the full pipeline is: **everyday commits follow Conventional Commits (`feat: xxx` / `fix: xxx` / `chore: xxx`, …) → release-please opens a version PR → merging it cuts a GitHub Release automatically → that automatically pushes to both marketplaces**.

### One-Time Manual Setup (Repository Secrets)

Before automatic publishing to both marketplaces can work, a few things need to be done manually, once:

1. **VS Code Marketplace**: register a publisher at [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage) (make sure it matches `"publisher": "tanzz"` in `package.json`, or update that field to your actual publisher id), then generate a PAT in Azure DevOps with **Marketplace (Manage)** scope.
2. **Open VSX**: sign in at [open-vsx.org](https://open-vsx.org) with an Eclipse account, claim a namespace matching the publisher name (`npx ovsx create-namespace tanzz -p <token>`, or do it via the web UI), then generate an access token.
3. Add both tokens to the repository Secrets (run this in your own terminal — don't paste tokens into chat):
   ```bash
   gh secret set VSCE_PAT --repo tzzs/remote-pulse
   gh secret set OVSX_PAT --repo tzzs/remote-pulse
   ```

Until both secrets are configured, `publish.yml` will fail at the Marketplace/Open VSX publish steps (the rest — build, test, package, and uploading the `.vsix` to the Release — is unaffected). That's expected.

## License

[MIT](LICENSE)
