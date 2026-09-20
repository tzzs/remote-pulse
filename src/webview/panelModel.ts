import { AlertLevel, CollectorAvailability, CpuStats, DiskStats, DockerStats, GpuStats, MemoryStats, NetworkRate } from '../types';
import { calcAlertLevel } from '../store/statsStore';
import { formatBytes, formatRate, formatUptime } from '../util/sparkline';

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

export type TrendPayload = {
  series: TrendSeries;
  latest?: TrendLatest;
  thresholds: { warning: number; critical: number };
  availability?: { gpu?: CollectorAvailability; docker?: CollectorAvailability };
};

/** 远程主机的身份信息。user / addresses 在受限环境下可能取不到,所以都是可选的。 */
export interface HostInfo {
  label: string;
  user?: string;
  /** 全部非内网 IPv4,按网卡列出——多网卡机器(WSL 的 eth0 + docker0)只看一个地址是不够的。 */
  addresses?: { iface: string; address: string }[];
}

/**
 * 模型层不 import vscode:t("翻译")和 locale(日期格式)由扩展侧注入,
 * 这样 buildModel 可以脱离扩展宿主直接跑单元测试。
 */
export interface ModelLocale {
  locale: string;
  t: (message: string, ...args: (string | number)[]) => string;
}

/**
 * 面板渲染模型:取值、单位换算、本地化全部在扩展侧完成,webview 只按模型建 DOM。
 * 这样 webview 里不出现任何字符串拼接的 HTML,主机名/挂载点/GPU 型号/容器名即使
 * 含尖括号也只会作为 textContent 出现,天然没有注入面。
 */
export interface MetricRow {
  label: string;
  detail: string;
  value: string;
  /** 有百分比才画进度条;温度、速率这类没有 0-100 语义的指标不画。 */
  percent?: number;
  level: AlertLevel;
  /** 子行(GPU 各项指标):缩进 16px 并收窄标签列,让进度条与数值仍落在同一条右边线上。 */
  sub?: boolean;
  strong?: boolean;
  /** 灰色提示行(空态/不可用说明),不画进度条、数值列留空。 */
  hint?: boolean;
}

export interface ChartLegendItem {
  /** 客户端靠这个 key(而不是数组下标)去 SERIES_DEFS 里找颜色/className——
   * 一旦某条线可以被单独勾掉,"第 i 个图例对应第 i 个预定义线"这个位置假设就不成立了。 */
  key: 'cpu' | 'memory' | 'gpu' | 'networkRx' | 'networkTx';
  name: string;
  /** 最新一次采集的即时值,和图表末端的圆点是同一个数,不随悬浮变化。 */
  value?: string;
}

export type PanelGroup =
  | { kind: 'metrics'; title: string; badge?: string; rows: MetricRow[] }
  | { kind: 'chart'; title: string; legend: ChartLegendItem[]; emptyHint: string }
  | {
      kind: 'table';
      title: string;
      badge?: string;
      /** 三列的列头:容器名 | CPU | 内存。 */
      columns: [string, string, string];
      rows: [string, string, string][];
      /** 每行第三个单元格(内存"已用 + 占 limit 百分比")按阈值着色。 */
      levels: AlertLevel[];
      emptyHint?: string;
    };

export interface PanelModel {
  host: { name: string; meta: string; user?: string };
  updated: string;
  /** SVG 图表的读屏替身:标题 + 当前画了哪几条线,在扩展侧本地化好,webview 里不拼字符串。 */
  chartAriaLabel: string;
  /** 按钮的 title/aria-label,完整描述用——"Remote Pulse Settings"。 */
  settingsLabel: string;
  /** 齿轮图标旁边显示的短文字,和 settingsLabel 分开是因为标题栏寸土寸金,"Settings"一个词就够了。 */
  settingsText: string;
  groups: PanelGroup[];
  series: { timestamps: number[]; cpu?: number[]; memory?: number[]; gpu?: number[]; networkRx?: number[]; networkTx?: number[] };
}

