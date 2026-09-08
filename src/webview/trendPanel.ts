import * as vscode from 'vscode';
import { AlertLevel, CpuStats, DiskStats, DockerStats, GpuStats, MemoryStats, NetworkRate } from '../types';
import { calcAlertLevel } from '../store/statsStore';
import { formatBytes, formatRate, formatUptime } from '../util/sparkline';

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i += 1) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

export interface TrendSeries {
  /** 与 cpu/memory 一一对应的 epoch ms,悬浮提示要靠它算出该点的具体时间。 */
  timestamps: number[];
  cpu: number[];
  memory: number[];
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
  name: string;
  /** 最新一次采集的即时值,和图表末端的圆点是同一个数,不随悬浮变化。 */
  value?: string;
}

type PanelGroup =
  | { kind: 'metrics'; title: string; badge?: string; rows: MetricRow[] }
  | { kind: 'chart'; title: string; legend: [ChartLegendItem, ChartLegendItem]; emptyHint: string }
  | { kind: 'table'; title: string; badge?: string; columns: [string, string]; rows: [string, string, string][]; emptyHint?: string };

interface PanelModel {
  host: { name: string; meta: string; user?: string };
  updated: string;
  settingsLabel: string;
  groups: PanelGroup[];
  series: { timestamps: number[]; cpu: number[]; memory: number[] };
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
          void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:tanzz.remote-pulse');
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

