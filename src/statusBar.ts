import * as vscode from 'vscode';
import { AlertLevel, CollectionState, Snapshot } from './types';
import { RemotePulseConfig, StatusBarAlignment } from './config';
import { calcAlertLevel, maxAlertLevel } from './store/statsStore';
import { formatBytes, formatRate, formatUptime, renderSparkline, sampleForSparkline } from './util/sparkline';
import { TooltipRow, formatTooltipTable } from './util/align';
import { selectGpu } from './collectors/gpu';

/**
 * 之前用写死的十六进制色值(不经过主题 token),理由是主题可能把 charts.* / terminal.ansiBright*
 * 重新定义成偏灰偏淡的取值。但这样做丢掉了主题系统真正解决的问题:Remote-SSH/WSL 会把整条
 * 状态栏背景强制换色(常见的是深青绿色),写死的绿色文字("正常"态)在这种背景上对比度经
 * 实测只有 ~2.4:1,远低于 WCAG 最低的 3:1——正是因为它和背景撞了色相,只是明暗不同。
 *
 * 现在换成 VS Code 官方为状态栏预留的 warning/error 主题 token 对(前景+背景成对出现,
 * 主题作者写背景色时就会配套写足够对比度的前景色,这是平台保证,不是赌运气);
 * "正常"态干脆不设色,让文字继承 statusBar.foreground——这个 token 天生保证与
 * statusBar.background(包括被 Remote-SSH 改写后的版本)对比度达标。
 * 代价是拿不到一个专属的"健康绿"背景块,因为 VS Code 没有对外暴露 successBackground token。
 */
function foregroundFor(level: AlertLevel): vscode.ThemeColor | undefined {
  if (level === 'critical') return new vscode.ThemeColor('statusBarItem.errorForeground');
  if (level === 'warning') return new vscode.ThemeColor('statusBarItem.warningForeground');
  return undefined;
}

function backgroundFor(level: AlertLevel): vscode.ThemeColor | undefined {
  if (level === 'critical') return new vscode.ThemeColor('statusBarItem.errorBackground');
  if (level === 'warning') return new vscode.ThemeColor('statusBarItem.warningBackground');
  return undefined;
}

const NORMAL_ICON = '$(pulse)';
const CRITICAL_ICON = '$(warning)';

/** CPU/内存/GPU/网络四项都可以通过 statusBarMetrics 单独勾选展示,未勾选的仍然只在趋势面板里能看到——点击 CPU/内存/GPU/网络任意一项都能进面板。 */
const SHOW_TREND_COMMAND = 'remotePulse.showTrend';
/** 告警图标本身不再跳趋势面板(CPU/内存/GPU/网络四个数字项已经能点进面板了)——点它直接打开"配置状态栏指标"的多选框,省得用户绕到趋势面板里再找齿轮按钮。 */
const CONFIGURE_METRICS_COMMAND = 'remotePulse.configureStatusBarMetrics';

/** 悬浮详情要用的历史序列。状态栏只有一个数字,趋势要靠 sparkline 在 tooltip 里表达。 */
export interface TooltipContext {
  hostLabel: string;
  cpuHistory: number[];
  memoryHistory: number[];
  gpuHistory: number[];
}

/** 单个 StatusBarItem 只能有一种颜色,每个指标要各自独立变色,图标还要反映其中最严重的一个——
 * 所以拆成多个相邻的项而不是一条拼接文本,和 VS Code 自带的多段状态栏组合(比如 Git 分支+同步)是同一种做法。 */
export class PulseStatusBar {
  private readonly iconItem: vscode.StatusBarItem;
  private readonly cpuItem: vscode.StatusBarItem;
  private readonly memItem: vscode.StatusBarItem;
  private readonly gpuItem: vscode.StatusBarItem;
  private readonly networkItem: vscode.StatusBarItem;
  /** vscode.StatusBarItem 不暴露"当前是否可见"的读取接口,自己记一份供调试状态用。 */
  private cpuVisible = false;
  private memVisible = false;
  private gpuVisible = false;
  private networkVisible = false;

