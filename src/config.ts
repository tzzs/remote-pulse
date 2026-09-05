import * as vscode from 'vscode';

export interface RemotePulseConfig {
  refreshInterval: number;
  backgroundInterval: number;
  heavyMetricInterval: number;
  warningThreshold: number;
  criticalThreshold: number;
  template: string;
  enableGpu: boolean;
  enableDocker: boolean;
  enableNetwork: boolean;
  enableNotifications: boolean;
  diskMountPoints: string[];
}

const SECTION = 'remotePulse';

export function readConfig(): RemotePulseConfig {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  return {
    refreshInterval: cfg.get<number>('refreshInterval', 2000),
    backgroundInterval: cfg.get<number>('backgroundInterval', 15000),
    heavyMetricInterval: cfg.get<number>('heavyMetricInterval', 10000),
    warningThreshold: cfg.get<number>('warningThreshold', 80),
    criticalThreshold: cfg.get<number>('criticalThreshold', 95),
    template: cfg.get<string>('template', '$(pulse) CPU ${cpu}%  MEM ${mem}%'),
    enableGpu: cfg.get<boolean>('enableGpu', true),
    enableDocker: cfg.get<boolean>('enableDocker', true),
    enableNetwork: cfg.get<boolean>('enableNetwork', false),
    enableNotifications: cfg.get<boolean>('enableNotifications', false),
    diskMountPoints: cfg.get<string[]>('diskMountPoints', []),
  };
}

export function isRemotePulseConfigChange(e: vscode.ConfigurationChangeEvent): boolean {
  return e.affectsConfiguration(SECTION);
}
