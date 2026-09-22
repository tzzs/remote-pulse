import * as vscode from 'vscode';
import * as os from 'os';
import { CpuCollector } from './collectors/cpu';
import { MemoryCollector } from './collectors/memory';
import { DiskCollector } from './collectors/disk';
import { DiskIoCollector } from './collectors/diskIo';
import { LoadAverageCollector } from './collectors/loadavg';
import { NetworkCollector } from './collectors/network';
import { GpuCollector, selectGpu } from './collectors/gpu';
import { ProcessCollector } from './collectors/process';
import { DockerCollector } from './collectors/docker';
import { StatsStore } from './store/statsStore';
import { Poller } from './scheduler';
import { PulseStatusBar, TooltipContext } from './statusBar';
import {
  readConfig,
  isRemotePulseConfigChange,
  affectsStatusBarLayout,
  RemotePulseConfig,
  configureStatusBarMetrics,
  configureTrendPanelSections,
  configureTrendChartMetrics,
  configureNotificationMetrics,
} from './config';
import { CollectionState, Snapshot } from './types';
import { HostInfo, TrendPanel, TrendPayload } from './webview/trendPanel';
import { formatHostLabel } from './util/hostLabel';
import { historyCapacityFor } from './util/settings';
import { log, logThrottled, clearThrottle, setLogSink, resetLogSink, errorMessage } from './util/logger';

/** tooltip 里的 sparkline 只看最近 5 分钟——再长的趋势该去趋势面板看,压进 20 个块字符只会变成噪声。 */
const SPARKLINE_WINDOW_MS = 5 * 60 * 1000;

/**
 * 某一路采集连续失败多少轮之后,就把它的旧值清掉。
 * 保留几轮是为了扛住偶发抖动(一次 EAGAIN 不该让整行消失),但一直显示一个早已过期的数字
 * 比显示"没有数据"更糟——用户不会知道自己在看一个五分钟前的快照。
 */
const STALE_TOLERANCE = 5;

/** 通知静音时长:一次 OOM 前兆可能持续几十分钟,每次越界都弹一遍就成了噪声。 */
const MUTE_DURATION_MS = 60 * 60 * 1000;

