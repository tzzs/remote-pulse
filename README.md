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
| Always-on footprint | CPU\|MEM\|DISK all shown flat | Just 1 icon + 1 core number by default; everything else lives in the trend panel |
| Visual tone | Value-driven coloring at all times | CPU and memory each colored on a green/yellow/red scale, independently of each other — the same visual language as VS Code's own remote-connection indicator |
| Interaction | Some require opening a sidebar | Click to pop a lightweight Webview — no persistent space used, no trace left after closing |
| Resource cost | Some poll via spawned subprocesses | Reads `/proc` directly; zero steady-state subprocess overhead for core metrics |
| Context awareness | Polls at the same rate whether focused or not | Automatically throttles when the window loses focus |

## Preview

```
$(pulse) CPU 23%  MEM 61%                        ← all normal
$(pulse) CPU 85%  MEM 40%                        ← CPU alone crosses warning, turns yellow — memory stays default
$(warning) CPU 28%  MEM 97%  GPU 12%  $(arrow-down) 240 KB/s $(arrow-up) 30 KB/s ← memory alone goes critical, turns red — the icon follows the worst of what's shown
```

CPU, memory, GPU (primary GPU only) and network are up to four independently colored status bar items — pick which ones appear via `remotePulse.statusBarMetrics` (CPU/memory are on by default). Network shows download and upload separately with `$(arrow-down)`/`$(arrow-up)` icons rather than one combined number, since a single figure can't tell you which direction is actually busy. A shared alert icon reflects the worst level among the ones you've enabled — network is display-only and never colors it, since throughput has no natural 0-100% scale — using VS Code's own `statusBarItem.warning*`/`error*` theme colors, so it stays legible no matter what the status bar's actual background happens to be (e.g. Remote-SSH recoloring the whole bar).

