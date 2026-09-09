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
import { readConfig, isRemotePulseConfigChange, RemotePulseConfig, configureStatusBarMetrics, configureTrendPanelSections } from './config';
import { CollectionState, Snapshot } from './types';
import { HostInfo, TrendPanel, TrendPayload } from './webview/trendPanel';
import { formatHostLabel } from './util/hostLabel';

const TREND_WINDOW_MS = 30 * 60 * 1000;

/** 本地(非远程)窗口里没有"远程主机"可言,不应该出现状态栏/占用轮询资源。 */
export function activate(context: vscode.ExtensionContext): { monitoring: boolean } {
  if (!vscode.env.remoteName) {
    return { monitoring: false };
  }

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
  const host: HostInfo = { label: hostLabel, user: safeUserName(), addresses: listIPv4Addresses() };

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

    statusBar.update(snapshot, config, state);
    maybeNotifyCritical(snapshot);
    if (TrendPanel.isOpen()) {
      TrendPanel.refreshIfOpen(host, buildTrendPayload(store, config));
    }
  }

  function maybeNotifyCritical(snapshot: Snapshot): void {
    if (!config.enableNotifications) {
      return;
    }
    const cpuPercent = snapshot.cpu?.percent;
    const memPercent = snapshot.memory?.percent;
    const criticalParts: string[] = [];
    if (cpuPercent !== undefined && cpuPercent >= config.criticalThreshold) {
      criticalParts.push(`CPU ${Math.round(cpuPercent)}%`);
    }
    if (memPercent !== undefined && memPercent >= config.criticalThreshold) {
      criticalParts.push(`${vscode.l10n.t('Memory')} ${Math.round(memPercent)}%`);
    }
    const isCritical = criticalParts.length > 0;
    // 只在"跨越"到严重态的那一刻通知一次,而不是每轮轮询都弹窗,避免持续过载时通知刷屏。
    // 恢复到阈值以下后重新越界会再次触发,保证用户始终能看到最新一次告警。
    if (isCritical && !lastWasCritical) {
      void vscode.window.showWarningMessage(
        `Remote Pulse: ${vscode.l10n.t('{0} on {1} has reached the critical threshold', criticalParts.join(', '), hostLabel)}`,
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
      // 网络既可能只在趋势面板里展示,也可能只在状态栏里展示(或者两处都要)——只要任意一处需要就得采集。
      const needsNetwork = config.trendPanelSections.includes('network') || config.statusBarMetrics.includes('network');
      light.network = needsNetwork ? await networkCollector.collect() : undefined;
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
    // 同理,GPU 数据可能只喂状态栏(取第一张卡做摘要),也可能只喂趋势面板(逐卡详情)。
    const needsGpu = config.trendPanelSections.includes('gpu') || config.statusBarMetrics.includes('gpu');
    heavy.gpus = needsGpu ? await gpuCollector.collect() : undefined;
    heavy.docker = config.trendPanelSections.includes('docker') ? await dockerCollector.collect() : undefined;
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
    TrendPanel.createOrShow(host, buildTrendPayload(store, config));
  });

  const refreshCommand = vscode.commands.registerCommand('remotePulse.refresh', async () => {
    await Promise.all([lightPoller.runNow(), heavyPoller.runNow()]);
  });

  const configureStatusBarMetricsCommand = vscode.commands.registerCommand(
    'remotePulse.configureStatusBarMetrics',
    configureStatusBarMetrics,
  );
  const configureTrendPanelSectionsCommand = vscode.commands.registerCommand(
    'remotePulse.configureTrendPanelSections',
    configureTrendPanelSections,
  );

  context.subscriptions.push(
    statusBar,
    focusListener,
    configListener,
    showTrendCommand,
    refreshCommand,
    configureStatusBarMetricsCommand,
    configureTrendPanelSectionsCommand,
    lightPoller,
    heavyPoller,
  );

  return { monitoring: true };
}

export function deactivate(): void {
  // 全部资源已注册到 context.subscriptions,由 VSCode 在停用时统一释放。
}

/** 主机名/网络接口探测理论上也可能在受限环境下失败,activate() 不应因此整体崩溃。 */
function resolveHostLabel(): string {
  try {
    const hostname = os.hostname();
    const ip = findNonInternalIPv4();
    // WSL 里 os.hostname() 读到的是发行版自己的主机名(很多发行版默认沿用/继承 Windows 主机名),
    // 标出 WSL_DISTRO_NAME 能让用户一眼确认这确实是 WSL 侧数据,而不是误连到了外层 Windows。
    return formatHostLabel(hostname, ip, process.env.WSL_DISTRO_NAME);
  } catch {
    return vscode.l10n.t('Remote host');
  }
}

/** 无 /etc/passwd 条目的容器里 os.userInfo() 会抛错;用户名只是身份标注,取不到就不显示。 */
function safeUserName(): string | undefined {
  try {
    return os.userInfo().username || undefined;
  } catch {
    return undefined;
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

/** 多网卡机器上"第一个"地址是任意的,所以全部列出;超过 4 张网卡就不再是有用信息了。 */
const MAX_SHOWN_INTERFACES = 4;

function listIPv4Addresses(): { iface: string; address: string }[] {
  try {
    const interfaces = os.networkInterfaces();
    const found: { iface: string; address: string }[] = [];
    for (const name of Object.keys(interfaces)) {
      for (const entry of interfaces[name] ?? []) {
        if (entry.family === 'IPv4' && !entry.internal) {
          found.push({ iface: name, address: entry.address });
        }
      }
    }
    return found.slice(0, MAX_SHOWN_INTERFACES);
  } catch {
    return [];
  }
}

function findNonInternalIPv4(): string | undefined {
  return listIPv4Addresses()[0]?.address;
}

function buildTrendPayload(store: StatsStore, config: RemotePulseConfig): TrendPayload {
  const history = store.getHistory();
  const cutoff = Date.now() - TREND_WINDOW_MS;
  const windowed = history.filter(s => s.timestamp >= cutoff);
  const latestSnapshot = store.latest();
  const showNetwork = config.trendPanelSections.includes('network');
  // rx+tx 之和,原始 B/s——不做归一化,趋势面板画在自己独立的右侧 y 轴上,
  // 不用挤进 CPU/内存共用的 0-100% 左轴。
  const network = showNetwork ? windowed.map(s => (s.network ? s.network.rxRate + s.network.txRate : 0)) : undefined;

  return {
    series: {
      timestamps: windowed.map(s => s.timestamp),
      cpu: windowed.map(s => s.cpu?.percent ?? 0),
      memory: windowed.map(s => s.memory?.percent ?? 0),
      network,
    },
    latest: latestSnapshot && {
      cpu: latestSnapshot.cpu,
      memory: latestSnapshot.memory,
      disks: latestSnapshot.disks ?? [],
      network: showNetwork ? latestSnapshot.network : undefined,
      gpus: config.trendPanelSections.includes('gpu') ? (latestSnapshot.gpus ?? []) : [],
      docker: config.trendPanelSections.includes('docker') ? latestSnapshot.docker : undefined,
      uptimeSeconds: latestSnapshot.uptimeSeconds,
    },
    thresholds: { warning: config.warningThreshold, critical: config.criticalThreshold },
  };
}
