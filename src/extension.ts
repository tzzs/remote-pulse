import * as vscode from 'vscode';
import * as os from 'os';
import { CpuCollector } from './collectors/cpu';
import { MemoryCollector } from './collectors/memory';
import { DiskCollector } from './collectors/disk';
import { NetworkCollector } from './collectors/network';
import { GpuCollector } from './collectors/gpu';
import { DockerCollector } from './collectors/docker';
import { StatsStore } from './store/statsStore';
import { Poller } from './scheduler';
import { PulseStatusBar } from './statusBar';
import { readConfig, isRemotePulseConfigChange } from './config';
import { CollectionState, Snapshot } from './types';
import { TrendPanel, TrendSeries } from './webview/trendPanel';

const TREND_WINDOW_MS = 30 * 60 * 1000;

export function activate(context: vscode.ExtensionContext): void {
  const statusBar = new PulseStatusBar();
  const store = new StatsStore();

  const cpuCollector = new CpuCollector();
  const memoryCollector = new MemoryCollector();
  let config = readConfig();
  const diskCollector = new DiskCollector(() => config.diskMountPoints);
  const networkCollector = new NetworkCollector();
  const gpuCollector = new GpuCollector();
  const dockerCollector = new DockerCollector();

  const hostLabel = resolveHostLabel();

  let state: CollectionState = 'loading';
  let lastWasCritical = false;

  const light: Pick<Snapshot, 'cpu' | 'memory' | 'disks' | 'network'> = {};
  const heavy: Pick<Snapshot, 'gpus' | 'docker'> = {};

  function renderAndStore(): void {
    const snapshot: Snapshot = {
      timestamp: Date.now(),
      cpu: light.cpu,
      memory: light.memory,
      disks: light.disks,
      network: light.network,
      gpus: heavy.gpus,
      docker: heavy.docker,
      uptimeSeconds: safeUptime(),
    };
    store.push(snapshot);

    const sparklines = {
      cpu: store.recentValues(TREND_WINDOW_MS, s => s.cpu?.percent),
      memory: store.recentValues(TREND_WINDOW_MS, s => s.memory?.percent),
    };
    statusBar.update(hostLabel, snapshot, config, state, sparklines);
    maybeNotifyCritical(snapshot);
    if (TrendPanel.isOpen()) {
      TrendPanel.refreshIfOpen(hostLabel, buildTrendSeries(store));
    }
  }

  function maybeNotifyCritical(snapshot: Snapshot): void {
    if (!config.enableNotifications) {
      return;
    }
    const percent = config.statusBarMetric === 'memory' ? snapshot.memory?.percent : snapshot.cpu?.percent;
    if (percent === undefined) {
      return;
    }
    const isCritical = percent >= config.criticalThreshold;
    // 只在"跨越"到严重态的那一刻通知一次,而不是每轮轮询都弹窗,避免持续过载时通知刷屏。
    // 恢复到阈值以下后重新越界会再次触发,保证用户始终能看到最新一次告警。
    if (isCritical && !lastWasCritical) {
      const metricLabel = config.statusBarMetric === 'memory' ? vscode.l10n.t('Memory') : 'CPU';
      void vscode.window.showWarningMessage(
        `Remote Pulse: ${vscode.l10n.t('{0} usage on {1} has reached {2}%', metricLabel, hostLabel, Math.round(percent))}`,
      );
    }
    lastWasCritical = isCritical;
  }

  async function collectLight(): Promise<void> {
    try {
      const [cpu, memory, disks] = await Promise.all([
        cpuCollector.collect(),
        memoryCollector.collect(),
        diskCollector.collect(),
      ]);
      light.cpu = cpu;
      light.memory = memory;
      light.disks = disks;
      light.network = config.enableNetwork ? await networkCollector.collect() : undefined;
      if (cpu) {
        state = 'ok';
      }
      renderAndStore();
    } catch (err) {
      state = 'error';
      statusBar.showError(err instanceof Error ? err.message : String(err));
    }
  }

  async function collectHeavy(): Promise<void> {
    heavy.gpus = config.enableGpu ? await gpuCollector.collect() : undefined;
    heavy.docker = config.enableDocker ? await dockerCollector.collect() : undefined;
  }

  const lightPoller = new Poller(collectLight, config.refreshInterval);
  const heavyPoller = new Poller(collectHeavy, config.heavyMetricInterval);
  lightPoller.start();
  heavyPoller.start();

  function applyIntervalsForFocus(focused: boolean): void {
    lightPoller.setInterval(focused ? config.refreshInterval : config.backgroundInterval);
    heavyPoller.setInterval(focused ? config.heavyMetricInterval : config.backgroundInterval * 2);
  }

  const focusListener = vscode.window.onDidChangeWindowState(winState => applyIntervalsForFocus(winState.focused));

  const configListener = vscode.workspace.onDidChangeConfiguration(e => {
    if (!isRemotePulseConfigChange(e)) {
      return;
    }
    config = readConfig();
    applyIntervalsForFocus(vscode.window.state.focused);
  });

  const showTrendCommand = vscode.commands.registerCommand('remotePulse.showTrend', () => {
    TrendPanel.createOrShow(hostLabel, buildTrendSeries(store));
  });

  const refreshCommand = vscode.commands.registerCommand('remotePulse.refresh', async () => {
    await Promise.all([lightPoller.runNow(), heavyPoller.runNow()]);
  });

  context.subscriptions.push(
    statusBar,
    focusListener,
    configListener,
    showTrendCommand,
    refreshCommand,
    lightPoller,
    heavyPoller,
  );
}

export function deactivate(): void {
  // 全部资源已注册到 context.subscriptions,由 VSCode 在停用时统一释放。
}

/** 主机名/网络接口探测理论上也可能在受限环境下失败,activate() 不应因此整体崩溃。 */
function resolveHostLabel(): string {
  try {
    const hostname = os.hostname();
    const ip = findNonInternalIPv4();
    return ip ? `${hostname} (${ip})` : hostname;
  } catch {
    return vscode.l10n.t('Remote host');
  }
}

/** 极少数受限沙箱/容器环境会拦截 uv_uptime 系统调用,uptime 展示是锦上添花而非核心指标,失败时不应连累已采集成功的 CPU/内存数据。 */
function safeUptime(): number | undefined {
  try {
    return os.uptime();
  } catch {
    return undefined;
  }
}

function findNonInternalIPv4(): string | undefined {
  try {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name] ?? []) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function buildTrendSeries(store: StatsStore): TrendSeries {
  const history = store.getHistory();
  const cutoff = Date.now() - TREND_WINDOW_MS;
  const windowed = history.filter(s => s.timestamp >= cutoff);
  return {
    timestamps: windowed.map(s => s.timestamp),
    cpu: windowed.map(s => s.cpu?.percent ?? 0),
    memory: windowed.map(s => s.memory?.percent ?? 0),
  };
}