  /**
   * 对齐方式只能在 createStatusBarItem 时指定,之后改不了——所以它是构造参数,
   * 配置变更时由扩展侧整组销毁重建(见 extension.ts 的 rebuildStatusBar)。
   * 右对齐时优先级要反过来:VS Code 在右侧是"优先级越大越靠右",左侧则是越大越靠左,
   * 直接沿用同一组数字会让四个指标的顺序在右侧镜像过来。
   */
  constructor(public readonly alignment: StatusBarAlignment = 'left') {
    const side = alignment === 'right' ? vscode.StatusBarAlignment.Right : vscode.StatusBarAlignment.Left;
    const order = alignment === 'right' ? [996, 997, 998, 999, 1000] : [1000, 999, 998, 997, 996];

    this.iconItem = vscode.window.createStatusBarItem(side, order[0]);
    this.iconItem.name = 'Remote Pulse: Alert';
    this.iconItem.command = CONFIGURE_METRICS_COMMAND;

    this.cpuItem = vscode.window.createStatusBarItem(side, order[1]);
    this.cpuItem.name = 'Remote Pulse: CPU';
    this.cpuItem.command = SHOW_TREND_COMMAND;

    this.memItem = vscode.window.createStatusBarItem(side, order[2]);
    this.memItem.name = 'Remote Pulse: Memory';
    this.memItem.command = SHOW_TREND_COMMAND;

    this.gpuItem = vscode.window.createStatusBarItem(side, order[3]);
    this.gpuItem.name = 'Remote Pulse: GPU';
    this.gpuItem.command = SHOW_TREND_COMMAND;

    this.networkItem = vscode.window.createStatusBarItem(side, order[4]);
    this.networkItem.name = 'Remote Pulse: Network';
    this.networkItem.command = SHOW_TREND_COMMAND;

    this.showLoading();
    this.iconItem.show();
  }

  showLoading(): void {
    this.iconItem.text = '$(sync~spin)';
    this.iconItem.color = undefined;
    this.iconItem.backgroundColor = undefined;
    this.iconItem.tooltip = new vscode.MarkdownString(vscode.l10n.t('Collecting remote host status…'));
    this.iconItem.show();
    this.hideMetricItems();
  }