Click the CPU/memory/GPU/network items — or run `Remote Pulse: Show Trend Chart` — to open a line chart of the last 30 minutes of history, plus disk/network/GPU/Docker detail (a Webview that's destroyed on close — nothing stays resident in memory). The alert icon itself instead jumps straight to a multi-select picker for `statusBarMetrics` — VS Code's Settings UI can only render array settings as a list editor, not real checkboxes, so this command (and its `trendPanelSections`/`trendChartMetrics` counterparts, all reachable from the panel's gear icon) is the actual "check all that apply" experience.

Three settings share the same four candidate metrics (`cpu`/`memory`/`gpu`/`network`, plus `docker` for the panel) but are independent on purpose: `statusBarMetrics` picks the status bar summary, `trendPanelSections` picks which detail sections/rows show in the panel body (GPU cards, Docker table, the network row in "System"), and `trendChartMetrics` picks which lines get plotted in the 30-minute chart specifically — so you can, say, keep the GPU detail card visible in the panel without cluttering the chart with a GPU line, or vice versa.

## Features

- **CPU**: overall usage and core count (delta-based `/proc/stat` calculation, not loadavg), plus 1/5/15-minute load average scaled by core count
- **Memory**: usage percentage and used/total (uses `MemAvailable` rather than `MemFree`, which better reflects what's actually available); swap usage appears automatically when the host has swap configured
- **Container-aware**: inside a Dev Container / Codespace, CPU and memory are measured against the cgroup quota (v1 and v2) instead of the host's `/proc` values, and labeled `cgroup limit` so you know which denominator you're looking at (`remotePulse.cgroupAware`)
- **Disk**: per-mount-point usage computed exactly like `df` (root-reserved blocks are not counted as used; virtual filesystems are filtered out; bind mounts of the same disk are collapsed to the shallower path; sorted by usage). Optional read/write throughput from `/proc/diskstats`, counting whole devices only so partitions aren't double-counted
- **Network**: download/upload rate, always shown as two separate numbers. Virtual interfaces (`docker0`, `veth*`, `br-*`, `tun*`, …) are excluded by default because their traffic is container-internal or double-counted; pin specific interfaces with `remotePulse.networkInterfaces`
- **GPU**: VRAM usage, utilization, temperature (requires `nvidia-smi`). On multi-GPU hosts, choose whether the status bar and chart follow GPU 0 or the busiest GPU (`remotePulse.gpuSelection`). Temperature has its own °C thresholds
- **Top processes**: optional table of the busiest processes by CPU, with CPU% on the same scale as the overall CPU row
- **Docker**: running container count plus per-container CPU/memory, with bounded concurrency and a container cap so large hosts don't hammer the daemon
- **Hover details**: every status bar item shows a tooltip with the host, sparklines for the last 5 minutes, and every collected metric
- **Threshold alerts**: CPU and memory each turn yellow/red independently; optional notifications for CPU/memory/disk/GPU (`remotePulse.notificationMetrics`) that fire once per crossing and offer *View trend chart* / *Mute for 1 hour*
- **History trend**: a Webview line chart with a configurable window (`remotePulse.trendWindowMinutes`); screen readers get region landmarks, progress-bar semantics and a text description of the chart
- **Adaptive polling**: throttles once the window loses focus; slow-changing metrics (disk, GPU, Docker, processes) live on their own slower loop
- **Diagnosable**: collection failures stay silent in the UI but are recorded in the `Remote Pulse` output channel (`Remote Pulse: Show Logs`)
- **Localized UI**: commands, settings, and the status bar/webview text follow VS Code's display language (English by default, with a 简体中文 translation)

## Installation

Search for **Remote Pulse** in the VS Code Extensions view, or install directly from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=tanzz.remote-pulse) or the [Open VSX Registry](https://open-vsx.org/extension/tanzz/remote-pulse) (e.g. for VSCodium and other Open VSX-based editors).

Alternatively, download the `.vsix` file from [Releases](../../releases), then in VS Code run:

```
Extensions: Install from VSIX...
```

Or install from the command line:

```bash
code --install-extension remote-pulse-<version>.vsix
```

Once installed, connect to a Linux remote host over Remote-SSH and the metrics will show up in the status bar (the extension declares `extensionKind: workspace`, so it automatically runs on the remote extension host — no extra setup required).

## Configuration

| Setting | Default | Description |
|---|---|---|
| `remotePulse.refreshInterval` | `2000` | Refresh interval for high-frequency foreground metrics (CPU/memory/network), in ms |
| `remotePulse.backgroundInterval` | `15000` | Throttled refresh interval once the window loses focus, in ms |
| `remotePulse.heavyMetricInterval` | `10000` | Polling interval for low-frequency metrics (disk, GPU, Docker, processes), in ms |
| `remotePulse.warningThreshold` | `80` | Warning threshold (%). Swapped with the critical threshold if set higher than it |
| `remotePulse.criticalThreshold` | `95` | Critical threshold (%) |
| `remotePulse.gpuTempWarningThreshold` | `80` | GPU temperature warning threshold (°C) |
| `remotePulse.gpuTempCriticalThreshold` | `90` | GPU temperature critical threshold (°C) |
| `remotePulse.statusBarMetrics` | `["cpu", "memory"]` | Status bar items — `cpu`, `memory`, `gpu`, `network`. Run `Remote Pulse: Configure Status Bar Metrics` for a multi-select picker |
| `remotePulse.statusBarAlignment` | `"left"` | `left` (next to the remote indicator) or `right` |
| `remotePulse.trendPanelSections` | `["gpu", "docker"]` | Optional panel sections — `network`, `diskIo`, `gpu`, `processes`, `docker`. System and Storage are always shown. Independent of the chart |
| `remotePulse.trendChartMetrics` | `["cpu", "memory"]` | Lines in the trend chart — `cpu`, `memory`, `gpu`, `network` (download/upload on their own right-hand axis) |
| `remotePulse.trendWindowMinutes` | `30` | How much history the chart covers (1–240). History memory scales with this and the refresh interval |
| `remotePulse.enableNotifications` | `false` | Show a notification when a critical threshold is crossed |
| `remotePulse.notificationMetrics` | `["cpu", "memory", "disk"]` | Which metrics may raise that notification — `cpu`, `memory`, `disk`, `gpu` |
| `remotePulse.diskMountPoints` | `[]` | Mount points to monitor; empty = every real mount point, sorted by usage |
| `remotePulse.networkInterfaces` | `[]` | Interfaces to measure; empty = every physical interface (virtual ones excluded) |
| `remotePulse.gpuSelection` | `"primary"` | Which GPU the status bar and chart follow on multi-GPU hosts — `primary` or `busiest` |
| `remotePulse.topProcessCount` | `5` | Rows in the Top Processes section |
| `remotePulse.dockerMaxContainers` | `20` | Containers to fetch per-container stats for; the rest only count toward the total |
| `remotePulse.cgroupAware` | `true` | Measure CPU/memory against the container's cgroup quota when one exists |

## Commands

Commands only appear in the Command Palette inside a remote window, where the extension is actually monitoring.

- `Remote Pulse: Show Trend Chart` (`remotePulse.showTrend`, also bound to clicking the CPU/memory/GPU/network status bar items)
- `Remote Pulse: Refresh Now` (`remotePulse.refresh`)
- `Remote Pulse: Show Logs` (`remotePulse.showLogs`)
- `Remote Pulse: Configure Status Bar Metrics` (`remotePulse.configureStatusBarMetrics`, also bound to clicking the alert icon)
- `Remote Pulse: Configure Trend Panel Sections` (`remotePulse.configureTrendPanelSections`)
- `Remote Pulse: Configure Trend Chart Metrics` (`remotePulse.configureTrendChartMetrics`)
- `Remote Pulse: Configure Notification Metrics` (`remotePulse.configureNotificationMetrics`)

## Edge Cases

- **Non-Linux remote hosts**: CPU/memory automatically fall back to Node.js's `os` module (slightly less precise); network, disk I/O and process modules are hidden since there's no cross-platform equivalent
- **First connection**: the status bar initially shows a `$(sync~spin)` loading state, with a tooltip explaining it
- **Partial failure**: each collector is settled independently — one failing metric keeps its last value for a few rounds and is then cleared, without taking the others down
- **Total failure**: shows `$(circle-slash)`; the reason is in its tooltip and in the output channel, with no intrusive notification
- **Hung network mounts**: each `statfs` call times out after 2 s, so a dead NFS/CIFS mount can't stall the extension host
- **GPU/Docker unavailable**: re-probed every 5 minutes, so starting the Docker daemon or installing the driver is picked up without reloading the window

## Development

```bash
npm install
npm run build     # compile with tsc into out/
npm test          # build, then run the unit tests under test/ (node:test)
npm run lint      # ESLint over src/, test/ and the webview scripts in media/
npm run test:integration  # runs test/integration/ in a real VS Code extension host (@vscode/test-cli)
npm run package   # vsce package to produce a .vsix
```

If the integration host fails to start with `listen EINVAL … .sock` (common inside git worktrees or deeply nested checkouts — Unix socket paths are capped at 103 characters), point it at a short user-data directory:

```bash
VSCODE_TEST_USER_DATA_DIR=/tmp/rp-ud npm run test:integration
```

The trend panel's stylesheet and scripts live in `media/` as real files; `media/chart.js` holds the chart math and is unit-tested directly from `test/chart.test.mjs`.

Open this project in VS Code and press `F5` to launch an Extension Development Host for live debugging (locally on macOS/Windows, CPU/memory fall back to the `os` module path, so you can verify the core interactions even without a remote Linux host).

## Contributing

The CI/release pipeline (GitHub Actions workflows, grabbing a PR's test build) and the one-time repository secrets setup needed for automatic publishing are documented in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
