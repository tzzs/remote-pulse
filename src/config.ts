import * as vscode from 'vscode';
import { normalizeThresholds } from './util/settings';

export type StatusBarMetric = 'cpu' | 'memory' | 'gpu' | 'network';
export type TrendPanelSection = 'network' | 'gpu' | 'docker' | 'processes' | 'diskIo';
/** 折线图里画哪几条线,和 trendPanelSections(GPU 详情区块/Docker 表格是否出现)、
 * statusBarMetrics(状态栏摘要数字)各自独立——三处配置的候选指标故意保持同一套名字
 * (cpu/memory/gpu/network 的交集或子集),但三个配置项分开存,互不联动。 */
export type TrendChartMetric = 'cpu' | 'memory' | 'network' | 'gpu';
export type NotificationMetric = 'cpu' | 'memory' | 'disk' | 'gpu';
export type StatusBarAlignment = 'left' | 'right';
export type GpuSelection = 'primary' | 'busiest';

export interface RemotePulseConfig {
  refreshInterval: number;
  backgroundInterval: number;
  heavyMetricInterval: number;
  warningThreshold: number;
  criticalThreshold: number;
  gpuTempWarningThreshold: number;
  gpuTempCriticalThreshold: number;
  statusBarMetrics: StatusBarMetric[];
  statusBarAlignment: StatusBarAlignment;
  trendPanelSections: TrendPanelSection[];
  trendChartMetrics: TrendChartMetric[];
  trendWindowMinutes: number;
  notificationMetrics: NotificationMetric[];
  enableNotifications: boolean;
  diskMountPoints: string[];
  networkInterfaces: string[];
  gpuSelection: GpuSelection;
  topProcessCount: number;
  dockerMaxContainers: number;
  cgroupAware: boolean;
}

const SECTION = 'remotePulse';
const DEFAULT_STATUS_BAR_METRICS: StatusBarMetric[] = ['cpu', 'memory'];
const DEFAULT_TREND_PANEL_SECTIONS: TrendPanelSection[] = ['gpu', 'docker'];
const DEFAULT_TREND_CHART_METRICS: TrendChartMetric[] = ['cpu', 'memory'];
const DEFAULT_NOTIFICATION_METRICS: NotificationMetric[] = ['cpu', 'memory', 'disk'];

export function readConfig(): RemotePulseConfig {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const usage = normalizeThresholds(cfg.get<number>('warningThreshold', 80), cfg.get<number>('criticalThreshold', 95));
  const gpuTemp = normalizeThresholds(
    cfg.get<number>('gpuTempWarningThreshold', 80),
    cfg.get<number>('gpuTempCriticalThreshold', 90),
  );
  return {
    refreshInterval: cfg.get<number>('refreshInterval', 2000),
    backgroundInterval: cfg.get<number>('backgroundInterval', 15000),
    heavyMetricInterval: cfg.get<number>('heavyMetricInterval', 10000),
    warningThreshold: usage.warning,
    criticalThreshold: usage.critical,
    gpuTempWarningThreshold: gpuTemp.warning,
    gpuTempCriticalThreshold: gpuTemp.critical,
    statusBarMetrics: cfg.get<StatusBarMetric[]>('statusBarMetrics', DEFAULT_STATUS_BAR_METRICS),
    statusBarAlignment: cfg.get<StatusBarAlignment>('statusBarAlignment', 'left'),
    trendPanelSections: cfg.get<TrendPanelSection[]>('trendPanelSections', DEFAULT_TREND_PANEL_SECTIONS),
    trendChartMetrics: cfg.get<TrendChartMetric[]>('trendChartMetrics', DEFAULT_TREND_CHART_METRICS),
    trendWindowMinutes: cfg.get<number>('trendWindowMinutes', 30),
    notificationMetrics: cfg.get<NotificationMetric[]>('notificationMetrics', DEFAULT_NOTIFICATION_METRICS),
    enableNotifications: cfg.get<boolean>('enableNotifications', false),
    diskMountPoints: cfg.get<string[]>('diskMountPoints', []),
    networkInterfaces: cfg.get<string[]>('networkInterfaces', []),
    gpuSelection: cfg.get<GpuSelection>('gpuSelection', 'primary'),
    topProcessCount: cfg.get<number>('topProcessCount', 5),
    dockerMaxContainers: cfg.get<number>('dockerMaxContainers', 20),
    cgroupAware: cfg.get<boolean>('cgroupAware', true),
  };
}

export function isRemotePulseConfigChange(e: vscode.ConfigurationChangeEvent): boolean {
  return e.affectsConfiguration(SECTION);
}

/** 状态栏项的对齐方式是构造 StatusBarItem 时就定死的,改了必须整组重建——单独拎出来给扩展侧比对。 */
export function affectsStatusBarLayout(e: vscode.ConfigurationChangeEvent): boolean {
  return e.affectsConfiguration(`${SECTION}.statusBarAlignment`);
}

/**
 * VS Code 的设置 UI 对 array+enum 类型的配置项只会渲染成"逐行下拉框 + Add Item"的列表编辑器,
 * 没有一次性列出所有选项、直接打勾的原生控件——这是平台限制,不是 schema 没写对。
 * 真正的"打勾多选"只能靠 showQuickPick({ canPickMany: true }) 这种命令面板入口实现,
 * 所以数组配置项本身保留不变(避免 breaking change),额外提供这几个命令作为勾选入口。
 */
export async function configureStatusBarMetrics(): Promise<void> {
  const options: { key: StatusBarMetric; label: string }[] = [
    { key: 'cpu', label: vscode.l10n.t('CPU usage') },
    { key: 'memory', label: vscode.l10n.t('Memory usage') },
    { key: 'gpu', label: vscode.l10n.t('GPU utilization') },
    { key: 'network', label: vscode.l10n.t('Network transfer rate') },
  ];
  await runMultiSelect('statusBarMetrics', options, vscode.l10n.t('Choose which metrics to show in the status bar'));
}

export async function configureTrendPanelSections(): Promise<void> {
  const options: { key: TrendPanelSection; label: string }[] = [
    { key: 'network', label: vscode.l10n.t('Network upload/download rate') },
    { key: 'diskIo', label: vscode.l10n.t('Disk read/write throughput') },
    { key: 'gpu', label: vscode.l10n.t('GPU info') },
    { key: 'processes', label: vscode.l10n.t('Top processes by CPU') },
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
    { key: 'gpu', label: vscode.l10n.t('GPU utilization') },
    { key: 'network', label: vscode.l10n.t('Network transfer rate') },
  ];
  await runMultiSelect('trendChartMetrics', options, vscode.l10n.t('Choose which metrics to plot as lines in the trend chart'));
}

/** 哪些指标越过严重阈值时值得打断用户。磁盘写满比 CPU 高更致命,默认就在名单里。 */
export async function configureNotificationMetrics(): Promise<void> {
  const options: { key: NotificationMetric; label: string }[] = [
    { key: 'cpu', label: vscode.l10n.t('CPU usage') },
    { key: 'memory', label: vscode.l10n.t('Memory usage') },
    { key: 'disk', label: vscode.l10n.t('Disk usage') },
    { key: 'gpu', label: vscode.l10n.t('GPU utilization') },
  ];
  await runMultiSelect('notificationMetrics', options, vscode.l10n.t('Choose which metrics can raise a critical notification'));
}

async function runMultiSelect<K extends string>(
  settingKey: 'statusBarMetrics' | 'trendPanelSections' | 'trendChartMetrics' | 'notificationMetrics',
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
