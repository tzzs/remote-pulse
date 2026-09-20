import * as vscode from 'vscode';
import { AlertLevel, CollectionState, Snapshot } from './types';
import { RemotePulseConfig } from './config';
import { calcAlertLevel, maxAlertLevel } from './store/statsStore';
import { formatBytes, formatRateFixed, renderSparkline } from './util/sparkline';

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
const PAUSED_ICON = '$(debug-pause)';

/** CPU/内存/磁盘/GPU/网络五项都可以通过 statusBarMetrics 单独勾选展示,未勾选的仍然只在趋势面板里能看到——点击任意一项都能进面板。 */
const SHOW_TREND_COMMAND = 'remotePulse.showTrend';
/** 告警图标本身不再跳趋势面板(各数字项已经能点进面板了)——点它直接打开"配置状态栏指标"的多选框,省得用户绕到趋势面板里再找齿轮按钮。 */
const CONFIGURE_METRICS_COMMAND = 'remotePulse.configureStatusBarMetrics';
const TOGGLE_ENABLED_COMMAND = 'remotePulse.toggleEnabled';

/** sparkline 窗口:取最近 2 分钟历史,太长会把 tooltip 撑爆,太短看不出走势。 */
const TOOLTIP_TREND_WINDOW_MS = 2 * 60 * 1000;
const SPARKLINE_POINTS = 24;

/** 状态栏按需从外部取历史/主机名,避免 PulseStatusBar 直接依赖 StatsStore。 */
export interface StatusBarContext {
  hostLabel: string;
  history(windowMs: number, pick: (s: Snapshot) => number | undefined): number[];
}

function spark(values: number[], min = 0, max = 100): string {
  // 少于 2 个点画 sparkline 没有意义(单点必然显示成一根满柱),用占位符表示"还没有趋势"。
  return values.length >= 2 ? renderSparkline(values, min, max) : '…';
}

/** 把整段窗口均值化成 SPARKLINE_POINTS 个点,避免 2 秒采样的原始毛刺直接糊进 24 格小图。 */
function bucketize(values: number[], points = SPARKLINE_POINTS): number[] {
  if (values.length <= points) {
    return values;
  }
  const bucket = values.length / points;
  const out: number[] = [];
  for (let i = 0; i < points; i++) {
    const from = Math.floor(i * bucket);
    const to = Math.max(from + 1, Math.min(values.length, Math.floor((i + 1) * bucket)));
    let sum = 0;
    for (let j = from; j < to; j++) {
      sum += values[j];
    }
    out.push(sum / (to - from));
  }
  return out;
}

function tooltipLines(lines: string[]): vscode.MarkdownString {
  const md = new vscode.MarkdownString(lines.join('\n\n'));
  md.isTrusted = true;
  return md;
}

function trendBlock(label: string, values: number[], suffix: string, min = 0, max = 100): string {
  return `**${label}** ${suffix}\n\n\`${spark(bucketize(values), min, max)}\``;
}

export class PulseStatusBar {
  private readonly iconItem: vscode.StatusBarItem;
  private readonly cpuItem: vscode.StatusBarItem;
  private readonly memItem: vscode.StatusBarItem;
  private readonly diskItem: vscode.StatusBarItem;
  private readonly gpuItem: vscode.StatusBarItem;
  private readonly networkItem: vscode.StatusBarItem;
  /** vscode.StatusBarItem 不暴露"当前是否可见"的读取接口,自己记一份供调试状态用。 */
  private cpuVisible = false;
  private memVisible = false;
  private diskVisible = false;
  private gpuVisible = false;
  private networkVisible = false;

  constructor(private readonly ctx: StatusBarContext) {
    this.iconItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
    this.iconItem.name = 'Remote Pulse: Alert';
    this.iconItem.command = CONFIGURE_METRICS_COMMAND;
    this.iconItem.tooltip = vscode.l10n.t('Configure Status Bar Metrics');

    this.cpuItem = this.createMetricItem('CPU', 999);
    this.memItem = this.createMetricItem(vscode.l10n.t('Memory'), 998);
    this.diskItem = this.createMetricItem(vscode.l10n.t('Disk'), 997);
    this.gpuItem = this.createMetricItem('GPU', 996);
    this.networkItem = this.createMetricItem(vscode.l10n.t('Network'), 995);

    this.showLoading();
    this.iconItem.show();
  }

