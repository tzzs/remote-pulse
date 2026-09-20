import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { CpuCollector } from './collectors/cpu';
import { MemoryCollector } from './collectors/memory';
import { DiskCollector } from './collectors/disk';
import { NetworkCollector } from './collectors/network';
import { GpuCollector } from './collectors/gpu';
import { DockerCollector } from './collectors/docker';
import { StatsStore } from './store/statsStore';
import { Poller } from './scheduler';
import { PulseStatusBar } from './statusBar';
import {
  readConfig,
  isRemotePulseConfigChange,
  RemotePulseConfig,
  configureStatusBarMetrics,
  configureTrendPanelSections,
  configureTrendChartMetrics,
  toggleEnabled,
} from './config';
import { CollectionState, CollectorAvailability, Snapshot } from './types';
import { HostInfo, TrendPanel, TrendPayload } from './webview/trendPanel';
import { formatHostLabel } from './util/hostLabel';
import { logErrorOnce, logInfo, showLog, disposeLogChannel } from './logger';

const TREND_WINDOW_MS = 30 * 60 * 1000;
/** 严重阈值通知的"再通知间隔"默认值;期间内同一持续过载不再刷屏。 */
const NOTIFICATION_COOLDOWN_MS = 10 * 60 * 1000;

/** 本地(非远程)窗口里没有"远程主机"可言,不应该出现状态栏/占用轮询资源。 */
export function activate(context: vscode.ExtensionContext): { monitoring: boolean } {
  if (!vscode.env.remoteName) {
    return { monitoring: false };
  }

  const store = new StatsStore();
  const hostLabel = resolveHostLabel();
  const host: HostInfo = { label: hostLabel, user: safeUserName(), addresses: listIPv4Addresses() };
  const statusBar = new PulseStatusBar({
    hostLabel,
    history: (windowMs, pick) => store.recentValues(windowMs, pick),
  });

  const cpuCollector = new CpuCollector();
  const memoryCollector = new MemoryCollector();
  let config = readConfig();
  const diskCollector = new DiskCollector(() => config.diskMountPoints);
  const networkCollector = new NetworkCollector();
  const gpuCollector = new GpuCollector();
  const dockerCollector = new DockerCollector();

  let state: CollectionState = 'loading';
  let lastWasCritical = false;
  let mutedUntil = 0;
  // GPU/Docker 的可用性只重(要起子进程/socket),每轮重采集会拖慢,5 分钟刷新一次就够;
  // 面板空态提示靠它区分"没有这块硬件"和"有,但还没采到"。
  let availability: { gpu?: CollectorAvailability; docker?: CollectorAvailability } = {};
  let availabilityCheckedAt = 0;
  const AVAILABILITY_REFRESH_MS = 5 * 60 * 1000;

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
      TrendPanel.refreshIfOpen(host, buildTrendPayload(store, config, availability));
    }
  }

  function maybeNotifyCritical(snapshot: Snapshot): void {
    if (!config.enableNotifications) {
      return;
    }
    const criticalParts: string[] = [];
    const cpuPercent = snapshot.cpu?.percent;
    const memPercent = snapshot.memory?.percent;
    const fullestDisk = snapshot.disks && snapshot.disks.length > 0
      ? snapshot.disks.reduce((a, b) => (b.percent > a.percent ? b : a))
      : undefined;
    if (cpuPercent !== undefined && cpuPercent >= config.criticalThreshold) {
      criticalParts.push(`CPU ${Math.round(cpuPercent)}%`);
    }
    if (memPercent !== undefined && memPercent >= config.criticalThreshold) {
      criticalParts.push(`${vscode.l10n.t('Memory')} ${Math.round(memPercent)}%`);
    }
    if (fullestDisk && fullestDisk.percent >= config.criticalThreshold) {
      criticalParts.push(`${vscode.l10n.t('Disk')} ${fullestDisk.mountPoint} ${Math.round(fullestDisk.percent)}%`);
    }
    const isCritical = criticalParts.length > 0;
    // 只在"跨越"到严重态的那一刻通知一次,而不是每轮轮询都弹窗,避免持续过载时通知刷屏。
    // 恢复到阈值以下后重新越界会再次触发,保证用户始终能看到最新一次告警。
    // 用户点"10 分钟内不再提示"后,mutedUntil 期间即使再次跨越也不再弹。
    if (isCritical && !lastWasCritical && Date.now() >= mutedUntil) {
      const SHOW_TREND = vscode.l10n.t('Show Trend');
      const MUTE = vscode.l10n.t('Mute for 10 minutes');
      void vscode.window
        .showWarningMessage(
          `Remote Pulse: ${vscode.l10n.t('{0} on {1} has reached the critical threshold', criticalParts.join(', '), hostLabel)}`,
          SHOW_TREND,
          MUTE,
        )
        .then(picked => {
          if (picked === SHOW_TREND) {
            void vscode.commands.executeCommand('remotePulse.showTrend');
          } else if (picked === MUTE) {
            mutedUntil = Date.now() + NOTIFICATION_COOLDOWN_MS;
          }
        });
    }
    lastWasCritical = isCritical;
  }

  async function collectLight(): Promise<void> {
    if (!config.enabled) {
      statusBar.showPaused();
      return;
    }
    try {
      const [cpu, memory, disks] = await Promise.all([
        cpuCollector.collect(),
        memoryCollector.collect(),
        diskCollector.collect(),
      ]);
      light.cpu = cpu;
      light.memory = memory;
      light.disks = disks;
      // 网络数据有三处可能用到它:趋势面板的 System 行、状态栏摘要、趋势图的线——
      // 三个配置项(trendPanelSections/statusBarMetrics/trendChartMetrics)各自独立勾选,
      // 只要任意一处需要就得采集,采集这一步不区分"为了哪个用途"。
      const needsNetwork =
        config.trendPanelSections.includes('network') ||
        config.statusBarMetrics.includes('network') ||
        config.trendChartMetrics.includes('network');
      light.network = needsNetwork ? await networkCollector.collect() : undefined;
      if (cpu || memory) {
        state = 'ok';
      }
      renderAndStore();
    } catch (err) {
      state = 'error';
      logErrorOnce('light collection', err);
      statusBar.showError(err instanceof Error ? err.message : String(err));
    }
  }

  async function collectHeavy(): Promise<void> {
    if (!config.enabled) {
      return;
    }
    // 同理,GPU 数据可能喂状态栏摘要、趋势面板的逐卡详情、趋势图的线,三处独立勾选,任一处需要就采集。
    const needsGpu =
      config.trendPanelSections.includes('gpu') ||
      config.statusBarMetrics.includes('gpu') ||
      config.trendChartMetrics.includes('gpu');
    const needsDocker = config.trendPanelSections.includes('docker');
    try {
      if (Date.now() - availabilityCheckedAt >= AVAILABILITY_REFRESH_MS) {
        availabilityCheckedAt = Date.now();
        const [gpuState, dockerState] = await Promise.all([
          needsGpu ? gpuCollector.availabilityStatus() : Promise.resolve<CollectorAvailability>('available'),
          needsDocker ? dockerCollector.availabilityStatus() : Promise.resolve<CollectorAvailability>('available'),
        ]);
        availability = { gpu: needsGpu ? gpuState : undefined, docker: needsDocker ? dockerState : undefined };
        if (gpuState !== 'available' || dockerState !== 'available') {
          logInfo(`availability: gpu=${needsGpu ? gpuState : 'not-needed'} docker=${needsDocker ? dockerState : 'not-needed'}`);
        }
      }
      heavy.gpus = needsGpu ? await gpuCollector.collect() : undefined;
      heavy.docker = needsDocker ? await dockerCollector.collect() : undefined;
      // 采集器自己只返回 undefined(保持不依赖 vscode 以便纯 node 单测),诊断原因在这里落日志。
      if (gpuCollector.lastError) {
        logErrorOnce('gpu collection', gpuCollector.lastError);
      }
      if (dockerCollector.lastError) {
        logErrorOnce('docker collection', dockerCollector.lastError);
      }
    } catch (err) {
      // 重通道失败不影响轻通道的展示,只记日志——collectLight 的下一轮渲染会把最新数据带出去。
      logErrorOnce('heavy collection', err);
    }
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
    const wasEnabled = config.enabled;
    config = readConfig();
    applyIntervalsForFocus(vscode.window.state.focused);
    if (!wasEnabled && config.enabled) {
      // 从暂停恢复:历史里还留着暂停前的旧点,先清掉,不然趋势图会横跨整段暂停期。
      store.clear();
      state = 'loading';
      logInfo('resumed');
      void Promise.all([lightPoller.runNow(), heavyPoller.runNow()]);
    } else if (wasEnabled && !config.enabled) {
      logInfo('paused');
      statusBar.showPaused();
    }
  });

  const showTrendCommand = vscode.commands.registerCommand('remotePulse.showTrend', () => {
    TrendPanel.createOrShow(host, buildTrendPayload(store, config, availability));
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
  const configureTrendChartMetricsCommand = vscode.commands.registerCommand(
    'remotePulse.configureTrendChartMetrics',
    configureTrendChartMetrics,
  );

  const toggleEnabledCommand = vscode.commands.registerCommand('remotePulse.toggleEnabled', toggleEnabled);

  const showLogCommand = vscode.commands.registerCommand('remotePulse.showLog', showLog);

  /** 把内存里的历史快照写进系统临时目录:远程主机上没有 GUI 文件对话框,不落 workspace。 */
  const exportSnapshotCommand = vscode.commands.registerCommand('remotePulse.exportSnapshot', async () => {
    const fileName = `remote-pulse-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const filePath = path.join(os.tmpdir(), fileName);
    const payload = {
      host,
      exportedAt: new Date().toISOString(),
      config,
      snapshots: store.getHistory(),
    };
    try {
      await fs.promises.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
    } catch (err) {
      logErrorOnce('exportSnapshot', err);
      void vscode.window.showErrorMessage(`Remote Pulse: ${vscode.l10n.t('Failed to export snapshot: {0}', err instanceof Error ? err.message : String(err))}`);
      return;
    }
    const OPEN = vscode.l10n.t('Open File');
    const picked = await vscode.window.showInformationMessage(
      vscode.l10n.t('Snapshot exported to {0}', filePath),
      OPEN,
    );
    if (picked === OPEN) {
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath));
    }
  });

  context.subscriptions.push(
    statusBar,
    focusListener,
    configListener,
    showTrendCommand,
    refreshCommand,
    configureStatusBarMetricsCommand,
    configureTrendPanelSectionsCommand,
    configureTrendChartMetricsCommand,
    toggleEnabledCommand,
    showLogCommand,
    exportSnapshotCommand,
    lightPoller,
    heavyPoller,
    { dispose: disposeLogChannel },
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

function buildTrendPayload(
  store: StatsStore,
  config: RemotePulseConfig,
  availability: { gpu?: CollectorAvailability; docker?: CollectorAvailability },
): TrendPayload {
  const history = store.getHistory();
  const cutoff = Date.now() - TREND_WINDOW_MS;
  const windowed = history.filter(s => s.timestamp >= cutoff);
  const latestSnapshot = store.latest();
  // trendPanelSections 只管"System 信息行要不要显示网络这一行"和"GPU 详情区块要不要出现"——
  // 和下面 series 里"折线图要不要画这条线"(trendChartMetrics)是两个独立的开关,故意不共用同一个布尔值,
  // 否则用户要么两处一起有、要么两处一起没有,做不到"面板里看 GPU 详情,但图表不画 GPU 线"这种组合。
  const showNetworkDetail = config.trendPanelSections.includes('network');
  const showGpuDetail = config.trendPanelSections.includes('gpu');

  const showCpuChart = config.trendChartMetrics.includes('cpu');
  const showMemoryChart = config.trendChartMetrics.includes('memory');
  // 光勾了 trendChartMetrics 里的 gpu 还不够——没有 nvidia-smi/没装 GPU 时 latestSnapshot.gpus
  // 永远是空数组,若只看配置就画,`s.gpus?.[0]?.utilizationPercent ?? 0` 兜底出来的 0 会在图上
  // 变成一条以假乱真、恒定在 0% 的"GPU"线。和状态栏 GPU 项(primaryGpu !== undefined)同一个判断。
  const hasGpuData = (latestSnapshot?.gpus?.length ?? 0) > 0;
  const showGpuChart = config.trendChartMetrics.includes('gpu') && hasGpuData;
  const showNetworkChart = config.trendChartMetrics.includes('network');

  return {
    series: {
      timestamps: windowed.map(s => s.timestamp),
      cpu: showCpuChart ? windowed.map(s => s.cpu?.percent ?? 0) : undefined,
      memory: showMemoryChart ? windowed.map(s => s.memory?.percent ?? 0) : undefined,
      // 只取第一张 GPU(和状态栏摘要同一个"主卡"约定),多卡详情仍然只在 GPU 详情区块里能看到。
      gpu: showGpuChart ? windowed.map(s => s.gpus?.[0]?.utilizationPercent ?? 0) : undefined,
      // 上传/下载分两个数组,不再合成 rx+tx 一条线——合并了就分不清方向,和状态栏网络项拆成
      // 上下行两截是同一个理由。原始 B/s,不做归一化,趋势面板画在自己独立的右侧 y 轴上,
      // 不用挤进 CPU/内存共用的 0-100% 左轴。
      networkRx: showNetworkChart ? windowed.map(s => s.network?.rxRate ?? 0) : undefined,
      networkTx: showNetworkChart ? windowed.map(s => s.network?.txRate ?? 0) : undefined,
    },
    latest: latestSnapshot && {
      cpu: latestSnapshot.cpu,
      memory: latestSnapshot.memory,
      disks: latestSnapshot.disks ?? [],
      network: showNetworkDetail ? latestSnapshot.network : undefined,
      gpus: showGpuDetail ? (latestSnapshot.gpus ?? []) : [],
      docker: config.trendPanelSections.includes('docker') ? latestSnapshot.docker : undefined,
      uptimeSeconds: latestSnapshot.uptimeSeconds,
    },
    thresholds: { warning: config.warningThreshold, critical: config.criticalThreshold },
    // 探测说"可用"但还没有一轮成功采集(重通道 10 秒一次)的窗口期,提示语应是
    // "等待首次采集"而不是"没有这块硬件"。
    availability: {
      gpu: availability.gpu === 'available' && !latestSnapshot?.gpus ? 'pending' : availability.gpu,
      docker: availability.docker === 'available' && !latestSnapshot?.docker ? 'pending' : availability.docker,
    },
  };
}
