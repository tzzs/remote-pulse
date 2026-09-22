import * as vscode from 'vscode';
import {
  AlertLevel,
  CpuStats,
  DiskIoRate,
  DiskStats,
  DockerStats,
  GpuStats,
  LoadAverage,
  MemoryStats,
  NetworkRate,
  ProcessStats,
  SwapStats,
} from '../types';
import { calcAlertLevel } from '../store/statsStore';
import { formatBytes, formatRate, formatUptime } from '../util/sparkline';
import { loadPercent } from '../collectors/loadavg';
import {
  configureStatusBarMetrics,
  configureTrendPanelSections,
  configureTrendChartMetrics,
  configureNotificationMetrics,
} from '../config';

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
   * 上传/下载分开两条线,而不是 rx+tx 加在一起——合并成一个数就分不清是在上传还是下载了
   * (状态栏的网络项也是同样的理由拆开的)。单位 B/s,原始值不做归一化,画图时两条线共用
   * 独立的右侧 y 轴(自己的量纲),而不是硬挤进 CPU/内存共用的百分比左轴。
   */
  networkRx?: number[];
  networkTx?: number[];
  /** 跟随 gpuSelection(主卡 / 最忙的卡),和状态栏摘要同一个约定;多卡详情仍然只在 GPU 区块里能看到。 */
  gpu?: number[];
}

export interface TrendLatest {
  cpu?: CpuStats;
  memory?: MemoryStats;
  swap?: SwapStats;
  load?: LoadAverage;
  disks: DiskStats[];
  diskIo?: DiskIoRate;
  network?: NetworkRate;
  gpus: GpuStats[];
  processes: ProcessStats[];
  docker?: DockerStats;
  uptimeSeconds?: number;
}

export interface TrendPayload {
  series: TrendSeries;
  latest?: TrendLatest;
  /**
   * 使用率和温度必须各有一对阈值。之前 GPU 温度直接套用了百分比阈值,默认 80/95 碰巧接近
   * GPU 的合理温度区间所以看不出问题;但用户只要把 warningThreshold 调成 50(想让 CPU 早点报警),
   * 所有 GPU 就会在 50 °C 常年亮黄——°C 和 % 本来就不是一个量纲。
   */
  thresholds: { warning: number; critical: number; gpuTempWarning: number; gpuTempCritical: number };
  windowMinutes: number;
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
  key: 'cpu' | 'memory' | 'gpu' | 'networkRx' | 'networkTx';
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
  /** 按钮的 title/aria-label,完整描述用——"Remote Pulse Settings"。 */
  settingsLabel: string;
  /** 齿轮图标旁边显示的短文字,和 settingsLabel 分开是因为标题栏寸土寸金,"Settings"一个词就够了。 */
  settingsText: string;
  groups: PanelGroup[];
  series: { timestamps: number[]; cpu?: number[]; memory?: number[]; gpu?: number[]; networkRx?: number[]; networkTx?: number[] };
}

/**
 * 齿轮按钮点的是"设置入口"而不是"直接跳设置页"——几个数组配置在原生 Settings UI 里只有
 * 列表编辑器,不是一次性打勾的体验,所以把配置向导命令放在菜单最前面,
 * "打开设置(JSON/UI)"作为兜底选项留在最后。
 */