  private createMetricItem(name: string, priority: number): vscode.StatusBarItem {
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, priority);
    item.name = `Remote Pulse: ${name}`;
    item.command = SHOW_TREND_COMMAND;
    return item;
  }

  private hideMetrics(): void {
    for (const item of [this.cpuItem, this.memItem, this.diskItem, this.gpuItem, this.networkItem]) {
      item.hide();
    }
    this.cpuVisible = false;
    this.memVisible = false;
    this.diskVisible = false;
    this.gpuVisible = false;
    this.networkVisible = false;
  }

  showLoading(): void {
    this.iconItem.text = '$(sync~spin)';
    this.iconItem.color = undefined;
    this.iconItem.backgroundColor = undefined;
    this.iconItem.show();
    this.hideMetrics();
  }

  /** 总开关关闭:图标变成暂停态,点击可恢复;所有指标项隐藏,不再轮询。 */
  showPaused(): void {
    this.iconItem.text = PAUSED_ICON;
    this.iconItem.color = undefined;
    this.iconItem.backgroundColor = undefined;
    this.iconItem.command = TOGGLE_ENABLED_COMMAND;
    this.iconItem.tooltip = vscode.l10n.t('Remote Pulse is paused — click to resume');
    this.iconItem.show();
    this.hideMetrics();
  }

  /** 采集失败(权限/网络抖动)时静默降级,不弹烦人的错误通知;失败原因放进图标 tooltip,配合日志通道排查。 */
  showError(reason: string): void {
    this.iconItem.text = '$(circle-slash)';
    this.iconItem.color = undefined;
    this.iconItem.backgroundColor = undefined;
    this.iconItem.command = CONFIGURE_METRICS_COMMAND;
    this.iconItem.tooltip = tooltipLines([
      `$(circle-slash) ${vscode.l10n.t('Collection failed: {0}', reason)}`,
      vscode.l10n.t('Click to configure status bar metrics'),
    ]);
    this.iconItem.show();
    this.hideMetrics();
  }

  update(snapshot: Snapshot, config: RemotePulseConfig, state: CollectionState): void {
    // 回到正常渲染路径时恢复图标点击行为(showPaused 会把它切到恢复命令)。
    this.iconItem.command = CONFIGURE_METRICS_COMMAND;

    const cpuPercent = snapshot.cpu?.percent;
    const memPercent = snapshot.memory?.percent;
    // CPU/内存任何一个已采到就渲染:CPU 是增量计算,头几个采样周期必然没有值,
    // 之前只认 CPU 会导致"CPU 读不到但内存正常"时状态栏永久停在转圈态。
    if (state === 'loading' || (cpuPercent === undefined && memPercent === undefined)) {
      this.showLoading();
      return;
    }

    const showCpu = config.statusBarMetrics.includes('cpu');
    const showMem = config.statusBarMetrics.includes('memory');
    // 多块盘时状态栏只放"最满的一块"——盘符命名千奇百怪,与其在状态栏挤一行放不下,
    // 不如让最该关注的那个数字常驻,完整列表在 tooltip 和趋势面板里。
    const fullestDisk = snapshot.disks && snapshot.disks.length > 0
      ? snapshot.disks.reduce((a, b) => (b.percent > a.percent ? b : a))
      : undefined;
    const showDisk = config.statusBarMetrics.includes('disk') && fullestDisk !== undefined;
    // 多张 GPU 时只取第一张(nvidia-smi 返回顺序里的 GPU 0)做状态栏摘要——状态栏容不下
    // 每张卡各一行,完整的每卡利用率/显存/温度仍然在趋势面板里能看到。
    const primaryGpu = snapshot.gpus?.[0];
    const showGpu = config.statusBarMetrics.includes('gpu') && primaryGpu !== undefined;
    // 网络吞吐没有 0-100% 语义,套用 CPU/内存那套告警阈值没有意义,所以网络项永远不参与告警配色,
    // 只要 config 打开且已经采集到至少一次速率(收发都是 0 也算"采集到了",不代表没网络)就显示。
    const showNetwork = config.statusBarMetrics.includes('network') && snapshot.network !== undefined;

    const cpuLevel = cpuPercent !== undefined ? calcAlertLevel(cpuPercent, config.warningThreshold, config.criticalThreshold) : 'normal';
    const memLevel = memPercent !== undefined ? calcAlertLevel(memPercent, config.warningThreshold, config.criticalThreshold) : 'normal';
    const diskLevel = fullestDisk !== undefined ? calcAlertLevel(fullestDisk.percent, config.warningThreshold, config.criticalThreshold) : 'normal';
    const gpuLevel = primaryGpu !== undefined ? calcAlertLevel(primaryGpu.utilizationPercent, config.warningThreshold, config.criticalThreshold) : 'normal';
    // 图标只反映用户实际勾选展示的那些指标——隐藏掉的指标即使越阈值,也不该影响图标颜色。
    const consideredLevels: AlertLevel[] = [];
    if (showCpu) {
      consideredLevels.push(cpuLevel);
    }
    if (showMem) {
      consideredLevels.push(memLevel);
    }
    if (showDisk) {
      consideredLevels.push(diskLevel);
    }
    if (showGpu) {
      consideredLevels.push(gpuLevel);
    }
    const overallLevel = maxAlertLevel(...consideredLevels);

    this.iconItem.text = overallLevel === 'critical' ? CRITICAL_ICON : NORMAL_ICON;
    this.iconItem.color = foregroundFor(overallLevel);
    this.iconItem.backgroundColor = backgroundFor(overallLevel);
    this.iconItem.tooltip = tooltipLines([
      `$(pulse) **Remote Pulse** — ${this.ctx.hostLabel}`,
      vscode.l10n.t('Click to configure status bar metrics'),
    ]);
    this.iconItem.show();

    if (showCpu && cpuPercent !== undefined) {
      this.cpuItem.text = `CPU ${pct(cpuPercent)}`;
      this.cpuItem.color = foregroundFor(cpuLevel);
      this.cpuItem.backgroundColor = backgroundFor(cpuLevel);
      this.cpuItem.tooltip = this.cpuTooltip(snapshot);
      this.cpuItem.show();
      this.cpuVisible = true;
    } else {
      this.cpuItem.hide();
      this.cpuVisible = false;
    }

    if (showMem && memPercent !== undefined) {
      this.memItem.text = `MEM ${pct(memPercent)}`;
      this.memItem.color = foregroundFor(memLevel);
      this.memItem.backgroundColor = backgroundFor(memLevel);
      this.memItem.tooltip = this.memoryTooltip(snapshot);
      this.memItem.show();
      this.memVisible = true;
    } else {
      this.memItem.hide();
      this.memVisible = false;
    }

    if (showDisk && fullestDisk) {
      this.diskItem.text = `DISK ${pct(fullestDisk.percent)}`;
      this.diskItem.color = foregroundFor(diskLevel);
      this.diskItem.backgroundColor = backgroundFor(diskLevel);
      this.diskItem.tooltip = this.diskTooltip(snapshot);
      this.diskItem.show();
      this.diskVisible = true;
    } else {
      this.diskItem.hide();
      this.diskVisible = false;
    }

    if (showGpu && primaryGpu) {
      this.gpuItem.text = `GPU ${pct(primaryGpu.utilizationPercent)}`;
      this.gpuItem.color = foregroundFor(gpuLevel);
      this.gpuItem.backgroundColor = backgroundFor(gpuLevel);
      this.gpuItem.tooltip = this.gpuTooltip(snapshot);
      this.gpuItem.show();
      this.gpuVisible = true;
    } else {
      this.gpuItem.hide();
      this.gpuVisible = false;
    }

    if (showNetwork && snapshot.network) {
      // 合并成一个数字看不出是上传还是下载,分开标 $(arrow-down)/$(arrow-up) 才对得上"网速"这个直觉。
      // 定宽右对齐:速率数字宽度每轮都在变,不补齐会让状态栏图标横向抖动。
      this.networkItem.text = `$(arrow-down) ${formatRateFixed(snapshot.network.rxRate)} $(arrow-up) ${formatRateFixed(snapshot.network.txRate)}`;
      this.networkItem.color = undefined;
      this.networkItem.backgroundColor = undefined;
      this.networkItem.tooltip = this.networkTooltip();
      this.networkItem.show();
      this.networkVisible = true;
    } else {
      this.networkItem.hide();
      this.networkVisible = false;
    }
  }

  private cpuTooltip(snapshot: Snapshot): vscode.MarkdownString {
    const lines = [trendBlock('CPU', this.recent(s => s.cpu?.percent), pct(snapshot.cpu?.percent ?? 0))];
    if (snapshot.cpu) {
      lines.push(vscode.l10n.t('{0} cores', snapshot.cpu.cores));
    }
    return this.metricTooltip(lines);
  }

  private memoryTooltip(snapshot: Snapshot): vscode.MarkdownString {
    const lines = [trendBlock(vscode.l10n.t('Memory'), this.recent(s => s.memory?.percent), pct(snapshot.memory?.percent ?? 0))];
    if (snapshot.memory) {
      lines.push(`${formatBytes(snapshot.memory.used)} / ${formatBytes(snapshot.memory.total)}`);
    }
    return this.metricTooltip(lines);
  }

  private diskTooltip(snapshot: Snapshot): vscode.MarkdownString {
    const rows = (snapshot.disks ?? [])
      .slice(0, 8)
      .map(d => `\`${renderMiniBar(d.percent)}\` ${d.mountPoint} ${Math.round(d.percent)}% (${formatBytes(d.used)} / ${formatBytes(d.total)})`);
    return this.metricTooltip([rows.length ? rows.join('\n\n') : vscode.l10n.t('No disk data collected yet')]);
  }

  private gpuTooltip(snapshot: Snapshot): vscode.MarkdownString {
    const rows = (snapshot.gpus ?? []).map(g => {
      const vram = g.memoryTotalMb > 0 ? ` · ${Math.round((g.memoryUsedMb / g.memoryTotalMb) * 100)}% ${vscode.l10n.t('VRAM')}` : '';
      return `**GPU ${g.index}** ${g.name ?? ''}\n\n\`util ${Math.round(g.utilizationPercent)}% · ${g.temperatureC} °C\`${vram}`;
    });
    return this.metricTooltip(rows.length ? rows : [vscode.l10n.t('No GPU data collected yet')]);
  }

  private networkTooltip(): vscode.MarkdownString {
    return this.metricTooltip([
      trendBlock(`$(arrow-down) ${vscode.l10n.t('Download')}`, this.recent(s => s.network?.rxRate), '', 0, this.recentNetworkPeak()),
      trendBlock(`$(arrow-up) ${vscode.l10n.t('Upload')}`, this.recent(s => s.network?.txRate), '', 0, this.recentNetworkPeak()),
    ]);
  }

  private recentNetworkPeak(): number {
    const values = [...this.recent(s => s.network?.rxRate), ...this.recent(s => s.network?.txRate)];
    return Math.max(1024 * 1024, ...values);
  }

  private recent(pick: (s: Snapshot) => number | undefined): number[] {
    return this.ctx.history(TOOLTIP_TREND_WINDOW_MS, pick);
  }

  private metricTooltip(lines: string[]): vscode.MarkdownString {
    return tooltipLines([...lines, vscode.l10n.t('Click to open the trend panel')]);
  }

  /** 仅供集成测试读取当前渲染状态用,不做其他用途。 */
  get debugState(): {
    icon: StatusBarItemDebugState;
    cpu: StatusBarItemDebugState;
    mem: StatusBarItemDebugState;
    disk: StatusBarItemDebugState;
    gpu: StatusBarItemDebugState;
    network: StatusBarItemDebugState;
  } {
    return {
      icon: { ...debugStateOf(this.iconItem), visible: true },
      cpu: { ...debugStateOf(this.cpuItem), visible: this.cpuVisible },
      mem: { ...debugStateOf(this.memItem), visible: this.memVisible },
      disk: { ...debugStateOf(this.diskItem), visible: this.diskVisible },
      gpu: { ...debugStateOf(this.gpuItem), visible: this.gpuVisible },
      network: { ...debugStateOf(this.networkItem), visible: this.networkVisible },
    };
  }

  dispose(): void {
    this.iconItem.dispose();
    this.cpuItem.dispose();
    this.memItem.dispose();
    this.diskItem.dispose();
    this.gpuItem.dispose();
    this.networkItem.dispose();
  }
}

/** 两位整数 + 前置空格补齐,个位数和两位数等宽,避免刷新时图标横向抖动。 */
function pct(percent: number): string {
  return `${String(Math.round(percent)).padStart(2, ' ')}%`;
}

/** tooltip 里的磁盘小进度条:宽度只有 10 格,不需要等宽字体对齐也能读。 */
function renderMiniBar(percent: number): string {
  const clamped = Math.max(0, Math.min(10, Math.round(percent / 10)));
  return `${'█'.repeat(clamped)}${'░'.repeat(10 - clamped)}`;
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
