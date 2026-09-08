import * as vscode from 'vscode';

export type StatusBarMetric = 'cpu' | 'memory';
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