async function showSettingsMenu(): Promise<void> {
  type Choice = { label: string; action: 'statusBar' | 'trendPanel' | 'trendChart' | 'notifications' | 'settings' };
  const items: Choice[] = [
    { label: `$(checklist) ${vscode.l10n.t('Configure Status Bar Metrics…')}`, action: 'statusBar' },
    { label: `$(checklist) ${vscode.l10n.t('Configure Trend Panel Sections…')}`, action: 'trendPanel' },
    { label: `$(checklist) ${vscode.l10n.t('Configure Trend Chart Metrics…')}`, action: 'trendChart' },
    { label: `$(checklist) ${vscode.l10n.t('Configure Notification Metrics…')}`, action: 'notifications' },
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
  } else if (picked.action === 'notifications') {
    await configureNotificationMetrics();
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
 *
 * 样式和脚本从 media/ 下的真实文件加载,而不是内联的模板字符串:模板字符串既不过语法检查、
 * 也没法给纯函数写单测,而图表的取整/降采样逻辑恰恰是最容易算错的部分(见 media/chart.js)。
 */
export class TrendPanel {
  private static current: TrendPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  /** webview 被隐藏后会被销毁,再次显示时脚本重新加载并索要数据,这里留着最后一份。 */
  private lastModel: PanelModel | undefined;

  static createOrShow(extensionUri: vscode.Uri, host: HostInfo, payload: TrendPayload): void {
    if (TrendPanel.current) {
      TrendPanel.current.panel.reveal();
      TrendPanel.current.update(host, payload);
      return;
    }
    TrendPanel.current = new TrendPanel(extensionUri, host, payload);
  }

  static isOpen(): boolean {
    return TrendPanel.current !== undefined;
  }

  static refreshIfOpen(host: HostInfo, payload: TrendPayload): void {
    TrendPanel.current?.update(host, payload);
  }

  private constructor(extensionUri: vscode.Uri, host: HostInfo, payload: TrendPayload) {
    const mediaRoot = vscode.Uri.joinPath(extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel('remotePulseTrend', vscode.l10n.t('Remote Pulse Trend'), vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: false,
      localResourceRoots: [mediaRoot],
    });
    this.panel.title = `Remote Pulse — ${host.label}`;
    this.panel.webview.html = this.renderShell(mediaRoot);
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
    // 标签页切走时 webview 已经被销毁(retainContextWhenHidden: false),这时候还每 2 秒
    // 建模型、发消息纯属白烧 CPU;重新可见时 VS Code 会重载脚本,脚本自己会发 ready 来要数据。
    this.panel.onDidChangeViewState(() => {
      if (this.panel.visible && this.lastModel) {
        void this.panel.webview.postMessage({ type: 'model', model: this.lastModel });
      }
    }, null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.update(host, payload);
  }

  private update(host: HostInfo, payload: TrendPayload): void {
    this.panel.title = `Remote Pulse — ${host.label}`;
    this.lastModel = buildModel(host, payload);
    if (!this.panel.visible) {
      return;
    }
    void this.panel.webview.postMessage({ type: 'model', model: this.lastModel });
  }

  private renderShell(mediaRoot: vscode.Uri): string {
    const webview = this.panel.webview;
    const csp = webview.cspSource;
    const n = nonce();
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'panel.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'panel.js'));

    // script-src 既要 nonce(给入口 <script>)也要 ${csp}(给它静态 import 的 chart.js——
    // ES module 的 import 请求带不上 nonce,只能靠 host 源放行)。
    return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src ${csp} 'nonce-${n}';" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>${vscode.l10n.t('Remote Pulse Trend')}</title>
</head>
<body>
  <div id="root" class="panel"></div>
  <script type="module" nonce="${n}" src="${scriptUri}"></script>
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

export function buildModel(host: HostInfo, payload: TrendPayload): PanelModel {
  const { series, latest, thresholds } = payload;
  const levelOf = (percent: number): AlertLevel => calcAlertLevel(percent, thresholds.warning, thresholds.critical);
  const groups: PanelGroup[] = [];

  const system: MetricRow[] = [];
  if (latest?.cpu) {
    // 容器里 /proc 读到的是宿主机数据,百分比的分母完全不同——数据来源必须标出来,
    // 否则用户会拿一个"宿主机 64 核忙不忙"的数字去判断自己 2 核的容器还剩多少额度。
    const detail =
      latest.cpu.source === 'cgroup' && latest.cpu.quotaCores !== undefined
        ? vscode.l10n.t('{0} cores (cgroup limit)', trimNumber(latest.cpu.quotaCores))
        : vscode.l10n.t('{0} cores', latest.cpu.cores);
    system.push({
      label: 'CPU',
      detail,
      value: `${Math.round(latest.cpu.percent)}%`,
      percent: latest.cpu.percent,
      level: levelOf(latest.cpu.percent),
    });
  }
  if (latest?.memory) {
    const detail = `${formatBytes(latest.memory.used)} / ${formatBytes(latest.memory.total)}`;
    system.push({
      label: vscode.l10n.t('Memory'),
      detail: latest.memory.source === 'cgroup' ? `${detail} · ${vscode.l10n.t('cgroup limit')}` : detail,
      value: `${Math.round(latest.memory.percent)}%`,
      percent: latest.memory.percent,
      level: levelOf(latest.memory.percent),
    });
  }
  // 开始用 swap 往往是 OOM 的前兆,值得单独一行;机器没配 swap 时采集器返回 undefined,这行就不出现。
  if (latest?.swap) {
    system.push({
      label: vscode.l10n.t('Swap'),
      detail: `${formatBytes(latest.swap.used)} / ${formatBytes(latest.swap.total)}`,
      value: `${Math.round(latest.swap.percent)}%`,
      percent: latest.swap.percent,
      level: levelOf(latest.swap.percent),
    });
  }
  // 负载本身没有上限,进度条按"负载 ÷ 核数"画:8 核机器上 load 8 就是刚好跑满 = 100%。
  if (latest?.load) {
    const cores = latest.cpu?.cores ?? 1;
    const percent = loadPercent(latest.load.one, cores);
    system.push({
      label: vscode.l10n.t('Load'),
      detail: `${trimNumber(latest.load.one)} / ${trimNumber(latest.load.five)} / ${trimNumber(latest.load.fifteen)}`,
      value: `${Math.round(percent)}%`,
      percent: Math.min(100, percent),
      level: levelOf(percent),
    });
  }
  if (latest?.network) {
    system.push({
      label: vscode.l10n.t('Network'),
      detail: '',
      // HTML 会把连续空格折叠成一个,用 em space 才能保住上下行速率之间的视觉间隔。
      value: `↓ ${formatRate(latest.network.rxRate)}  ↑ ${formatRate(latest.network.txRate)}`,
      level: 'normal',
    });
  }
  if (latest?.uptimeSeconds !== undefined) {
    system.push({ label: vscode.l10n.t('Uptime'), detail: '', value: formatUptime(latest.uptimeSeconds), level: 'normal' });
  }
  // 每张网卡一行:标签是网卡名(eth0/wlan0/docker0 这类),多网卡时靠它互相区分,单看这几个字符
  // 猜不出是什么意思——detail 列补一句"网络接口",眼睛扫到这行不用先认得 Linux 网卡命名习惯。
  for (const { iface, address } of host.addresses ?? []) {
    system.push({ label: iface, detail: vscode.l10n.t('Network interface'), value: address, level: 'normal' });
  }
  if (system.length) {
    groups.push({ kind: 'metrics', title: vscode.l10n.t('System'), rows: system });
  }

  // 图例的"当前值"直接取 series 数组的最后一个点,而不是另外查 latest.* ——这样图例
  // 完全由 trendChartMetrics 驱动,不会因为"System"信息行/GPU 详情区块各自的显示开关
  // (trendPanelSections)而跟着变化,两套配置才能真正互不影响地独立生效。
  const lastOf = (values?: number[]): number | undefined => (values && values.length ? values[values.length - 1] : undefined);
  // 图例顺序就是图表画线的顺序(cpu, memory, gpu, 再 network)——panel.js 按 legend 里的
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
  // 上传/下载各画一条线、各一条图例——合并成一个数就分不清是在上传还是下载,和状态栏网络项
  // 拆成 $(arrow-down)/$(arrow-up) 两截是同一个理由。两条线共享同一段右轴,domain 由
  // panel.js 里 niceMax(Math.max(rx 峰值, tx 峰值)) 统一算,不能各自独立取峰值。
  if (series.networkRx) {
    const value = lastOf(series.networkRx);
    legend.push({ key: 'networkRx', name: `↓ ${vscode.l10n.t('Download')}`, value: value !== undefined ? formatRate(value) : undefined });
  }
  if (series.networkTx) {
    const value = lastOf(series.networkTx);
    legend.push({ key: 'networkTx', name: `↑ ${vscode.l10n.t('Upload')}`, value: value !== undefined ? formatRate(value) : undefined });
  }
  groups.push({
    kind: 'chart',
    title: vscode.l10n.t('past {0} minutes', payload.windowMinutes),
    legend,
    emptyHint: vscode.l10n.t('Not enough history data yet. Please wait a few seconds and reopen.'),
  });

  const disks = latest?.disks ?? [];
  const storage: MetricRow[] = disks.map(disk => ({
    label: disk.mountPoint,
    detail: `${formatBytes(disk.used)} / ${formatBytes(disk.total)}`,
    value: `${Math.round(disk.percent)}%`,
    percent: disk.percent,
    level: levelOf(disk.percent),
  }));
  // 吞吐没有 0-100% 语义,和网络速率一样只给数字不给进度条,也不参与阈值配色。
  if (latest?.diskIo) {
    storage.push({
      label: vscode.l10n.t('Disk I/O'),
      detail: '',
      value: `↓ ${formatRate(latest.diskIo.readRate)}  ↑ ${formatRate(latest.diskIo.writeRate)}`,
      level: 'normal',
    });
  }
  if (storage.length) {
    groups.push({ kind: 'metrics', title: vscode.l10n.t('Storage'), rows: storage });
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
        // 摄氏度有自己的阈值对,不能套用百分比那一套——见 TrendPayload.thresholds 的注释。
        level: calcAlertLevel(gpu.temperatureC, thresholds.gpuTempWarning, thresholds.gpuTempCritical),
        sub: true,
      });
    }
    groups.push({ kind: 'metrics', title: 'GPU', rows });
  }

  // "CPU 90%" 之后用户的下一个问题必然是"谁干的"。进程 CPU% 与上面 CPU 那一行同口径
  // (分母都是全部核心),所以两个数字可以直接对照着看。
  const processes = latest?.processes ?? [];
  if (processes.length) {
    groups.push({
      kind: 'table',
      title: vscode.l10n.t('Top Processes'),
      columns: ['CPU', vscode.l10n.t('Memory')],
      rows: processes.map(
        p => [`${p.name} (${p.pid})`, `${p.cpuPercent.toFixed(1)}%`, formatBytes(p.memoryBytes)] as [string, string, string],
      ),
      emptyHint: vscode.l10n.t('No process data available'),
    });
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
    settingsText: vscode.l10n.t('Settings'),
    groups,
    series: {
      timestamps: series.timestamps,
      cpu: series.cpu,
      memory: series.memory,
      gpu: series.gpu,
      networkRx: series.networkRx,
      networkTx: series.networkTx,
    },
  };
}

/** 负载和配额核数是小数,但 "2" 比 "2.00" 好读——整数不带小数点,非整数保留两位。 */
function trimNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