/** 本地(非远程)窗口里没有"远程主机"可言,不应该出现状态栏/占用轮询资源。 */
export function activate(context: vscode.ExtensionContext): { monitoring: boolean } {
  // 命令面板不看扩展有没有真正激活,只看命令声明。不设这个上下文键的话,本地窗口里
  // "Remote Pulse: ..." 照样会被列出来,点下去得到的是一句 "command not found"。
  void vscode.commands.executeCommand('setContext', 'remotePulse.active', false);
  if (!vscode.env.remoteName) {
    return { monitoring: false };
  }
  void vscode.commands.executeCommand('setContext', 'remotePulse.active', true);

  // 日志模块本身不认识 vscode(否则采集器的纯解析函数就没法脱离扩展宿主跑单测),
  // 输出目的地在这里注入。通道按需创建、从不自动 show(),不会抢走用户的面板焦点。
  const output = vscode.window.createOutputChannel('Remote Pulse');
  setLogSink(line => output.appendLine(line));

  let config = readConfig();
  const store = new StatsStore();
  store.setCapacity(historyCapacityFor(config.trendWindowMinutes, config.refreshInterval));

  let statusBar = new PulseStatusBar(config.statusBarAlignment);

  const cpuCollector = new CpuCollector(() => config.cgroupAware);
  const memoryCollector = new MemoryCollector(() => config.cgroupAware);
  const diskCollector = new DiskCollector(() => config.diskMountPoints);
  const diskIoCollector = new DiskIoCollector();
  const loadCollector = new LoadAverageCollector();
  const networkCollector = new NetworkCollector(() => config.networkInterfaces);
  const gpuCollector = new GpuCollector();
  const processCollector = new ProcessCollector(() => config.topProcessCount);
  const dockerCollector = new DockerCollector(() => config.dockerMaxContainers);

  const hostLabel = resolveHostLabel();
  const host: HostInfo = { label: hostLabel, user: safeUserName(), addresses: listIPv4Addresses() };
  log(`Remote Pulse activated on ${hostLabel} (remote: ${vscode.env.remoteName})`);

  let state: CollectionState = 'loading';
  let lastWasCritical = false;
  let mutedUntil = 0;

  const light: Pick<Snapshot, 'cpu' | 'memory' | 'swap' | 'load' | 'network'> = {};
  const heavy: Pick<Snapshot, 'disks' | 'diskIo' | 'gpus' | 'docker' | 'processes'> = {};
  const failureCounts = new Map<string, number>();

  /**
   * 早先这里是一个 Promise.all:任何一路采集抛错,整轮就进 catch,连已经成功拿到的
   * CPU/磁盘一起丢掉,状态栏整条变成 $(circle-slash)。改成逐路结算——
   * 成功的照用,失败的记日志、暂时沿用上一次的值,连续失败够多轮才清空。
   */
  function settle<T>(key: string, result: PromiseSettledResult<T>, previous: T | undefined): T | undefined {
    if (result.status === 'fulfilled') {
      failureCounts.delete(key);
      clearThrottle(key);
      return result.value;
    }
    const count = (failureCounts.get(key) ?? 0) + 1;
    failureCounts.set(key, count);
    logThrottled(key, `Collector "${key}" failed: ${errorMessage(result.reason)}`);
    return count >= STALE_TOLERANCE ? undefined : previous;
  }

  function renderAndStore(): void {
    const snapshot: Snapshot = {
      timestamp: Date.now(),
      cpu: light.cpu,
      memory: light.memory,
      swap: light.swap,
      load: light.load,
      network: light.network,
      disks: heavy.disks,
      diskIo: heavy.diskIo,
      gpus: heavy.gpus,
      processes: heavy.processes,
      docker: heavy.docker,
      uptimeSeconds: safeUptime(),
    };
    store.push(snapshot);

    statusBar.update(snapshot, config, state, buildTooltipContext());
    maybeNotifyCritical(snapshot);
    if (TrendPanel.isOpen()) {
      TrendPanel.refreshIfOpen(host, buildTrendPayload(store, config));
    }
  }

  /** sparkline 要的是"最近一段时间的序列",正好是 StatsStore.recentValues 的用途。 */
  function buildTooltipContext(): TooltipContext {
    return {
      hostLabel,
      cpuHistory: store.recentValues(SPARKLINE_WINDOW_MS, s => s.cpu?.percent),
      memoryHistory: store.recentValues(SPARKLINE_WINDOW_MS, s => s.memory?.percent),
      gpuHistory: store.recentValues(SPARKLINE_WINDOW_MS, s => selectGpu(s.gpus, config.gpuSelection)?.utilizationPercent),
    };
  }

  /** 哪些指标越阈值值得打断用户,由 notificationMetrics 决定——磁盘写满比 CPU 高更致命,默认在内。 */
  function criticalParts(snapshot: Snapshot): string[] {
    const parts: string[] = [];
    const enabled = config.notificationMetrics;
    const cpuPercent = snapshot.cpu?.percent;
    if (enabled.includes('cpu') && cpuPercent !== undefined && cpuPercent >= config.criticalThreshold) {
      parts.push(`CPU ${Math.round(cpuPercent)}%`);
    }
    const memPercent = snapshot.memory?.percent;
    if (enabled.includes('memory') && memPercent !== undefined && memPercent >= config.criticalThreshold) {
      parts.push(`${vscode.l10n.t('Memory')} ${Math.round(memPercent)}%`);
    }
    if (enabled.includes('disk')) {
      for (const disk of snapshot.disks ?? []) {
        if (disk.percent >= config.criticalThreshold) {
          parts.push(`${vscode.l10n.t('Disk')} ${disk.mountPoint} ${Math.round(disk.percent)}%`);
        }
      }
    }
    const gpu = selectGpu(snapshot.gpus, config.gpuSelection);
    if (enabled.includes('gpu') && gpu && gpu.utilizationPercent >= config.criticalThreshold) {
      parts.push(`GPU ${Math.round(gpu.utilizationPercent)}%`);
    }
    return parts;
  }

  function maybeNotifyCritical(snapshot: Snapshot): void {
    if (!config.enableNotifications) {
      return;
    }
    const parts = criticalParts(snapshot);
    const isCritical = parts.length > 0;
    // 只在"跨越"到严重态的那一刻通知一次,而不是每轮轮询都弹窗,避免持续过载时通知刷屏。
    // 恢复到阈值以下后重新越界会再次触发,保证用户始终能看到最新一次告警。
    if (isCritical && !lastWasCritical && Date.now() >= mutedUntil) {
      const viewAction = vscode.l10n.t('View trend chart');
      const muteAction = vscode.l10n.t('Mute for 1 hour');
      void vscode.window
        .showWarningMessage(
          `Remote Pulse: ${vscode.l10n.t('{0} on {1} has reached the critical threshold', parts.join(', '), hostLabel)}`,
          viewAction,
          muteAction,
        )
        .then(choice => {
          if (choice === viewAction) {
            TrendPanel.createOrShow(context.extensionUri, host, buildTrendPayload(store, config));
          } else if (choice === muteAction) {
            mutedUntil = Date.now() + MUTE_DURATION_MS;
            log(`Critical notifications muted until ${new Date(mutedUntil).toISOString()}`);
          }
        });
    }
    lastWasCritical = isCritical;
  }

  async function collectLight(): Promise<void> {
    // 网络数据有三处可能用到它:趋势面板的 System 行、状态栏摘要、趋势图的线——
    // 三个配置项(trendPanelSections/statusBarMetrics/trendChartMetrics)各自独立勾选,
    // 只要任意一处需要就得采集,采集这一步不区分"为了哪个用途"。
    const needsNetwork =
      config.trendPanelSections.includes('network') ||
      config.statusBarMetrics.includes('network') ||
      config.trendChartMetrics.includes('network');

    const [cpu, memory, load, network] = await Promise.allSettled([
      cpuCollector.collect(),
      memoryCollector.collect(),
      loadCollector.collect(),
      needsNetwork ? networkCollector.collect() : Promise.resolve(undefined),
    ]);

    light.cpu = settle('cpu', cpu, light.cpu);
    const memorySample = settle('memory', memory, undefined);
    if (memorySample) {
      light.memory = memorySample.memory;
      light.swap = memorySample.swap;
    } else if ((failureCounts.get('memory') ?? 0) >= STALE_TOLERANCE) {
      light.memory = undefined;
      light.swap = undefined;
    }
    light.load = settle('load', load, light.load);
    light.network = needsNetwork ? settle('network', network, light.network) : undefined;

    // 四路全灭才算"采集失败";只要还有一个指标是新鲜的,就正常渲染剩下的部分。
    const allFailed = [cpu, memory, load, network].every(r => r.status === 'rejected');
    if (allFailed) {
      state = 'error';
      statusBar.showError(errorMessage((cpu as PromiseRejectedResult).reason));
      return;
    }
    if (light.cpu) {
      state = 'ok';
    }
    renderAndStore();
  }

  async function collectHeavy(): Promise<void> {
    // 同理,GPU 数据可能喂状态栏摘要、趋势面板的逐卡详情、趋势图的线,三处独立勾选,任一处需要就采集。
    const needsGpu =
      config.trendPanelSections.includes('gpu') ||
      config.statusBarMetrics.includes('gpu') ||
      config.trendChartMetrics.includes('gpu');
    const needsProcesses = config.trendPanelSections.includes('processes');
    const needsDiskIo = config.trendPanelSections.includes('diskIo');

    // 磁盘容量从 2 秒的高频循环挪到这里:statfs 是阻塞式的,挂死的 NFS/CIFS 会占住 libuv
    // 线程池(默认只有 4 个线程),每 2 秒压一批进去足以拖慢整个扩展宿主的文件 I/O。
    // 而磁盘容量本来就是慢变量,10 秒一次绰绰有余。
    const [disks, diskIo, gpus, processes, docker] = await Promise.allSettled([
      diskCollector.collect(),
      needsDiskIo ? diskIoCollector.collect() : Promise.resolve(undefined),
      needsGpu ? gpuCollector.collect() : Promise.resolve(undefined),
      needsProcesses ? processCollector.collect(light.cpu?.cores ?? 1) : Promise.resolve(undefined),
      config.trendPanelSections.includes('docker') ? dockerCollector.collect() : Promise.resolve(undefined),
    ]);

    heavy.disks = settle('disk', disks, heavy.disks);
    heavy.diskIo = needsDiskIo ? settle('diskIo', diskIo, heavy.diskIo) : undefined;
    heavy.gpus = needsGpu ? settle('gpu', gpus, heavy.gpus) : undefined;
    heavy.processes = needsProcesses ? settle('processes', processes, heavy.processes) : undefined;
    heavy.docker = config.trendPanelSections.includes('docker') ? settle('docker', docker, heavy.docker) : undefined;
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
    const rebuildNeeded = affectsStatusBarLayout(e);
    config = readConfig();
    store.setCapacity(historyCapacityFor(config.trendWindowMinutes, config.refreshInterval));
    if (rebuildNeeded) {
      // StatusBarItem 的对齐方式在构造时就定死了,改配置只能整组销毁重建。
      statusBar.dispose();
      statusBar = new PulseStatusBar(config.statusBarAlignment);
    }
    applyIntervalsForFocus(vscode.window.state.focused);
  });

  const showTrendCommand = vscode.commands.registerCommand('remotePulse.showTrend', () => {
    TrendPanel.createOrShow(context.extensionUri, host, buildTrendPayload(store, config));
  });

  const refreshCommand = vscode.commands.registerCommand('remotePulse.refresh', async () => {
    // 重指标先跑完,轻指标随后渲染——否则新拿到的 GPU/Docker 数据要等下一个 2 秒周期才上屏。
    await heavyPoller.runNow();
    await lightPoller.runNow();
  });

  const showLogsCommand = vscode.commands.registerCommand('remotePulse.showLogs', () => output.show(true));

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
  const configureNotificationMetricsCommand = vscode.commands.registerCommand(
    'remotePulse.configureNotificationMetrics',
    configureNotificationMetrics,
  );

  context.subscriptions.push(
    { dispose: () => statusBar.dispose() },
    output,
    { dispose: resetLogSink },
    focusListener,
    configListener,
    showTrendCommand,
    refreshCommand,
    showLogsCommand,
    configureStatusBarMetricsCommand,
    configureTrendPanelSectionsCommand,
    configureTrendChartMetricsCommand,
    configureNotificationMetricsCommand,
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

export function buildTrendPayload(store: StatsStore, config: RemotePulseConfig): TrendPayload {
  const history = store.getHistory();
  const windowMs = Math.max(1, config.trendWindowMinutes) * 60 * 1000;
  const cutoff = Date.now() - windowMs;
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
      // 多卡时跟随 gpuSelection(主卡 / 最忙的卡),和状态栏摘要同一个约定;逐卡详情仍然只在 GPU 区块里看。
      gpu: showGpuChart ? windowed.map(s => selectGpu(s.gpus, config.gpuSelection)?.utilizationPercent ?? 0) : undefined,
      // 上传/下载分两个数组,不再合成 rx+tx 一条线——合并了就分不清方向,和状态栏网络项拆成
      // 上下行两截是同一个理由。原始 B/s,不做归一化,趋势面板画在自己独立的右侧 y 轴上,
      // 不用挤进 CPU/内存共用的 0-100% 左轴。
      networkRx: showNetworkChart ? windowed.map(s => s.network?.rxRate ?? 0) : undefined,
      networkTx: showNetworkChart ? windowed.map(s => s.network?.txRate ?? 0) : undefined,
    },
    latest: latestSnapshot && {
      cpu: latestSnapshot.cpu,
      memory: latestSnapshot.memory,
      swap: latestSnapshot.swap,
      load: latestSnapshot.load,
      disks: latestSnapshot.disks ?? [],
      diskIo: config.trendPanelSections.includes('diskIo') ? latestSnapshot.diskIo : undefined,
      network: showNetworkDetail ? latestSnapshot.network : undefined,
      gpus: showGpuDetail ? (latestSnapshot.gpus ?? []) : [],
      processes: config.trendPanelSections.includes('processes') ? (latestSnapshot.processes ?? []) : [],
      docker: config.trendPanelSections.includes('docker') ? latestSnapshot.docker : undefined,
      uptimeSeconds: latestSnapshot.uptimeSeconds,
    },
    thresholds: {
      warning: config.warningThreshold,
      critical: config.criticalThreshold,
      gpuTempWarning: config.gpuTempWarningThreshold,
      gpuTempCritical: config.gpuTempCriticalThreshold,
    },
    windowMinutes: config.trendWindowMinutes,
  };
}
