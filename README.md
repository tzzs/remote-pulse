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

- **CPU**: overall usage and core count (delta-based `/proc/stat` calculation, not loadavg)
- **Memory**: usage percentage and used/total (uses `MemAvailable` rather than `MemFree`, which better reflects what's actually available)
- **Disk**: per-mount-point usage (virtual filesystems are filtered out automatically, and mount points that report byte-identical total/used space — the same underlying disk bind-mounted at more than one path, e.g. WSL2's `/mnt/wslg/distro` mirroring `/` — are collapsed to whichever path is shallower; shows every remaining real mount point by default, sorted by usage so the fullest one leads, or specify mount points manually to show only those)
- **Network**: download/upload rate, always shown as two separate numbers (status bar icons, chart lines, or arrows) rather than a combined figure — merging them hides which direction is actually busy; optionally plotted as two lines in the 30-minute chart sharing their own right-hand axis, scaled to the window's own peak since throughput has no natural 0-100% scale like CPU/memory (off by default via `trendChartMetrics`, independent of whether the rate is shown as a detail row)
- **GPU**: VRAM usage, utilization, temperature (requires `nvidia-smi`; the module simply stays inactive if it's unavailable)
- **Docker**: running container count plus per-container CPU/memory usage (requires access to `/var/run/docker.sock`; degrades silently without permission)
- **Threshold alerts**: CPU and memory each turn green/yellow/red independently as they cross the warning/critical thresholds, with an optional system notification (fires once per crossing into the critical state, so it won't spam you)
- **History trend**: a Webview line chart of the last 30 minutes
- **Adaptive polling**: automatically throttles once the window loses focus, reducing load on the remote machine
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
| `remotePulse.refreshInterval` | `2000` | Refresh interval for high-frequency foreground metrics (CPU/memory), in ms |
| `remotePulse.backgroundInterval` | `15000` | Throttled refresh interval once the window loses focus, in ms |
| `remotePulse.heavyMetricInterval` | `10000` | Independent polling interval for low-frequency metrics like GPU/Docker, in ms |
| `remotePulse.warningThreshold` | `80` | Warning threshold (%) |
| `remotePulse.criticalThreshold` | `95` | Critical threshold (%) |
| `remotePulse.statusBarMetrics` | `["cpu", "memory"]` | Which metrics to show as status bar items — `cpu`, `memory`, `gpu` (primary GPU only), `network` (download/upload shown separately with arrow icons); unselected metrics still appear in the trend panel. Run `Remote Pulse: Configure Status Bar Metrics` for a real multi-select picker |
| `remotePulse.trendPanelSections` | `["gpu", "docker"]` | Which optional sections/rows to show in the trend panel body (GPU cards, Docker table, the network row in "System"); System and Storage are always shown. Independent of `trendChartMetrics` — this doesn't affect the chart. Run `Remote Pulse: Configure Trend Panel Sections` for a real multi-select picker |
| `remotePulse.trendChartMetrics` | `["cpu", "memory"]` | Which metrics to plot as lines in the trend panel's 30-minute chart — `cpu`, `memory`, `gpu` (primary GPU only), `network` (download and upload as two separate lines sharing their own right-hand axis). Independent of `trendPanelSections` and `statusBarMetrics`. Run `Remote Pulse: Configure Trend Chart Metrics` for a real multi-select picker |
| `remotePulse.enableNotifications` | `false` | Whether to show a system notification when the critical threshold is crossed |
| `remotePulse.diskMountPoints` | `[]` | Mount points to monitor; leave empty to show every real mount point, sorted by usage |

## Commands

- `Remote Pulse: Show Trend Chart` (`remotePulse.showTrend`, also bound to clicking the CPU/memory/GPU/network status bar items)
- `Remote Pulse: Refresh Now` (`remotePulse.refresh`)
- `Remote Pulse: Configure Status Bar Metrics` (`remotePulse.configureStatusBarMetrics`, also bound to clicking the alert icon)
- `Remote Pulse: Configure Trend Panel Sections` (`remotePulse.configureTrendPanelSections`)
- `Remote Pulse: Configure Trend Chart Metrics` (`remotePulse.configureTrendChartMetrics`)

## Edge Cases

- **Non-Linux remote hosts**: CPU/memory automatically fall back to Node.js's `os` module (slightly less precise); the network module is hidden entirely since there's no cross-platform equivalent
- **First connection**: the status bar initially shows a `$(sync~spin)` loading state
- **Collection failure** (permissions / network flakiness): shows `$(circle-slash)` — no intrusive error notifications
- **GPU/Docker unavailable**: probed once at startup; if missing or unauthorized, the module simply stays inactive rather than retrying repeatedly

## Development

```bash
npm install
npm run build     # compile with tsc into out/
npm test          # build, then run the unit tests under test/ (node:test)
npm run test:integration  # runs test/integration/ in a real VS Code extension host (@vscode/test-cli)
npm run package   # vsce package to produce a .vsix
```

Open this project in VS Code and press `F5` to launch an Extension Development Host for live debugging (locally on macOS/Windows, CPU/memory fall back to the `os` module path, so you can verify the core interactions even without a remote Linux host).

## Contributing

The CI/release pipeline (GitHub Actions workflows, grabbing a PR's test build) and the one-time repository secrets setup needed for automatic publishing are documented in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