  /** 采集失败(权限/网络抖动)时静默降级,不弹烦人的错误通知——但原因要留在 tooltip 和日志里,不能让用户无从查起。 */
  showError(reason: string): void {
    this.iconItem.text = '$(circle-slash)';
    this.iconItem.color = undefined;
    this.iconItem.backgroundColor = undefined;
    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`${vscode.l10n.t('Collection failed: {0}', reason)}\n\n`);
    tooltip.appendMarkdown(`[${vscode.l10n.t('Show Logs')}](command:remotePulse.showLogs)`);
    tooltip.isTrusted = true;
    this.iconItem.tooltip = tooltip;
    this.iconItem.show();
    this.hideMetricItems();
  }

  private hideMetricItems(): void {
    this.cpuItem.hide();
    this.memItem.hide();
    this.gpuItem.hide();
    this.networkItem.hide();
    this.cpuVisible = false;
    this.memVisible = false;
    this.gpuVisible = false;
    this.networkVisible = false;
  }

  update(snapshot: Snapshot, config: RemotePulseConfig, state: CollectionState, context?: TooltipContext): void {
    if (state === 'loading') {
      this.showLoading();
      return;
    }

    const cpuPercent = snapshot.cpu?.percent;
    const memPercent = snapshot.memory?.percent;
    if (cpuPercent === undefined && memPercent === undefined) {
      this.showLoading();
      return;
    }

    const showCpu = config.statusBarMetrics.includes('cpu');
    const showMem = config.statusBarMetrics.includes('memory');
    // 多卡机器上盯着 GPU 0 会在 GPU 3 打满时一直显示 0%,gpuSelection 让用户选"主卡"还是"最忙的卡"。
    const primaryGpu = selectGpu(snapshot.gpus, config.gpuSelection);
    const showGpu = config.statusBarMetrics.includes('gpu') && primaryGpu !== undefined;
    // 网络吞吐没有 0-100% 语义,套用 CPU/内存那套告警阈值没有意义,所以网络项永远不参与告警配色,
    // 只要 config 打开且已经采集到至少一次速率(收发都是 0 也算"采集到了",不代表没网络)就显示。
    const showNetwork = config.statusBarMetrics.includes('network') && snapshot.network !== undefined;

    const cpuLevel = cpuPercent !== undefined ? calcAlertLevel(cpuPercent, config.warningThreshold, config.criticalThreshold) : 'normal';
    const memLevel = memPercent !== undefined ? calcAlertLevel(memPercent, config.warningThreshold, config.criticalThreshold) : 'normal';
    const gpuLevel = primaryGpu !== undefined ? calcAlertLevel(primaryGpu.utilizationPercent, config.warningThreshold, config.criticalThreshold) : 'normal';
    // 图标只反映用户实际勾选展示的那些指标——隐藏掉的指标即使越阈值,也不该影响图标颜色。
    const consideredLevels: AlertLevel[] = [];
    if (showCpu) {
      consideredLevels.push(cpuLevel);
    }
    if (showMem) {
      consideredLevels.push(memLevel);
    }
    if (showGpu) {
      consideredLevels.push(gpuLevel);
    }
    const overallLevel = maxAlertLevel(...consideredLevels);

    const cpuText = cpuPercent !== undefined ? String(Math.round(cpuPercent)).padStart(2, ' ') : '--';
    const memText = memPercent !== undefined ? String(Math.round(memPercent)).padStart(2, ' ') : '--';

    // 五个项共用同一份详情:鼠标扫过哪一项都能看到完整快照,不用记"哪个数字对应哪台机器"。
    // 统一赋值(包括当前隐藏的项)而不是散在各个 show 分支里——隐藏项的 tooltip 没人看得到,
    // 但少了五处重复,也就少了"改了一处忘了另一处"的机会。
    const tooltip = buildTooltip(snapshot, config, context);
    for (const item of [this.iconItem, this.cpuItem, this.memItem, this.gpuItem, this.networkItem]) {
      item.tooltip = tooltip;
    }

    this.iconItem.text = overallLevel === 'critical' ? CRITICAL_ICON : NORMAL_ICON;
    this.iconItem.color = foregroundFor(overallLevel);
    this.iconItem.backgroundColor = backgroundFor(overallLevel);
    this.iconItem.show();

    if (showCpu) {
      this.cpuItem.text = `CPU ${cpuText}%`;
      this.cpuItem.color = foregroundFor(cpuLevel);
      this.cpuItem.backgroundColor = backgroundFor(cpuLevel);
      this.cpuItem.show();
      this.cpuVisible = true;
    } else {
      this.cpuItem.hide();
      this.cpuVisible = false;
    }

    if (showMem) {
      this.memItem.text = `MEM ${memText}%`;
      this.memItem.color = foregroundFor(memLevel);
      this.memItem.backgroundColor = backgroundFor(memLevel);
      this.memItem.show();
      this.memVisible = true;
    } else {
      this.memItem.hide();
      this.memVisible = false;
    }

    if (showGpu && primaryGpu) {
      const gpuText = String(Math.round(primaryGpu.utilizationPercent)).padStart(2, ' ');
      this.gpuItem.text = `GPU ${gpuText}%`;
      this.gpuItem.color = foregroundFor(gpuLevel);
      this.gpuItem.backgroundColor = backgroundFor(gpuLevel);
      this.gpuItem.show();
      this.gpuVisible = true;
    } else {
      this.gpuItem.hide();
      this.gpuVisible = false;
    }

    if (showNetwork && snapshot.network) {
      // 合并成一个数字看不出是上传还是下载,分开标 $(arrow-down)/$(arrow-up) 才对得上"网速"这个直觉。
      this.networkItem.text = `$(arrow-down) ${formatRate(snapshot.network.rxRate)} $(arrow-up) ${formatRate(snapshot.network.txRate)}`;
      this.networkItem.color = undefined;
      this.networkItem.backgroundColor = undefined;
      this.networkItem.show();
      this.networkVisible = true;
    } else {
      this.networkItem.hide();
      this.networkVisible = false;
    }
  }

  /** 仅供集成测试读取当前渲染状态用,不做其他用途。 */
  get debugState(): {
    icon: StatusBarItemDebugState;
    cpu: StatusBarItemDebugState;
    mem: StatusBarItemDebugState;
    gpu: StatusBarItemDebugState;
    network: StatusBarItemDebugState;
  } {
    return {
      icon: { ...debugStateOf(this.iconItem), visible: true },
      cpu: { ...debugStateOf(this.cpuItem), visible: this.cpuVisible },
      mem: { ...debugStateOf(this.memItem), visible: this.memVisible },
      gpu: { ...debugStateOf(this.gpuItem), visible: this.gpuVisible },
      network: { ...debugStateOf(this.networkItem), visible: this.networkVisible },
    };
  }

  dispose(): void {
    this.iconItem.dispose();
    this.cpuItem.dispose();
    this.memItem.dispose();
    this.gpuItem.dispose();
    this.networkItem.dispose();
  }
}

/**
 * 状态栏只能放下一个数字,悬浮层才是详情的容器(这是设计方案 2.2 定下的分工)。
 * 用 unicode 块字符画 sparkline:不需要起 Webview 就能表达趋势,这是保持"轻"的关键技巧。
 *
 * 排版放在 ``` 代码块里,因为只有等宽字体下按视觉宽度补空格才能真的对齐——
 * 中文标签("内存")在等宽字体里占两格,padLabel 用的是 visualWidth 而不是 String.length。
 */
