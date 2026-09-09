import * as vscode from 'vscode';
import { AlertLevel, CpuStats, DiskStats, DockerStats, GpuStats, MemoryStats, NetworkRate } from '../types';
import { calcAlertLevel } from '../store/statsStore';
import { formatBytes, formatRate, formatUptime } from '../util/sparkline';
import { configureStatusBarMetrics, configureTrendPanelSections, configureTrendChartMetrics } from '../config';

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i += 1) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

export interface TrendSeries {
  /** 与其余数组一一对应的 epoch ms,悬浮提示要靠它算出该点的具体时间。 */
  timestamps: number[];
  /** 每条线是否出现由 remotePulse.trendChartMetrics 独立控制,和"System"信息行/GPU 详情区块是否显示是两码事——
   * 所以这里全部是可选数组,undefined 就是"这条线没被勾选,不画"。 */
  cpu?: number[];
  memory?: number[];
  /**
   * rx+tx 之和,单位 B/s,原始值不做归一化——网络速率没有 CPU/内存那种天然的 0-100% 上限,
   * 画图时走独立的右侧 y 轴(自己的量纲),而不是硬挤进 CPU/内存共用的百分比左轴。
   */
  network?: number[];
  /** 只取第一张 GPU(和状态栏摘要同一个"主卡"约定),多卡详情仍然只在 GPU 详情区块里能看到。 */
  gpu?: number[];
}

export interface TrendLatest {
  cpu?: CpuStats;
  memory?: MemoryStats;
  disks: DiskStats[];
  network?: NetworkRate;
  gpus: GpuStats[];
  docker?: DockerStats;
  uptimeSeconds?: number;
}

export interface TrendPayload {
  series: TrendSeries;
  latest?: TrendLatest;
  thresholds: { warning: number; critical: number };
}

/** 远程主机的身份信息。user / addresses 在受限环境下可能取不到,所以都是可选的。 */
export interface HostInfo {
  label: string;
  user?: string;
  /** 全部非内网 IPv4,按网卡列出——多网卡机器(WSL 的 eth0 + docker0)只看一个地址是不够的。 */
  addresses?: { iface: string; address: string }[];
}

/**
 * 面板渲染模型:取值、单位换算、本地化全部在扩展侧完成,webview 只按模型建 DOM。
 * 这样 webview 里不出现任何字符串拼接的 HTML,主机名/挂载点/GPU 型号/容器名即使
 * 含尖括号也只会作为 textContent 出现,天然没有注入面。
 */
interface MetricRow {
  label: string;
  detail: string;
  value: string;
  /** 有百分比才画进度条;温度、速率这类没有 0-100 语义的指标不画。 */
  percent?: number;
  level: AlertLevel;
  /** 子行(GPU 各项指标):缩进 16px 并收窄标签列,让进度条与数值仍落在同一条右边线上。 */
  sub?: boolean;
  strong?: boolean;
}

interface ChartLegendItem {
  /** 客户端靠这个 key(而不是数组下标)去 SERIES_DEFS 里找颜色/className——
   * 一旦某条线可以被单独勾掉,"第 i 个图例对应第 i 个预定义线"这个位置假设就不成立了。 */
  key: 'cpu' | 'memory' | 'network' | 'gpu';
  name: string;
  /** 最新一次采集的即时值,和图表末端的圆点是同一个数,不随悬浮变化。 */
  value?: string;
}

type PanelGroup =
  | { kind: 'metrics'; title: string; badge?: string; rows: MetricRow[] }
  | { kind: 'chart'; title: string; legend: ChartLegendItem[]; emptyHint: string }
  | { kind: 'table'; title: string; badge?: string; columns: [string, string]; rows: [string, string, string][]; emptyHint?: string };

interface PanelModel {
  host: { name: string; meta: string; user?: string };
  updated: string;
  settingsLabel: string;
  groups: PanelGroup[];
  series: { timestamps: number[]; cpu?: number[]; memory?: number[]; network?: number[]; gpu?: number[] };
}

/**
 * 齿轮按钮点的是"设置入口"而不是"直接跳设置页"——两个数组配置(状态栏指标/趋势面板板块)
 * 在原生 Settings UI 里只有列表编辑器,不是一次性打勾的体验,所以把两个配置向导命令放在
 * 菜单最前面,"打开设置(JSON/UI)"作为兜底选项留在最后。
 */
async function showSettingsMenu(): Promise<void> {
  type Choice = { label: string; action: 'statusBar' | 'trendPanel' | 'trendChart' | 'settings' };
  const items: Choice[] = [
    { label: `$(checklist) ${vscode.l10n.t('Configure Status Bar Metrics…')}`, action: 'statusBar' },
    { label: `$(checklist) ${vscode.l10n.t('Configure Trend Panel Sections…')}`, action: 'trendPanel' },
    { label: `$(checklist) ${vscode.l10n.t('Configure Trend Chart Metrics…')}`, action: 'trendChart' },
    { label: `$(settings-gear) ${vscode.l10n.t('Open Settings (JSON/UI)')}`, action: 'settings' },
  ];
  const picked = await vscode.window.showQuickPick(items, { placeHolder: vscode.l10n.t('Remote Pulse Settings') });
  if (!picked) {
    return;
  }
  if (picked.action === 'statusBar') {
    await configureStatusBarMetrics();
  } else if (picked.action === 'trendPanel') {
    await configureTrendPanelSections();
  } else if (picked.action === 'trendChart') {
    await configureTrendChartMetrics();
  } else {
    await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:tanzz.remote-pulse');
  }
}

/**
 * 趋势面板按需创建、按需销毁,不常驻内存(retainContextWhenHidden: false)。
 *
 * 外壳 HTML 只在创建时写一次,之后每轮采集用 postMessage 推数据、由 webview 就地改 DOM。
 * 早先的实现每次刷新都重设 webview.html,等价于整页重载——2 秒一次的闪烁、滚动位置
 * 和文字选中都会被清掉,面板越长越明显。
 */
export class TrendPanel {
  private static current: TrendPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  /** webview 被隐藏后会被销毁,再次显示时脚本重新加载并索要数据,这里留着最后一份。 */
  private lastModel: PanelModel | undefined;