/** "host [WSL:distro] (10.0.0.2)" → 主名 + 弱化的 IP,IP 缺失时整串当主名。 */
export function splitHostLabel(hostLabel: string): { name: string; meta: string } {
  const match = /^(.*?)\s*\(([^()]*)\)$/.exec(hostLabel);
  return match ? { name: match[1], meta: match[2] } : { name: hostLabel, meta: '' };
}

function hintRow(text: string): MetricRow {
  return { label: text, detail: '', value: '', level: 'normal', hint: true };
}

export function buildModel(host: HostInfo, payload: TrendPayload, loc: ModelLocale): PanelModel {
  const { series, latest, thresholds, availability } = payload;
  const { t } = loc;
  const levelOf = (percent: number): AlertLevel => calcAlertLevel(percent, thresholds.warning, thresholds.critical);
  const groups: PanelGroup[] = [];

  const system: MetricRow[] = [];
  if (latest?.cpu) {
    system.push({
      label: 'CPU',
      detail: t('{0} cores', latest.cpu.cores),
      value: `${Math.round(latest.cpu.percent)}%`,
      percent: latest.cpu.percent,
      level: levelOf(latest.cpu.percent),
    });
  }
  if (latest?.memory) {
    system.push({
      label: t('Memory'),
      detail: `${formatBytes(latest.memory.used)} / ${formatBytes(latest.memory.total)}`,
      value: `${Math.round(latest.memory.percent)}%`,
      percent: latest.memory.percent,
      level: levelOf(latest.memory.percent),
    });
  }
  if (latest?.network) {
    system.push({
      label: t('Network'),
      detail: '',
      value: `↓ ${formatRate(latest.network.rxRate)}  ↑ ${formatRate(latest.network.txRate)}`,
      level: 'normal',
    });
  }
  if (latest?.uptimeSeconds !== undefined) {
    system.push({ label: t('Uptime'), detail: '', value: formatUptime(latest.uptimeSeconds), level: 'normal' });
  }
  // 每张网卡一行:标签是网卡名(eth0/wlan0/docker0 这类),多网卡时靠它互相区分,单看这几个字符
  // 猜不出是什么意思——detail 列补一句"网络接口",眼睛扫到这行不用先认得 Linux 网卡命名习惯。
  for (const { iface, address } of host.addresses ?? []) {
    system.push({ label: iface, detail: t('Network interface'), value: address, level: 'normal' });
  }
  if (system.length) {
    groups.push({ kind: 'metrics', title: t('System'), rows: system });
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
    legend.push({ key: 'memory', name: t('Memory'), value: value !== undefined ? `${Math.round(value)}%` : undefined });
  }
  if (series.gpu) {
    const value = lastOf(series.gpu);
    legend.push({ key: 'gpu', name: 'GPU', value: value !== undefined ? `${Math.round(value)}%` : undefined });
  }
  // 上传/下载各画一条线、各一条图例——合并成一个数就分不清是在上传还是下载,和状态栏网络项
  // 拆成 $(arrow-down)/$(arrow-up) 两截是同一个理由。两条线共享同一段右轴,domain 由
  // PANEL_SCRIPT 里 niceMax(Math.max(rx 峰值, tx 峰值)) 统一算,不能各自独立取峰值。
  if (series.networkRx) {
    const value = lastOf(series.networkRx);
    legend.push({ key: 'networkRx', name: `↓ ${t('Download')}`, value: value !== undefined ? formatRate(value) : undefined });
  }
  if (series.networkTx) {
    const value = lastOf(series.networkTx);
    legend.push({ key: 'networkTx', name: `↑ ${t('Upload')}`, value: value !== undefined ? formatRate(value) : undefined });
  }
  const chartTitle = t('{0} · past 30 minutes', t('Trend'));
  groups.push({
    kind: 'chart',
    title: chartTitle,
    legend,
    emptyHint: t('Not enough history data yet. Please wait a few seconds and reopen.'),
  });

  const disks = latest?.disks ?? [];
  if (disks.length) {
    groups.push({
      kind: 'metrics',
      title: t('Storage'),
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
  if (gpus.length || (availability?.gpu && availability.gpu !== 'available')) {
    const rows: MetricRow[] = [];
    for (const gpu of gpus) {
      const vramPercent = gpu.memoryTotalMb > 0 ? (gpu.memoryUsedMb / gpu.memoryTotalMb) * 100 : 0;
      rows.push({ label: `GPU ${gpu.index}`, detail: gpu.name ?? '', value: '', level: 'normal', strong: true });
      rows.push({
        label: t('Utilization'),
        detail: '',
        value: `${Math.round(gpu.utilizationPercent)}%`,
        percent: gpu.utilizationPercent,
        level: levelOf(gpu.utilizationPercent),
        sub: true,
      });
      rows.push({
        label: t('VRAM'),
        detail: `${formatBytes(gpu.memoryUsedMb * 1024 * 1024)} / ${formatBytes(gpu.memoryTotalMb * 1024 * 1024)}`,
        value: `${Math.round(vramPercent)}%`,
        percent: vramPercent,
        level: levelOf(vramPercent),
        sub: true,
      });
      rows.push({
        label: t('Temp'),
        detail: '',
        value: `${gpu.temperatureC} °C`,
        level: levelOf(gpu.temperatureC),
        sub: true,
      });
    }
    if (!rows.length) {
      rows.push(hintRow(gpuUnavailableHint(availability?.gpu, t)));
    }
    groups.push({ kind: 'metrics', title: 'GPU', rows });
  }

  if (latest?.docker || (availability?.docker && availability.docker !== 'available')) {
    const containers = latest?.docker?.containers ?? [];
    groups.push({
      kind: 'table',
      title: 'Docker',
      badge: latest?.docker ? String(latest.docker.containerCount) : undefined,
      columns: [t('Container'), 'CPU', t('Memory')],
      levels: containers.map(c => levelOf(c.memoryLimitBytes > 0 ? (c.memoryUsedBytes / c.memoryLimitBytes) * 100 : 0)),
      rows: containers.map(c => {
        const memPercent = c.memoryLimitBytes > 0 ? `${Math.round((c.memoryUsedBytes / c.memoryLimitBytes) * 100)}%` : '—';
        return [c.name, `${c.cpuPercent.toFixed(1)}%`, `${formatBytes(c.memoryUsedBytes)} ${memPercent}`] as [string, string, string];
      }),
      emptyHint: latest?.docker ? t('No containers running') : dockerUnavailableHint(availability?.docker, t),
    });
  }

  const updatedAt = new Intl.DateTimeFormat(loc.locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date());

  return {
    host: { ...splitHostLabel(host.label), user: host.user },
    updated: t('Updated {0}', updatedAt),
    // 读屏器听到的替身:标题 + 当前画了哪几条线(线名本身已本地化)。
    chartAriaLabel: `${chartTitle}: ${legend.map(l => l.name).join(' / ')}`,
    settingsLabel: t('Remote Pulse Settings'),
    settingsText: t('Settings'),
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

function gpuUnavailableHint(state: CollectorAvailability | undefined, t: ModelLocale['t']): string {
  if (state === 'no_permission') {
    return t('GPU metrics unavailable: nvidia-smi requires elevated permissions.');
  }
  if (state === 'pending') {
    return t('Waiting for the first GPU sample…');
  }
  return t('No NVIDIA GPU detected (nvidia-smi not found).');
}

function dockerUnavailableHint(state: CollectorAvailability | undefined, t: ModelLocale['t']): string {
  if (state === 'no_permission') {
    return t('Docker metrics unavailable: no permission to access docker.sock.');
  }
  if (state === 'pending') {
    return t('Waiting for the first Docker sample…');
  }
  return t('Docker daemon socket not found.');
}