  groups.push({
    kind: 'chart',
    title: vscode.l10n.t('past 30 minutes'),
    legend: [
      { name: 'CPU', value: latest?.cpu ? `${Math.round(latest.cpu.percent)}%` : undefined },
      { name: vscode.l10n.t('Memory'), value: latest?.memory ? `${Math.round(latest.memory.percent)}%` : undefined },
    ],
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
    settingsLabel: vscode.l10n.t('Open Remote Pulse Settings'),
    groups,
    series: { timestamps: series.timestamps, cpu: series.cpu, memory: series.memory },
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
  let chartLegendNames = ['CPU', 'Memory'];
  /** 悬浮态跨轮询保留:每 2 秒的重绘会重建折线和圆点,如果不在重绘后把悬浮指示器按住原位置
      重新画一次,鼠标不动也会看到它每 2 秒闪一下。 */
  let chartGuide = null;
  let chartDotCpu = null;
  let chartDotMem = null;
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

  function gearIcon() {
    const node = svg('svg', { width: 15, height: 15, viewBox: '0 0 16 16', 'aria-hidden': 'true' });
    node.appendChild(svg('circle', { cx: 8, cy: 8, r: 2.8, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.2 }));
    node.appendChild(svg('path', {
      d: 'M8 1.4V2.8M8 13.2V14.6M14.6 8H13.2M2.8 8H1.4M12.66 3.34L11.66 4.34M4.34 11.66L3.34 12.66M12.66 12.66L11.66 11.66M4.34 4.34L3.34 3.34',
      stroke: 'currentColor', 'stroke-width': 1.15, 'stroke-linecap': 'round',
    }));
    return node;
  }

  /** 结构不变就只改文字和条宽,避免每 2 秒重建 DOM 打断用户的文字选中。 */
  function shapeOf(m) {
    return JSON.stringify(m.groups.map(function (g) {
      if (g.kind === 'metrics') return ['m', g.title, g.rows.map(function (r) { return [r.label, !!r.sub, !!r.strong, r.percent !== undefined]; })];
      if (g.kind === 'table') return ['t', g.title, g.rows.map(function (r) { return r[0]; })];
      return ['c', g.title];
    })) + '|' + m.host.name + '|' + m.host.meta + '|' + (m.host.user || '');
  }

  function build(m) {
    slots = [];
    chartEl = null;
    chartHint = null;
    chartTooltip = null;
    chartGuide = null;
    chartDotCpu = null;
    chartDotMem = null;
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
        chartLegendNames = [group.legend[0].name, group.legend[1].name];
        const legend = el('span', 'legend');
        for (let i = 0; i < group.legend.length; i++) {
          const item = el('span', 'legend-item');
          const dot = el('span', 'swatch');
          dot.style.background = i === 0 ? 'var(--rp-cpu)' : 'var(--rp-mem)';
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
    if (chartDotCpu) chartDotCpu.style.opacity = '0';
    if (chartDotMem) chartDotMem.style.opacity = '0';
    if (chartTooltip) chartTooltip.style.display = 'none';
  }

  function renderTooltipContent(cpuValue, memValue, timeMs) {
    chartTooltip.replaceChildren();
    const d = new Date(timeMs);
    chartTooltip.appendChild(el('div', 'time', isNaN(d.getTime()) ? '' : d.toLocaleTimeString()));

    function metricRow(colorVar, name, value) {
      const row = el('div', 'metric');
      const dot = el('span', 'swatch');
      dot.style.background = colorVar;
      row.appendChild(dot);
      row.appendChild(el('span', '', name));
      row.appendChild(el('span', 'value', Math.round(Math.max(0, Math.min(100, value))) + '%'));
      return row;
    }
    chartTooltip.appendChild(metricRow('var(--rp-cpu)', chartLegendNames[0], cpuValue));
    chartTooltip.appendChild(metricRow('var(--rp-mem)', chartLegendNames[1], memValue));
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
    const cpuValue = chartData.cpuVals[nearest];
    const memValue = chartData.memVals[nearest];
    const cpuY = chartData.top + (1 - Math.max(0, Math.min(100, cpuValue)) / 100) * chartData.plotH;
    const memY = chartData.top + (1 - Math.max(0, Math.min(100, memValue)) / 100) * chartData.plotH;

    chartGuide.setAttribute('x1', x);
    chartGuide.setAttribute('x2', x);
    chartGuide.style.opacity = '1';
    chartDotCpu.setAttribute('cx', x);
    chartDotCpu.setAttribute('cy', cpuY);
    chartDotCpu.style.opacity = '1';
    chartDotMem.setAttribute('cx', x);
    chartDotMem.setAttribute('cy', memY);
    chartDotMem.style.opacity = '1';

    renderTooltipContent(cpuValue, memValue, chartData.times[nearest]);

    const wrap = chartEl.parentElement;
    const wrapRect = wrap.getBoundingClientRect();
    const offsetX = rect.left - wrapRect.left;
    const offsetY = rect.top - wrapRect.top;
    const pointLocalX = offsetX + x / scale;
    const pointLocalY = offsetY + Math.min(cpuY, memY) / scale;

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

  function drawChart(series) {
    if (!chartEl) return;
    const hasData = series.cpu.length > 1 || series.memory.length > 1;
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

    for (let k = 0; k <= 4; k++) {
      const y = top + (plotH / 4) * k + 0.5;
      chartEl.appendChild(svg('line', { class: 'grid', x1: gutter, y1: y, x2: width, y2: y, 'shape-rendering': 'crispEdges' }));
    }
    const marks = [[top, '100%'], [top + plotH / 2, '50%'], [top + plotH, '0%']];
    for (const mark of marks) {
      const label = svg('text', { class: 'axis', x: gutter - 8, y: mark[0], 'text-anchor': 'end', 'dominant-baseline': 'middle' });
      label.textContent = mark[1];
      chartEl.appendChild(label);
    }

    // 末端圆点的圆心如果落在 x = width(viewBox 的右边界)上,半径里有一半必然被 svg 视口裁掉——
    // 之前就是这样,右侧留一点安全边距,圆点画在边界内侧而不是正好卡在边界上。
    const endDotRadius = 2.5;
    const rightPad = 5;
    const span = width - gutter - rightPad;
    const maxPoints = Math.max(2, Math.floor(span / 3));
    const cpuVals = downsample(series.cpu, maxPoints);
    const memVals = downsample(series.memory, maxPoints);
    const times = downsample(series.timestamps, maxPoints);
    const count = cpuVals.length;
    const xs = [];
    for (let i = 0; i < count; i++) xs.push(gutter + (span * i) / (count - 1));

    function line(values, className) {
      if (values.length < 2) return;
      let points = '';
      for (let i = 0; i < values.length; i++) {
        const v = Math.max(0, Math.min(100, values[i]));
        const y = top + (1 - v / 100) * plotH;
        points += (i ? ' ' : '') + xs[i].toFixed(1) + ',' + y.toFixed(1);
      }
      chartEl.appendChild(svg('polyline', { class: className, points: points }));
      const last = Math.max(0, Math.min(100, values[values.length - 1]));
      chartEl.appendChild(svg('circle', {
        cx: xs[xs.length - 1], cy: top + (1 - last / 100) * plotH, r: endDotRadius,
        fill: className === 'cpu' ? 'var(--rp-cpu)' : 'var(--rp-mem)',
      }));
    }
    line(memVals, 'mem');
    line(cpuVals, 'cpu');

    // 悬浮的十字线和两个圆点:默认透明(见 CSS .guide/.hover-dot),指针移动时才显形。
    chartGuide = svg('line', { class: 'guide', x1: gutter, y1: top, x2: gutter, y2: top + plotH });
    chartEl.appendChild(chartGuide);
    chartDotMem = svg('circle', { class: 'hover-dot', r: 3, fill: 'var(--rp-mem)' });
    chartEl.appendChild(chartDotMem);
    chartDotCpu = svg('circle', { class: 'hover-dot', r: 3, fill: 'var(--rp-cpu)' });
    chartEl.appendChild(chartDotCpu);

    chartData = { xs: xs, cpuVals: cpuVals, memVals: memVals, times: times, top: top, plotH: plotH };

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