  static createOrShow(host: HostInfo, payload: TrendPayload): void {
    if (TrendPanel.current) {
      TrendPanel.current.panel.reveal();
      TrendPanel.current.update(host, payload);
      return;
    }
    TrendPanel.current = new TrendPanel(host, payload);
  }

  static isOpen(): boolean {
    return TrendPanel.current !== undefined;
  }

  static refreshIfOpen(host: HostInfo, payload: TrendPayload): void {
    TrendPanel.current?.update(host, payload);
  }

  private constructor(host: HostInfo, payload: TrendPayload) {
    this.panel = vscode.window.createWebviewPanel('remotePulseTrend', vscode.l10n.t('Remote Pulse Trend'), vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: false,
    });
    this.panel.title = `Remote Pulse — ${host.label}`;
    this.panel.webview.html = this.renderShell();
    this.panel.webview.onDidReceiveMessage(
      message => {
        if (message?.type === 'ready' && this.lastModel) {
          void this.panel.webview.postMessage({ type: 'model', model: this.lastModel });
        } else if (message?.type === 'openSettings') {
          void showSettingsMenu();
        }
      },
      null,
      this.disposables,
    );
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.update(host, payload);
  }

  private update(host: HostInfo, payload: TrendPayload): void {
    this.panel.title = `Remote Pulse — ${host.label}`;
    this.lastModel = buildModel(host, payload);
    void this.panel.webview.postMessage({ type: 'model', model: this.lastModel });
  }

  private renderShell(): string {
    const csp = this.panel.webview.cspSource;
    const n = nonce();

    return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${n}';" />
  <title>${vscode.l10n.t('Remote Pulse Trend')}</title>
  <style>${PANEL_CSS}</style>
</head>
<body>
  <div id="root" class="panel"></div>
  <script nonce="${n}">${PANEL_SCRIPT}</script>
</body>
</html>`;
  }

  private dispose(): void {
    TrendPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}

/** "host [WSL:distro] (10.0.0.2)" → 主名 + 弱化的 IP,IP 缺失时整串当主名。 */
function splitHostLabel(hostLabel: string): { name: string; meta: string } {
  const match = /^(.*?)\s*\(([^()]*)\)$/.exec(hostLabel);
  return match ? { name: match[1], meta: match[2] } : { name: hostLabel, meta: '' };
}

function buildModel(host: HostInfo, payload: TrendPayload): PanelModel {
  const { series, latest, thresholds } = payload;
  const levelOf = (percent: number): AlertLevel => calcAlertLevel(percent, thresholds.warning, thresholds.critical);
  const groups: PanelGroup[] = [];

  const system: MetricRow[] = [];
  if (latest?.cpu) {
    system.push({
      label: 'CPU',
      detail: vscode.l10n.t('{0} cores', latest.cpu.cores),
      value: `${Math.round(latest.cpu.percent)}%`,
      percent: latest.cpu.percent,
      level: levelOf(latest.cpu.percent),
    });
  }
  if (latest?.memory) {
    system.push({
      label: vscode.l10n.t('Memory'),
      detail: `${formatBytes(latest.memory.used)} / ${formatBytes(latest.memory.total)}`,
      value: `${Math.round(latest.memory.percent)}%`,
      percent: latest.memory.percent,
      level: levelOf(latest.memory.percent),
    });
  }
  if (latest?.network) {
    system.push({
      label: vscode.l10n.t('Network'),
      detail: '',
      // HTML 会把连续空格折叠成一个,用 em space 才能保住上下行速率之间的视觉间隔。
      value: `↓ ${formatRate(latest.network.rxRate)}  ↑ ${formatRate(latest.network.txRate)}`,
      level: 'normal',
    });
  }
  if (latest?.uptimeSeconds !== undefined) {
    system.push({ label: vscode.l10n.t('Uptime'), detail: '', value: formatUptime(latest.uptimeSeconds), level: 'normal' });
  }
  // 每张网卡一行:标签就是网卡名,地址在数值列,和其余指标落在同一条右边线上。
  for (const { iface, address } of host.addresses ?? []) {
    system.push({ label: iface, detail: '', value: address, level: 'normal' });
  }
  if (system.length) {
    groups.push({ kind: 'metrics', title: vscode.l10n.t('System'), rows: system });
  }

  // 图例的"当前值"直接取 series 数组的最后一个点,而不是另外查 latest.* ——这样图例
  // 完全由 trendChartMetrics 驱动,不会因为"System"信息行/GPU 详情区块各自的显示开关
  // (trendPanelSections)而跟着变化,两套配置才能真正互不影响地独立生效。
  const lastOf = (values?: number[]): number | undefined => (values && values.length ? values[values.length - 1] : undefined);
  // 图例顺序就是图表画线的顺序(cpu, memory, gpu, 再 network)——PANEL_SCRIPT 按 legend 里的
  // key(而不是数组下标)去匹配预定义的颜色/className,顺序只影响图例文字的先后和线的叠放层次。
  const legend: ChartLegendItem[] = [];
  if (series.cpu) {
    const value = lastOf(series.cpu);
    legend.push({ key: 'cpu', name: 'CPU', value: value !== undefined ? `${Math.round(value)}%` : undefined });
  }
  if (series.memory) {
    const value = lastOf(series.memory);
    legend.push({ key: 'memory', name: vscode.l10n.t('Memory'), value: value !== undefined ? `${Math.round(value)}%` : undefined });
  }
  if (series.gpu) {
    const value = lastOf(series.gpu);
    legend.push({ key: 'gpu', name: 'GPU', value: value !== undefined ? `${Math.round(value)}%` : undefined });
  }
  if (series.network) {
    const value = lastOf(series.network);
    legend.push({ key: 'network', name: vscode.l10n.t('Network'), value: value !== undefined ? formatRate(value) : undefined });
  }
  groups.push({
    kind: 'chart',
    title: vscode.l10n.t('past 30 minutes'),
    legend,
    emptyHint: vscode.l10n.t('Not enough history data yet. Please wait a few seconds and reopen.'),
  });

  const disks = latest?.disks ?? [];
  if (disks.length) {
    groups.push({
      kind: 'metrics',
      title: vscode.l10n.t('Storage'),
      rows: disks.map(disk => ({
        label: disk.mountPoint,
        detail: `${formatBytes(disk.used)} / ${formatBytes(disk.total)}`,
        value: `${Math.round(disk.percent)}%`,
        percent: disk.percent,
        level: levelOf(disk.percent),
      })),
    });
  }

  const gpus = latest?.gpus ?? [];
  if (gpus.length) {
    const rows: MetricRow[] = [];
    for (const gpu of gpus) {
      const vramPercent = gpu.memoryTotalMb > 0 ? (gpu.memoryUsedMb / gpu.memoryTotalMb) * 100 : 0;
      rows.push({ label: `GPU ${gpu.index}`, detail: gpu.name ?? '', value: '', level: 'normal', strong: true });
      rows.push({
        label: vscode.l10n.t('Utilization'),
        detail: '',
        value: `${Math.round(gpu.utilizationPercent)}%`,
        percent: gpu.utilizationPercent,
        level: levelOf(gpu.utilizationPercent),
        sub: true,
      });
      rows.push({
        label: vscode.l10n.t('VRAM'),
        detail: `${formatBytes(gpu.memoryUsedMb * 1024 * 1024)} / ${formatBytes(gpu.memoryTotalMb * 1024 * 1024)}`,
        value: `${Math.round(vramPercent)}%`,
        percent: vramPercent,
        level: levelOf(vramPercent),
        sub: true,
      });
      rows.push({
        label: vscode.l10n.t('Temp'),
        detail: '',
        value: `${gpu.temperatureC} °C`,
        level: levelOf(gpu.temperatureC),
        sub: true,
      });
    }
    groups.push({ kind: 'metrics', title: 'GPU', rows });
  }

  if (latest?.docker) {
    groups.push({
      kind: 'table',
      title: 'Docker',
      badge: String(latest.docker.containerCount),
      columns: ['CPU', vscode.l10n.t('Memory')],
      rows: latest.docker.containers.map(c => [c.name, `${c.cpuPercent.toFixed(1)}%`, formatBytes(c.memoryUsedBytes)] as [string, string, string]),
      emptyHint: vscode.l10n.t('No containers running'),
    });
  }

  const updatedAt = new Intl.DateTimeFormat(vscode.env.language, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date());

  return {
    host: { ...splitHostLabel(host.label), user: host.user },
    updated: vscode.l10n.t('Updated {0}', updatedAt),
    settingsLabel: vscode.l10n.t('Remote Pulse Settings'),
    groups,
    series: {
      timestamps: series.timestamps,
      cpu: series.cpu,
      memory: series.memory,
      network: series.network,
      gpu: series.gpu,
    },
  };
}

/**
 * 全部取值来自 --vscode-* 主题变量,面板因此跟随用户当前主题(含浅色/高对比度)。
 * 正常态刻意不上色——灰色是 VS Code 里"静止"的语言,颜色只用来表示越过阈值。
 */
const PANEL_CSS = `
  * { box-sizing: border-box; }
  :root {
    --rp-muted: var(--vscode-descriptionForeground);
    --rp-hairline: var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
    --rp-track: rgba(128, 128, 128, 0.25);
    --rp-warning: var(--vscode-editorWarning-foreground, #cca700);
    --rp-critical: var(--vscode-editorError-foreground, #f14c4c);
    --rp-cpu: var(--vscode-charts-blue, #3794ff);
    --rp-mem: var(--vscode-charts-purple, #b180d7);
    --rp-net: var(--vscode-charts-green, #89d185);
    --rp-gpu: var(--vscode-charts-orange, #d18616);
  }
  body {
    margin: 0;
    background: var(--vscode-editor-background);
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
    line-height: 20px;
  }
  /* 超宽窗口里一行从最左标签跑到最右数值,眼睛要横扫整屏才能读完一条——
     限宽居中是 VS Code 设置页同样的处理,读起来才不费劲。 */
  .panel { padding: 16px 20px 28px; max-width: 980px; margin: 0 auto; }

  /* 三级层级:主机名 15px 实心 > 区块标题 11px 大写加分隔线 > 行内容 13px。
     区块标题靠"大写 + 满宽细线 + 上方留白"确立边界,而不是靠字号压过正文。 */
  .host { display: flex; align-items: baseline; justify-content: space-between; gap: 4px 16px; flex-wrap: wrap;
          padding-bottom: 14px; border-bottom: 1px solid var(--rp-hairline); }
  .host-id { display: flex; align-items: baseline; gap: 8px; min-width: 0; flex: 1 1 auto; }
  .host-icon { align-self: center; flex-shrink: 0; }
  .host-name { font-size: 15px; font-weight: 600; line-height: 22px; min-width: 0;
               white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .host-meta { font-size: 11px; line-height: 16px; color: var(--rp-muted); min-width: 0;
               white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .host-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
  .icon-btn { display: flex; align-items: center; justify-content: center; width: 22px; height: 22px;
              padding: 0; border: none; border-radius: 4px; background: transparent; color: var(--rp-muted);
              cursor: pointer; }
  .icon-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.25));
                     color: var(--vscode-foreground); }
  .icon-btn:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }

  .section { margin-top: 26px; }
  .section-head { display: flex; align-items: center; gap: 8px; min-height: 20px;
                  padding-bottom: 7px; border-bottom: 1px solid var(--rp-hairline); }
  .section-title { font-size: 11px; font-weight: 700; line-height: 16px; letter-spacing: 0.09em;
                   text-transform: uppercase; color: var(--vscode-foreground); }
  .badge { margin-left: auto; font-size: 11px; line-height: 16px; padding: 0 6px; border-radius: 8px;
           background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .rows { display: flex; flex-direction: column; margin-top: 7px; }

  /* 一套栅格贯穿所有区块:标签 | 明细 | 进度条 | 数值。
     标签列用 fr 而不是固定 88px:挂载点路径(/usr/lib/wsl/drivers)在固定列里必然被截断,
     而富余宽度全被明细列白白吃掉。fr 在各行之间解析结果一致,所以列仍然对齐。
     minmax 的下限保证窄栏不塌,上限让标签优先拿到多出来的空间。 */
  .row { display: grid; grid-template-columns: minmax(84px, 1.5fr) minmax(0, 1fr) minmax(132px, 0.8fr) 46px;
         align-items: center; gap: 12px; height: 22px; }
  .row.sub { grid-template-columns: minmax(68px, 1.5fr) minmax(0, 1fr) minmax(132px, 0.8fr) 46px; padding-left: 16px; }
  .row.wide { grid-template-columns: minmax(84px, 1.5fr) minmax(0, 1fr) auto; }
  .row.sub.wide { grid-template-columns: minmax(68px, 1.5fr) minmax(0, 1fr) auto; }
  .row-label { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .row.sub .row-label { font-size: 11px; color: var(--rp-muted); }
  .row.strong .row-label { font-weight: 600; }
  .row-detail { font-size: 11px; color: var(--rp-muted); min-width: 0; text-align: right;
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .row-value { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .track { display: block; height: 4px; border-radius: 2px; background: var(--rp-track); overflow: hidden; }
  .fill { display: block; height: 100%; border-radius: 2px; background: var(--vscode-foreground); opacity: 0.5; }
  .warning .fill { background: var(--rp-warning); opacity: 1; }
  .critical .fill { background: var(--rp-critical); opacity: 1; }
  .warning .row-value { color: var(--rp-warning); }
  .critical .row-value { color: var(--rp-critical); }

  .trow { display: grid; grid-template-columns: minmax(0, 1fr) 96px 96px; align-items: center; gap: 12px; height: 22px; }
  .trow.head { font-size: 11px; line-height: 16px; letter-spacing: 0.04em; text-transform: uppercase;
               color: var(--rp-muted); height: 20px; }
  .trow span:not(:first-child) { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .trow span:first-child { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .legend { display: flex; align-items: center; gap: 14px; margin-left: auto;
            font-size: 11px; line-height: 16px; color: var(--rp-muted); }
  .legend-item { display: flex; align-items: center; gap: 5px; }
  .legend-value { color: var(--vscode-foreground); font-variant-numeric: tabular-nums; }
  .swatch { width: 8px; height: 2px; border-radius: 1px; flex-shrink: 0; }
  /* 悬浮提示是绝对定位在图表上的浮层,包裹容器要立坐标系。 */
  .chart-wrap { position: relative; margin-top: 4px; }
  .chart { display: block; width: 100%; cursor: crosshair; }
  .chart .grid { stroke: var(--rp-hairline); stroke-width: 1; }
  .chart .axis { fill: var(--rp-muted); font-size: 11px; }
  .chart .cpu { fill: none; stroke: var(--rp-cpu); stroke-width: 1.5; stroke-linejoin: round; stroke-linecap: round; }
  .chart .mem { fill: none; stroke: var(--rp-mem); stroke-width: 1.5; stroke-linejoin: round; stroke-linecap: round; }
  .chart .gpu { fill: none; stroke: var(--rp-gpu); stroke-width: 1.5; stroke-linejoin: round; stroke-linecap: round; }
  .chart .net { fill: none; stroke: var(--rp-net); stroke-width: 1.5; stroke-linejoin: round; stroke-linecap: round; }
  .chart .guide { stroke: var(--rp-muted); stroke-width: 1; stroke-dasharray: 2 2; opacity: 0; pointer-events: none; }
  .chart .hover-dot { opacity: 0; pointer-events: none; }
  .hint { font-size: 11px; line-height: 16px; color: var(--rp-muted); margin: 6px 0 0; }

  /* VS Code 的 hover widget token——用同一套语义色,浮层才像"原生弹出",不是自造的卡片。 */
  .chart-tooltip {
    position: absolute; z-index: 1; top: 0; left: 0;
    display: none; flex-direction: column; gap: 2px;
    padding: 6px 8px; border-radius: 3px; white-space: nowrap; pointer-events: none;
    font-size: 11px; line-height: 16px;
    background: var(--vscode-editorHoverWidget-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-editorHoverWidget-border, var(--rp-hairline));
    color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
  }
  .chart-tooltip .time { color: var(--rp-muted); }
  .chart-tooltip .metric { display: flex; align-items: center; gap: 6px; }
  .chart-tooltip .metric .swatch { width: 6px; height: 6px; border-radius: 50%; }
  .chart-tooltip .metric .value { margin-left: auto; font-variant-numeric: tabular-nums; }

  /* 面板常以 ViewColumn.Beside 打开,窄栏是常态:进度条改占整行,信息一条不丢。 */
  @media (max-width: 520px) {
    .panel { padding: 14px 12px 24px; }
    .row, .row.sub, .row.wide, .row.sub.wide {
      display: grid; grid-template-columns: minmax(0, auto) minmax(0, 1fr) 46px;
      grid-template-areas: "label detail value" "bar bar bar";
      height: auto; padding: 1px 0 5px; gap: 2px 8px; align-items: baseline;
    }
    /* 无进度条的行(网络速率、运行时长、温度)数值本身就长,不能挤进 44px 的数值列。 */
    .row.wide, .row.sub.wide { grid-template-columns: minmax(0, auto) minmax(0, 1fr) auto; }
    .row.sub { padding-left: 12px; }
    .row-label { grid-area: label; }
    .row-detail { grid-area: detail; text-align: right; }
    .row-value { grid-area: value; }
    .track { grid-area: bar; margin-top: 2px; }
    .trow { grid-template-columns: minmax(0, 1fr) 60px 72px; gap: 8px; }
    /* 图例现在带着"CPU 61%"这样的数值,窄栏里和标题挤不下,允许换到第二行。 */
    .section-head { flex-wrap: wrap; row-gap: 4px; }
    .legend { margin-left: 0; }
  }
`;

const PANEL_SCRIPT = `
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');
  let model = null;
  let shapeKey = '';
  let slots = [];
  let chartEl = null;
  let chartHint = null;
  let chartTooltip = null;
  /** cpu/memory/gpu/network 四条线各自的颜色/className——remotePulse.trendChartMetrics 决定实际画哪几条,
      chartActiveDefs 按 key 而不是数组下标去这里查,顺序无关。 */
  var SERIES_DEFS = [
    { key: 'cpu', colorVar: 'var(--rp-cpu)', className: 'cpu' },
    { key: 'memory', colorVar: 'var(--rp-mem)', className: 'mem' },
    { key: 'gpu', colorVar: 'var(--rp-gpu)', className: 'gpu' },
    { key: 'network', colorVar: 'var(--rp-net)', className: 'net' },
  ];
  let chartActiveDefs = SERIES_DEFS.slice(0, 2);
  /** 悬浮态跨轮询保留:每 2 秒的重绘会重建折线和圆点,如果不在重绘后把悬浮指示器按住原位置
      重新画一次,鼠标不动也会看到它每 2 秒闪一下。 */
  let chartGuide = null;
  let chartDots = [];
  let hovering = false;
  let lastPointerClientX = 0;
  let lastPointerClientY = 0;
  /** 当前这一屏折线对应的原始数据,悬浮时按屏幕 x 坐标反查最近的点。 */
  let chartData = null;

  const SVG_NS = 'http://www.w3.org/2000/svg';

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  /** 挂载点、GPU 型号、容器名都可能被 ellipsis 截断——同步写 title,悬浮才看得到全名。 */
  function setText(node, text) {
    const value = text === undefined || text === null ? '' : String(text);
    if (node.textContent !== value) node.textContent = value;
    if (node.title !== value) node.title = value;
  }

  function svg(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const key of Object.keys(attrs || {})) node.setAttribute(key, String(attrs[key]));
    return node;
  }

  /** 悬浮提示/右侧轴标签里展示网络速率——和 src/util/sparkline.ts 的 formatRate 同一套算法。 */
  function formatRateJs(bytesPerSec) {
    if (!isFinite(bytesPerSec) || bytesPerSec < 0) return '0 B/s';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var value = bytesPerSec;
    var i = 0;
    while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
    return value.toFixed(i === 0 ? 0 : 1) + ' ' + units[i] + '/s';
  }

  /** 把窗口内的原始峰值撑到一个好看的刻度上限——按 1024 进制取整,这样轴标签显示出来才是
      整数的 KB/MB(比如 "2.0 MB/s"),跟 formatRateJs 的二进制单位对得上,不会出现 "1.9 MB/s"
      这种十进制取整后被二进制单位换算弄得不整的数。阶梯只到 10 会漏掉 10~1024 这一整段——
      比如峰值 878KB/s,除一次 1024 后 v=878,不满足 <=10 里任何一档,原逻辑会直接落到"10",
      算出来的上限(10KB)反而比峰值本身还小,把线整条顶穿画到轴外面,看着像那条线消失了。
      阶梯延伸到 1024 才能覆盖任意峰值。 */
  function niceMax(raw) {
    if (!isFinite(raw) || raw <= 0) return 1;
    var i = 0;
    var v = raw;
    while (v >= 1024 && i < 4) { v /= 1024; i++; }
    var steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1024];
    var niceFrac = 1024;
    for (var s = 0; s < steps.length; s++) {
      if (v <= steps[s]) { niceFrac = steps[s]; break; }
    }
    return niceFrac * Math.pow(1024, i);
  }

  // 之前这里画的是"圆圈 + 8 条从圆心向外的细直线",视觉上是个太阳/亮度图标而不是齿轮——
  // 关键是齿的内缘要和外圈圆环有重叠(齿从半径 4.4 起,环带是 [2.8, 5.2]),两者才会连成
  // 一个整体轮廓;之前齿的内缘在半径 5.2、环外缘只到 4.85,中间空了一圈缝,才会看着像太阳芒。
  function gearIcon() {
    const node = svg('svg', { width: 15, height: 15, viewBox: '0 0 16 16', 'aria-hidden': 'true' });
    for (let i = 0; i < 8; i++) {
      node.appendChild(svg('rect', {
        x: 6.9, y: 1.2, width: 2.2, height: 2.4, rx: 0.5,
        fill: 'currentColor', transform: 'rotate(' + (i * 45) + ' 8 8)',
      }));
    }
    node.appendChild(svg('circle', { cx: 8, cy: 8, r: 4, fill: 'none', stroke: 'currentColor', 'stroke-width': 2.4 }));
    node.appendChild(svg('circle', { cx: 8, cy: 8, r: 1.3, fill: 'none', stroke: 'currentColor', 'stroke-width': 0.9 }));
    return node;
  }

  /** 结构不变就只改文字和条宽,避免每 2 秒重建 DOM 打断用户的文字选中。 */
  function shapeOf(m) {
    return JSON.stringify(m.groups.map(function (g) {
      if (g.kind === 'metrics') return ['m', g.title, g.rows.map(function (r) { return [r.label, !!r.sub, !!r.strong, r.percent !== undefined]; })];
      if (g.kind === 'table') return ['t', g.title, g.rows.map(function (r) { return r[0]; })];
      // 比较的是 legend 的 key 序列而不是长度——中途切换哪几条线(哪怕数量不变,比如把 cpu
      // 换成 gpu)也必须触发整块重建,否则 chartActiveDefs 和图例项对不上,apply() 会拿旧
      // slot 去读新模型,读错位置或者干脆把 GPU 数据画成 CPU 的颜色。
      return ['c', g.title, g.legend.map(function (item) { return item.key; }).join(',')];
    })) + '|' + m.host.name + '|' + m.host.meta + '|' + (m.host.user || '');
  }

  function build(m) {
    slots = [];
    chartEl = null;
    chartHint = null;
    chartTooltip = null;
    chartGuide = null;
    chartDots = [];
    chartData = null;
    hovering = false;
    const frag = document.createDocumentFragment();

    const host = el('div', 'host');
    const id = el('div', 'host-id');
    const icon = svg('svg', { class: 'host-icon', width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' });
    icon.appendChild(svg('rect', { x: 2.5, y: 2.5, width: 11, height: 4.5, rx: 1, stroke: 'currentColor', 'stroke-width': 1.1 }));
    icon.appendChild(svg('rect', { x: 2.5, y: 9, width: 11, height: 4.5, rx: 1, stroke: 'currentColor', 'stroke-width': 1.1 }));
    icon.appendChild(svg('circle', { cx: 5, cy: 4.75, r: 0.9, fill: 'currentColor' }));
    icon.appendChild(svg('circle', { cx: 5, cy: 11.25, r: 0.9, fill: 'currentColor' }));
    id.appendChild(icon);
    // 远程主机的身份就是 user@host——和 ssh 里看到的一致,用户名不另起一行。
    const title = m.host.user ? m.host.user + '@' + m.host.name : m.host.name;
    const nameNode = el('span', 'host-name', title);
    nameNode.title = title;
    id.appendChild(nameNode);
    if (m.host.meta) {
      const meta = el('span', 'host-meta');
      setText(meta, m.host.meta);
      id.appendChild(meta);
    }
    host.appendChild(id);
    const actions = el('div', 'host-actions');
    const updated = el('span', 'host-meta', m.updated);
    actions.appendChild(updated);
    slots.push({ kind: 'updated', node: updated });
    const settingsBtn = document.createElement('button');
    settingsBtn.type = 'button';
    settingsBtn.className = 'icon-btn';
    settingsBtn.title = m.settingsLabel;
    settingsBtn.setAttribute('aria-label', m.settingsLabel);
    settingsBtn.appendChild(gearIcon());
    settingsBtn.addEventListener('click', function () { vscode.postMessage({ type: 'openSettings' }); });
    actions.appendChild(settingsBtn);
    host.appendChild(actions);
    frag.appendChild(host);

    for (const group of m.groups) {
      const section = el('div', 'section');
      const head = el('div', 'section-head');
      head.appendChild(el('span', 'section-title', group.title));

      if (group.kind === 'chart') {
        // 按 key 从 SERIES_DEFS 里找对应的颜色/className,而不是假设 legend 的第 i 项对应
        // SERIES_DEFS 的第 i 项——一旦某条线可以被单独勾掉,这个位置假设就不成立了。
        // 每次 build() 都拷贝一份新对象带上当前语言的 name,SERIES_DEFS 本身只提供 key/颜色这些不随语言变化的部分。
        chartActiveDefs = group.legend.map(function (item) {
          var def = SERIES_DEFS.filter(function (d) { return d.key === item.key; })[0];
          return { key: def.key, name: item.name, colorVar: def.colorVar, className: def.className };
        });
        const legend = el('span', 'legend');
        for (let i = 0; i < group.legend.length; i++) {
          const item = el('span', 'legend-item');
          const dot = el('span', 'swatch');
          dot.style.background = chartActiveDefs[i].colorVar;
          item.appendChild(dot);
          item.appendChild(document.createTextNode(group.legend[i].name));
          // 末端圆点旁边这个数才是真正的"当前值"——每轮采集都更新,不需要悬浮就看得到。
          const valueEl = el('span', 'legend-value', group.legend[i].value || '');
          item.appendChild(valueEl);
          legend.appendChild(item);
          slots.push({ kind: 'legend-value', node: valueEl });
        }
        head.appendChild(legend);
        section.appendChild(head);

        const chartWrap = el('div', 'chart-wrap');
        chartEl = svg('svg', { class: 'chart', preserveAspectRatio: 'none' });
        chartEl.addEventListener('pointermove', onChartPointerMove);
        chartEl.addEventListener('pointerleave', onChartPointerLeave);
        chartWrap.appendChild(chartEl);
        chartTooltip = el('div', 'chart-tooltip');
        chartWrap.appendChild(chartTooltip);
        section.appendChild(chartWrap);

        chartHint = el('p', 'hint', group.emptyHint);
        chartHint.hidden = true;
        section.appendChild(chartHint);
        frag.appendChild(section);
        continue;
      }

      if (group.badge !== undefined) head.appendChild(el('span', 'badge', group.badge));
      section.appendChild(head);
      const rows = el('div', 'rows');

      if (group.kind === 'metrics') {
        for (const row of group.rows) {
          const hasBar = row.percent !== undefined;
          let className = 'row';
          if (row.sub) className += ' sub';
          if (row.strong) className += ' strong';
          if (!hasBar) className += ' wide';
          const node = el('div', className);
          const label = el('span', 'row-label');
          setText(label, row.label);
          node.appendChild(label);
          const detail = el('span', 'row-detail');
          setText(detail, row.detail);
          node.appendChild(detail);
          let fill = null;
          if (hasBar) {
            const track = el('span', 'track');
            fill = el('span', 'fill');
            track.appendChild(fill);
            node.appendChild(track);
          }
          const value = el('span', 'row-value', row.value);
          node.appendChild(value);
          rows.appendChild(node);
          slots.push({ kind: 'row', node: node, detail: detail, value: value, fill: fill });
        }
      } else {
        const head2 = el('div', 'trow head');
        head2.appendChild(el('span', '', ''));
        head2.appendChild(el('span', '', group.columns[0]));
        head2.appendChild(el('span', '', group.columns[1]));
        rows.appendChild(head2);
        if (!group.rows.length && group.emptyHint) {
          rows.appendChild(el('p', 'hint', group.emptyHint));
        }
        for (const cells of group.rows) {
          const node = el('div', 'trow');
          const name = el('span', '');
          setText(name, cells[0]);
          const cpu = el('span', '', cells[1]);
          const mem = el('span', '', cells[2]);
          node.appendChild(name);
          node.appendChild(cpu);
          node.appendChild(mem);
          rows.appendChild(node);
          slots.push({ kind: 'cells', cpu: cpu, mem: mem });
        }
      }

      section.appendChild(rows);
      frag.appendChild(section);
    }

    root.replaceChildren(frag);
  }

  function apply(m) {
    let i = 0;
    slots[i++].node.textContent = m.updated;
    for (const group of m.groups) {
      if (group.kind === 'chart') {
        for (const item of group.legend) {
          const slot = slots[i++];
          slot.node.textContent = item.value || '';
        }
        continue;
      }
      if (group.kind === 'metrics') {
        for (const row of group.rows) {
          const slot = slots[i++];
          setText(slot.detail, row.detail);
          slot.value.textContent = row.value;
          slot.node.classList.toggle('warning', row.level === 'warning');
          slot.node.classList.toggle('critical', row.level === 'critical');
          if (slot.fill) slot.fill.style.width = Math.max(0, Math.min(100, row.percent)) + '%';
        }
      } else {
        for (const cells of group.rows) {
          const slot = slots[i++];
          slot.cpu.textContent = cells[1];
          slot.mem.textContent = cells[2];
        }
      }
    }
    drawChart(m.series);
  }

  /* 30 分钟 @ 2 秒 = 900 个采样点,直接画会在几百像素里挤成一条噪声带。
     每 ~3px 取一个桶的均值:曲线读得出走势,真实的负载起伏跨多个桶仍然看得见。
     timestamps 用同一个函数按同样的桶数降采样,才能和 cpu/memory 逐点对上——
     三个数组来自同一份原始快照,长度天生相等,桶的切法只取决于长度和目标点数。 */
  function downsample(values, maxPoints) {
    if (values.length <= maxPoints) return values;
    const out = [];
    const bucket = values.length / maxPoints;
    for (let i = 0; i < maxPoints; i++) {
      const from = Math.floor(i * bucket);
      const to = Math.max(from + 1, Math.min(values.length, Math.floor((i + 1) * bucket)));
      let sum = 0;
      for (let j = from; j < to; j++) sum += values[j];
      out.push(sum / (to - from));
    }
    return out;
  }

  function hideHover() {
    hovering = false;
    if (chartGuide) chartGuide.style.opacity = '0';
    for (const dot of chartDots) dot.style.opacity = '0';
    if (chartTooltip) chartTooltip.style.display = 'none';
  }

  /** CPU/内存是 0-100 的百分比;network 是原始 B/s,走右轴自己的量纲,两者都不需要互相换算。 */
  function formatSeriesValue(def, value) {
    if (def.key === 'network') {
      return formatRateJs(Math.max(0, value));
    }
    return Math.round(Math.max(0, Math.min(100, value))) + '%';
  }

  function renderTooltipContent(valuesAtIndex, timeMs) {
    chartTooltip.replaceChildren();
    const d = new Date(timeMs);
    chartTooltip.appendChild(el('div', 'time', isNaN(d.getTime()) ? '' : d.toLocaleTimeString()));

    function metricRow(colorVar, name, text) {
      const row = el('div', 'metric');
      const dot = el('span', 'swatch');
      dot.style.background = colorVar;
      row.appendChild(dot);
      row.appendChild(el('span', '', name));
      row.appendChild(el('span', 'value', text));
      return row;
    }
    for (let i = 0; i < chartActiveDefs.length; i++) {
      const def = chartActiveDefs[i];
      chartTooltip.appendChild(metricRow(def.colorVar, def.name, formatSeriesValue(def, valuesAtIndex[i])));
    }
  }

  /** clientX/clientY 是最近一次真实指针事件的坐标;重绘后用同一坐标重算,悬浮态才能跨轮询保留。 */
  function updateHoverAt(clientX, clientY) {
    if (!chartData || chartData.xs.length === 0 || !chartEl || !chartGuide) {
      hideHover();
      return;
    }
    const rect = chartEl.getBoundingClientRect();
    if (rect.width <= 0) return;
    const viewBoxWidth = chartEl.viewBox && chartEl.viewBox.baseVal ? chartEl.viewBox.baseVal.width : rect.width;
    const scale = viewBoxWidth / rect.width;
    const xUnits = (clientX - rect.left) * scale;

    let nearest = 0;
    let bestDist = Infinity;
    for (let idx = 0; idx < chartData.xs.length; idx++) {
      const dist = Math.abs(chartData.xs[idx] - xUnits);
      if (dist < bestDist) { bestDist = dist; nearest = idx; }
    }

    const x = chartData.xs[nearest];
    const valuesAtIndex = chartData.series.map(function (s) { return s.vals[nearest]; });
    let minY = Infinity;
    for (let i = 0; i < chartData.series.length; i++) {
      const y = toY(valuesAtIndex[i], chartData.series[i].domain, chartData.top, chartData.plotH);
      const dot = chartDots[i];
      dot.setAttribute('cx', x);
      dot.setAttribute('cy', y);
      dot.style.opacity = '1';
      if (y < minY) minY = y;
    }

    chartGuide.setAttribute('x1', x);
    chartGuide.setAttribute('x2', x);
    chartGuide.style.opacity = '1';

    renderTooltipContent(valuesAtIndex, chartData.times[nearest]);

    const wrap = chartEl.parentElement;
    const wrapRect = wrap.getBoundingClientRect();
    const offsetX = rect.left - wrapRect.left;
    const offsetY = rect.top - wrapRect.top;
    const pointLocalX = offsetX + x / scale;
    const pointLocalY = offsetY + minY / scale;

    chartTooltip.style.display = 'flex';
    const ttWidth = chartTooltip.offsetWidth;
    const ttHeight = chartTooltip.offsetHeight;
    let left = pointLocalX + 12;
    if (left + ttWidth > wrapRect.width) left = pointLocalX - ttWidth - 12;
    if (left < 0) left = 4;
    let top2 = pointLocalY - ttHeight - 10;
    if (top2 < 0) top2 = pointLocalY + 14;
    if (top2 + ttHeight > wrapRect.height) top2 = Math.max(0, wrapRect.height - ttHeight - 4);
    chartTooltip.style.left = left + 'px';
    chartTooltip.style.top = top2 + 'px';
  }

  function onChartPointerMove(event) {
    hovering = true;
    lastPointerClientX = event.clientX;
    lastPointerClientY = event.clientY;
    updateHoverAt(event.clientX, event.clientY);
  }

  function onChartPointerLeave() {
    hideHover();
  }

  function valuesFor(key, series) {
    if (key === 'cpu') return series.cpu || [];
    if (key === 'memory') return series.memory || [];
    if (key === 'gpu') return series.gpu || [];
    if (key === 'network') return series.network || [];
    return [];
  }

  /** cpu/memory/gpu 都是 0-100% 的左轴;network 走自己的右轴量纲(domain.max 由 niceMax() 决定)。 */
  function toY(value, domain, top, plotH) {
    const v = Math.max(domain.min, Math.min(domain.max, value));
    const range = domain.max - domain.min || 1;
    return top + (1 - (v - domain.min) / range) * plotH;
  }

  function drawChart(series) {
    if (!chartEl) return;
    // 哪几条线在画由 chartActiveDefs(源自 trendChartMetrics)决定,不再假设 cpu/memory 一定存在。
    const hasData = chartActiveDefs.some(function (def) { return valuesFor(def.key, series).length > 1; });
    chartHint.hidden = hasData;
    chartEl.hidden = !hasData;
    if (!hasData) {
      chartData = null;
      hideHover();
      return;
    }

    const narrow = window.innerWidth < 520;
    const gutter = narrow ? 42 : 44;
    const plotH = narrow ? 112 : 132;
    const top = 8;
    const width = Math.max(160, Math.round(chartEl.getBoundingClientRect().width));
    const height = top + plotH + 10;
    chartEl.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    chartEl.setAttribute('width', String(width));
    chartEl.setAttribute('height', String(height));
    chartEl.replaceChildren();

    // network 走独立的右侧 y 轴(自己的量纲,不是百分比)——右边多留出画刻度文字的空间;
    // 末端圆点的圆心如果落在视口边界上,半径里有一半会被裁掉,rightPad 同时兜住这个安全边距。
    const hasNetworkAxis = chartActiveDefs.some(function (def) { return def.key === 'network'; });
    const endDotRadius = 2.5;
    // 最长的右轴标签("1023.9 KB/s"这类进位前的边界值)在 11px 字号下量出来约 66px 宽,
    // 78 留了安全余量——字号不随窄屏缩小,所以窄屏也不能比宽屏少留。
    const rightPad = hasNetworkAxis ? 78 : 5;
    const plotRight = width - rightPad;
    const span = plotRight - gutter;
    const maxPoints = Math.max(2, Math.floor(span / 3));
    const times = downsample(series.timestamps, maxPoints);
    const downsampled = chartActiveDefs.map(function (def) { return downsample(valuesFor(def.key, series), maxPoints); });
    const count = downsampled.length ? downsampled[0].length : 0;
    const xs = [];
    for (let i = 0; i < count; i++) xs.push(gutter + (span * i) / (count - 1));

    // cpu/memory 共用左轴的 0-100% 量纲;network 没有天然上限,按这一屏数据的峰值取整成
    // 好看的刻度上限(niceMax),画在右轴上——两根轴各管各的,线不会因为量纲不同而挤在一起。
    const domains = chartActiveDefs.map(function (def, i) {
      if (def.key === 'network') {
        const raw = downsampled[i].length ? Math.max.apply(null, downsampled[i]) : 0;
        return { min: 0, max: niceMax(raw) };
      }
      return { min: 0, max: 100 };
    });

    for (let k = 0; k <= 4; k++) {
      const y = top + (plotH / 4) * k + 0.5;
      chartEl.appendChild(svg('line', { class: 'grid', x1: gutter, y1: y, x2: plotRight, y2: y, 'shape-rendering': 'crispEdges' }));
    }
    const leftMarks = [[top, '100%'], [top + plotH / 2, '50%'], [top + plotH, '0%']];
    for (const mark of leftMarks) {
      const label = svg('text', { class: 'axis', x: gutter - 8, y: mark[0], 'text-anchor': 'end', 'dominant-baseline': 'middle' });
      label.textContent = mark[1];
      chartEl.appendChild(label);
    }
    if (hasNetworkAxis) {
      const netDomain = domains[chartActiveDefs.map(function (d) { return d.key; }).indexOf('network')];
      const rightMarks = [[top, netDomain.max], [top + plotH / 2, netDomain.max / 2], [top + plotH, 0]];
      for (const mark of rightMarks) {
        const label = svg('text', { class: 'axis', x: plotRight + 8, y: mark[0], 'text-anchor': 'start', 'dominant-baseline': 'middle' });
        label.textContent = formatRateJs(mark[1]);
        chartEl.appendChild(label);
      }
    }

    function line(values, className, colorVar, domain) {
      if (values.length < 2) return;
      let points = '';
      for (let i = 0; i < values.length; i++) {
        const y = toY(values[i], domain, top, plotH);
        points += (i ? ' ' : '') + xs[i].toFixed(1) + ',' + y.toFixed(1);
      }
      chartEl.appendChild(svg('polyline', { class: className, points: points }));
      chartEl.appendChild(svg('circle', {
        cx: xs[xs.length - 1], cy: toY(values[values.length - 1], domain, top, plotH), r: endDotRadius, fill: colorVar,
      }));
    }
    // 倒序画(network、memory、cpu):cpu 最受关注,压在最上层不被其他线盖住。
    for (let i = chartActiveDefs.length - 1; i >= 0; i--) {
      line(downsampled[i], chartActiveDefs[i].className, chartActiveDefs[i].colorVar, domains[i]);
    }

    // 悬浮的十字线和每条线各一个圆点:默认透明(见 CSS .guide/.hover-dot),指针移动时才显形。
    chartGuide = svg('line', { class: 'guide', x1: gutter, y1: top, x2: gutter, y2: top + plotH });
    chartEl.appendChild(chartGuide);
    chartDots = chartActiveDefs.map(function (def) {
      const dot = svg('circle', { class: 'hover-dot', r: 3, fill: def.colorVar });
      chartEl.appendChild(dot);
      return dot;
    });

    chartData = {
      xs: xs,
      series: chartActiveDefs.map(function (def, i) { return { key: def.key, vals: downsampled[i], domain: domains[i] }; }),
      times: times,
      top: top,
      plotH: plotH,
    };

    // 每轮采集都会重建以上这些元素:鼠标没动的话,在同一位置立刻把悬浮指示器画回去,
    // 否则用户停在某个点上看数值时,指示器会跟着 2 秒一次的刷新一起消失再出现。
    if (hovering) {
      updateHoverAt(lastPointerClientX, lastPointerClientY);
    } else {
      hideHover();
    }
  }

  function render() {
    if (!model) return;
    const key = shapeOf(model);
    if (key !== shapeKey) {
      shapeKey = key;
      build(model);
    }
    apply(model);
  }

  window.addEventListener('message', function (event) {
    const message = event.data;
    if (message && message.type === 'model') {
      model = message.model;
      render();
    }
  });
  window.addEventListener('resize', function () { if (model) drawChart(model.series); });

  vscode.postMessage({ type: 'ready' });
`;
