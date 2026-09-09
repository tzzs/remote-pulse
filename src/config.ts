import * as vscode from 'vscode';

export type StatusBarMetric = 'cpu' | 'memory' | 'gpu' | 'network';
export type TrendPanelSection = 'network' | 'gpu' | 'docker';

export interface RemotePulseConfig {
  refreshInterval: number;
  backgroundInterval: number;
  heavyMetricInterval: number;
  warningThreshold: number;
  criticalThreshold: number;
  statusBarMetrics: StatusBarMetric[];
  trendPanelSections: TrendPanelSection[];
  enableNotifications: boolean;
  diskMountPoints: string[];
}

const SECTION = 'remotePulse';
const DEFAULT_STATUS_BAR_METRICS: StatusBarMetric[] = ['cpu', 'memory'];
const DEFAULT_TREND_PANEL_SECTIONS: TrendPanelSection[] = ['gpu', 'docker'];

export function readConfig(): RemotePulseConfig {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  return {
    refreshInterval: cfg.get<number>('refreshInterval', 2000),
    backgroundInterval: cfg.get<number>('backgroundInterval', 15000),
    heavyMetricInterval: cfg.get<number>('heavyMetricInterval', 10000),
    warningThreshold: cfg.get<number>('warningThreshold', 80),
    criticalThreshold: cfg.get<number>('criticalThreshold', 95),
    statusBarMetrics: cfg.get<StatusBarMetric[]>('statusBarMetrics', DEFAULT_STATUS_BAR_METRICS),
    trendPanelSections: cfg.get<TrendPanelSection[]>('trendPanelSections', DEFAULT_TREND_PANEL_SECTIONS),
    enableNotifications: cfg.get<boolean>('enableNotifications', false),
    diskMountPoints: cfg.get<string[]>('diskMountPoints', []),
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

async function runMultiSelect<K extends string>(
  settingKey: 'statusBarMetrics' | 'trendPanelSections',
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
