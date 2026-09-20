import * as vscode from 'vscode';

export type StatusBarMetric = 'cpu' | 'memory' | 'disk' | 'gpu' | 'network';
export type TrendPanelSection = 'network' | 'gpu' | 'docker';
/** 折线图里画哪几条线,和 trendPanelSections(GPU 详情区块/Docker 表格是否出现)、
 * statusBarMetrics(状态栏摘要数字)各自独立——三处配置的候选指标故意保持同一套名字
 * (cpu/memory/gpu/network 的交集或子集),但三个配置项分开存,互不联动。
 * disk 只在状态栏出现:磁盘是慢变量,30 分钟折线图里几乎是一条水平线,没有画的价值。 */
export type TrendChartMetric = 'cpu' | 'memory' | 'network' | 'gpu';

export interface RemotePulseConfig {
  enabled: boolean;
  refreshInterval: number;
  backgroundInterval: number;
  heavyMetricInterval: number;
  warningThreshold: number;
  criticalThreshold: number;
  statusBarMetrics: StatusBarMetric[];
  trendPanelSections: TrendPanelSection[];
  trendChartMetrics: TrendChartMetric[];
  enableNotifications: boolean;
  diskMountPoints: string[];
}

const SECTION = 'remotePulse';

export function readConfig(): RemotePulseConfig {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  // 不传第二个 fallback 参数:package.json 的 schema default 是唯一真相源,
  // 双写两份默认值迟早会漂移;这里的 ?? 只兜住类型,不是第二份配置默认值。
  return {
    enabled: cfg.get<boolean>('enabled') ?? true,
    refreshInterval: cfg.get<number>('refreshInterval') ?? 2000,
    backgroundInterval: cfg.get<number>('backgroundInterval') ?? 15000,
    heavyMetricInterval: cfg.get<number>('heavyMetricInterval') ?? 10000,
    warningThreshold: cfg.get<number>('warningThreshold') ?? 80,
    criticalThreshold: cfg.get<number>('criticalThreshold') ?? 95,
    statusBarMetrics: cfg.get<StatusBarMetric[]>('statusBarMetrics') ?? [],
    trendPanelSections: cfg.get<TrendPanelSection[]>('trendPanelSections') ?? [],
    trendChartMetrics: cfg.get<TrendChartMetric[]>('trendChartMetrics') ?? [],
    enableNotifications: cfg.get<boolean>('enableNotifications') ?? false,
    diskMountPoints: cfg.get<string[]>('diskMountPoints') ?? [],
  };
}

export function isRemotePulseConfigChange(e: vscode.ConfigurationChangeEvent): boolean {
  return e.affectsConfiguration(SECTION);
}

/**
 * VS Code 的设置 UI 对 array+enum 类型的配置项只会渲染成"逐行下拉框 + Add Item"的列表编辑器,
 * 没有一次性列出所有选项、直接打勾的原生控件——这是平台限制,不是 schema 没写对。
 * 真正的"打勾多选"只能靠 showQuickPick({ canPickMany: true }) 这种命令面板入口实现,
 * 所以数组配置项本身保留不变(避免 breaking change),额外提供这两个命令作为勾选入口。
 */
export async function configureStatusBarMetrics(): Promise<void> {
  const options: { key: StatusBarMetric; label: string }[] = [
    { key: 'cpu', label: vscode.l10n.t('CPU usage') },
    { key: 'memory', label: vscode.l10n.t('Memory usage') },
    { key: 'disk', label: vscode.l10n.t('Disk usage (fullest mount point)') },
    { key: 'gpu', label: vscode.l10n.t('GPU utilization (primary GPU only)') },
    { key: 'network', label: vscode.l10n.t('Network transfer rate') },
  ];
  await runMultiSelect('statusBarMetrics', options, vscode.l10n.t('Choose which metrics to show in the status bar'));
}

export async function configureTrendPanelSections(): Promise<void> {
  const options: { key: TrendPanelSection; label: string }[] = [
    { key: 'network', label: vscode.l10n.t('Network upload/download rate') },
    { key: 'gpu', label: vscode.l10n.t('GPU info') },
    { key: 'docker', label: vscode.l10n.t('Docker container info') },
  ];
  await runMultiSelect('trendPanelSections', options, vscode.l10n.t('Choose which optional sections to show in the trend panel'));
}

/** 折线图会不会因为这里多勾了指标而变挤,和 GPU 详情区块/Docker 表格要不要出现(trendPanelSections)
 * 是两个完全独立的决定,所以这是第三个多选命令,不复用前两个的配置项。 */
export async function configureTrendChartMetrics(): Promise<void> {
  const options: { key: TrendChartMetric; label: string }[] = [
    { key: 'cpu', label: vscode.l10n.t('CPU usage') },
    { key: 'memory', label: vscode.l10n.t('Memory usage') },
    { key: 'gpu', label: vscode.l10n.t('GPU utilization (primary GPU only)') },
    { key: 'network', label: vscode.l10n.t('Network transfer rate') },
  ];
  await runMultiSelect('trendChartMetrics', options, vscode.l10n.t('Choose which metrics to plot as lines in the trend chart'));
}

async function runMultiSelect<K extends string>(
  settingKey: 'statusBarMetrics' | 'trendPanelSections' | 'trendChartMetrics',
  options: { key: K; label: string }[],
  placeHolder: string,
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const current = cfg.get<K[]>(settingKey, []);
  const picks = await vscode.window.showQuickPick(
    options.map(o => ({ label: o.label, picked: current.includes(o.key), key: o.key })),
    { canPickMany: true, placeHolder },
  );
  // undefined 代表用户按 Esc 取消,此时不该把配置清空成空数组。
  if (picks === undefined) {
    return;
  }
  const pickedKeys = new Set(picks.map(p => p.key));
  const next = options.filter(o => pickedKeys.has(o.key)).map(o => o.key);
  await cfg.update(settingKey, next, vscode.ConfigurationTarget.Global);
}

/** 总开关:某些机器上不想被任何额外轮询打扰时,不用卸载/禁用整个扩展,一条命令即可暂停/恢复。 */
export async function toggleEnabled(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const current = cfg.get<boolean>('enabled', true);
  await cfg.update('enabled', !current, vscode.ConfigurationTarget.Global);
  const nextEnabled = !current;
  void vscode.window.setStatusBarMessage(
    nextEnabled ? vscode.l10n.t('Remote Pulse resumed') : vscode.l10n.t('Remote Pulse paused'),
    3000,
  );
}
