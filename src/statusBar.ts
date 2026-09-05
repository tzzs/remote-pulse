import * as vscode from 'vscode';
import { AlertLevel, CollectionState, Snapshot } from './types';
import { RemotePulseConfig } from './config';
import { calcAlertLevel } from './store/statsStore';
import { renderSparkline, formatBytes, formatRate, formatUptime } from './util/sparkline';

const SHOW_TREND_COMMAND = 'remotePulse.showTrend';

export class PulseStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.name = 'Remote Pulse';
    this.item.command = SHOW_TREND_COMMAND;
    this.item.text = '$(sync~spin)';
    this.item.tooltip = vscode.l10n.t('Collecting remote host status…');
    this.item.show();
  }

  showLoading(): void {
    this.item.text = '$(sync~spin)';
    this.item.tooltip = vscode.l10n.t('Collecting remote host status…');
    this.item.backgroundColor = undefined;
  }

  /** 采集失败(权限/网络抖动)时静默降级,不弹烦人的错误通知,只在 tooltip 里说明原因。 */
  showError(reason: string): void {
    this.item.text = '$(circle-slash)';
    this.item.tooltip = new vscode.MarkdownString(vscode.l10n.t('Collection failed: {0}', reason));
    this.item.backgroundColor = undefined;
  }

  update(
    hostLabel: string,
    snapshot: Snapshot,
    config: RemotePulseConfig,
    state: CollectionState,
    sparklines: { cpu: number[]; memory: number[] } = { cpu: [], memory: [] },
  ): void {
    if (state === 'loading') {
      this.showLoading();
      return;
    }

    const primaryPercent = this.pickPrimaryPercent(snapshot, config);
    if (primaryPercent === undefined) {
      this.showLoading();
      return;
    }

    const level = calcAlertLevel(primaryPercent, config.warningThreshold, config.criticalThreshold);
    const paddedValue = String(Math.round(primaryPercent)).padStart(2, ' ');

    let text = config.template.replace('${value}', paddedValue);
    if (level === 'critical') {
      text = text.replace(/^\$\([a-zA-Z-]+\)/, '$(warning)');
    }
    this.item.text = text;
    this.item.backgroundColor = this.backgroundColorFor(level);
    this.item.tooltip = this.buildTooltip(hostLabel, snapshot, config, sparklines);
  }

  private backgroundColorFor(level: AlertLevel): vscode.ThemeColor | undefined {
    if (level === 'critical') {
      return new vscode.ThemeColor('statusBarItem.errorBackground');
    }
    if (level === 'warning') {
      return new vscode.ThemeColor('statusBarItem.warningBackground');
    }
    return undefined;
  }

  private pickPrimaryPercent(snapshot: Snapshot, config: RemotePulseConfig): number | undefined {
    if (config.statusBarMetric === 'memory') {
      return snapshot.memory?.percent;
    }
    return snapshot.cpu?.percent;
  }

  private buildTooltip(
    hostLabel: string,
    snapshot: Snapshot,
    config: RemotePulseConfig,
    sparklines: { cpu: number[]; memory: number[] },
  ): vscode.MarkdownString {
    const lines: string[] = [];
    lines.push(`**${vscode.l10n.t('Remote host: {0}', hostLabel)}**`, '');

    if (snapshot.cpu) {
      const cpuSpark = renderSparkline(sparklines.cpu.length > 0 ? sparklines.cpu : [snapshot.cpu.percent]);
      lines.push(`CPU  ${cpuSpark} ${Math.round(snapshot.cpu.percent)}%  (${vscode.l10n.t('{0} cores', snapshot.cpu.cores)})`);
    }
    if (snapshot.memory) {
      const memSpark = renderSparkline(sparklines.memory.length > 0 ? sparklines.memory : [snapshot.memory.percent]);
      lines.push(
        `${vscode.l10n.t('Memory')}  ${memSpark} ${Math.round(snapshot.memory.percent)}%  (${formatBytes(snapshot.memory.used)} / ${formatBytes(snapshot.memory.total)})`,
      );
    }
    if (snapshot.disks && snapshot.disks.length > 0) {
      lines.push('', vscode.l10n.t('Disks:'));
      for (const disk of snapshot.disks) {
        lines.push(`  ${disk.mountPoint}  ${Math.round(disk.percent)}%  (${formatBytes(disk.used)} / ${formatBytes(disk.total)})`);
      }
    }
    if (config.enableNetwork && snapshot.network) {
      lines.push('', `${vscode.l10n.t('Network')}  ↓ ${formatRate(snapshot.network.rxRate)}  ↑ ${formatRate(snapshot.network.txRate)}`);
    }
    if (config.enableGpu && snapshot.gpus && snapshot.gpus.length > 0) {
      lines.push('', 'GPU:');
      for (const gpu of snapshot.gpus) {
        lines.push(
          `  #${gpu.index} ${gpu.name ?? ''}  ${gpu.utilizationPercent}%  ${vscode.l10n.t('VRAM {0}/{1} MB', gpu.memoryUsedMb, gpu.memoryTotalMb)}  ${gpu.temperatureC}°C`,
        );
      }
    }
    if (config.enableDocker && snapshot.docker) {
      lines.push('', `Docker  ${vscode.l10n.t('Running containers: {0}', snapshot.docker.containerCount)}`);
      for (const c of snapshot.docker.containers.slice(0, 5)) {
        lines.push(`  ${c.name}  CPU ${c.cpuPercent.toFixed(1)}%  ${vscode.l10n.t('Memory')} ${formatBytes(c.memoryUsedBytes)}`);
      }
    }
    if (snapshot.uptimeSeconds !== undefined) {
      lines.push('', `Uptime  ${formatUptime(snapshot.uptimeSeconds)}`);
    }
    lines.push('', '---', vscode.l10n.t('Click to view trend chart'));

    const md = new vscode.MarkdownString(lines.join('\n'));
    md.isTrusted = false;
    return md;
  }

  dispose(): void {
    this.item.dispose();
  }
}