export function buildTooltipRows(snapshot: Snapshot, config: RemotePulseConfig, context?: TooltipContext): TooltipRow[] {
  const rows: TooltipRow[] = [];
  if (snapshot.cpu) {
    const quota = snapshot.cpu.source === 'cgroup' && snapshot.cpu.quotaCores !== undefined
      ? vscode.l10n.t('{0} cores (cgroup limit)', trimNumber(snapshot.cpu.quotaCores))
      : vscode.l10n.t('{0} cores', snapshot.cpu.cores);
    rows.push({
      label: 'CPU',
      spark: renderSparkline(sampleForSparkline(context?.cpuHistory ?? [])),
      value: `${Math.round(snapshot.cpu.percent)}%`,
      detail: quota,
    });
  }
  if (snapshot.memory) {
    rows.push({
      label: vscode.l10n.t('Memory'),
      spark: renderSparkline(sampleForSparkline(context?.memoryHistory ?? [])),
      value: `${Math.round(snapshot.memory.percent)}%`,
      detail: `${formatBytes(snapshot.memory.used)} / ${formatBytes(snapshot.memory.total)}`,
    });
  }
  if (snapshot.swap) {
    rows.push({
      label: vscode.l10n.t('Swap'),
      spark: '',
      value: `${Math.round(snapshot.swap.percent)}%`,
      detail: `${formatBytes(snapshot.swap.used)} / ${formatBytes(snapshot.swap.total)}`,
    });
  }
  if (snapshot.load && snapshot.cpu) {
    rows.push({
      label: vscode.l10n.t('Load'),
      spark: '',
      value: trimNumber(snapshot.load.one),
      detail: `${trimNumber(snapshot.load.five)} / ${trimNumber(snapshot.load.fifteen)}`,
    });
  }
  const worstDisk = [...(snapshot.disks ?? [])].sort((a, b) => b.percent - a.percent)[0];
  if (worstDisk) {
    rows.push({
      label: vscode.l10n.t('Disk'),
      spark: '',
      value: `${Math.round(worstDisk.percent)}%`,
      detail: `${worstDisk.mountPoint} · ${formatBytes(worstDisk.used)} / ${formatBytes(worstDisk.total)}`,
    });
  }
  const gpu = selectGpu(snapshot.gpus, config.gpuSelection);
  if (gpu) {
    rows.push({
      label: 'GPU',
      spark: renderSparkline(sampleForSparkline(context?.gpuHistory ?? [])),
      value: `${Math.round(gpu.utilizationPercent)}%`,
      detail: `${formatBytes(gpu.memoryUsedMb * 1024 * 1024)} / ${formatBytes(gpu.memoryTotalMb * 1024 * 1024)} · ${gpu.temperatureC} °C`,
    });
  }
  if (snapshot.network) {
    rows.push({
      label: vscode.l10n.t('Network'),
      spark: '',
      value: '',
      detail: `↓ ${formatRate(snapshot.network.rxRate)}  ↑ ${formatRate(snapshot.network.txRate)}`,
    });
  }
  if (snapshot.docker) {
    rows.push({
      label: 'Docker',
      spark: '',
      value: String(snapshot.docker.containerCount),
      detail: vscode.l10n.t('running containers'),
    });
  }
  if (snapshot.uptimeSeconds !== undefined) {
    rows.push({ label: vscode.l10n.t('Uptime'), spark: '', value: formatUptime(snapshot.uptimeSeconds), detail: '' });
  }
  return rows;
}

/** 负载和配额核数是小数,但 "2" 比 "2.00" 好读——整数不带小数点,非整数保留两位。 */
function trimNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}


function buildTooltip(snapshot: Snapshot, config: RemotePulseConfig, context?: TooltipContext): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString();
  tooltip.isTrusted = true;
  // 主机名可能含下划线、星号之类 Markdown 元字符,走 appendText 不走 appendMarkdown。
  tooltip.appendText(vscode.l10n.t('Remote host: {0}', context?.hostLabel ?? ''));
  tooltip.appendMarkdown('\n\n');
  tooltip.appendCodeblock(formatTooltipTable(buildTooltipRows(snapshot, config, context)), 'text');
  tooltip.appendMarkdown(`\n[${vscode.l10n.t('View trend chart')}](command:remotePulse.showTrend)`);
  tooltip.appendMarkdown(` · [${vscode.l10n.t('Settings')}](command:remotePulse.configureStatusBarMetrics)`);
  return tooltip;
}

interface StatusBarItemDebugState {
  text: string;
  color: string | vscode.ThemeColor | undefined;
  backgroundColor: vscode.ThemeColor | undefined;
  tooltip: string | vscode.MarkdownString | undefined;
  alignment: vscode.StatusBarAlignment;
  priority: number | undefined;
  command: string | vscode.Command | undefined;
  visible: boolean;
}

function debugStateOf(item: vscode.StatusBarItem): Omit<StatusBarItemDebugState, 'visible'> {
  return {
    text: item.text,
    color: item.color,
    backgroundColor: item.backgroundColor,
    tooltip: item.tooltip,
    alignment: item.alignment,
    priority: item.priority,
    command: item.command,
  };
}
