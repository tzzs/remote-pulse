import * as vscode from 'vscode';
import { AlertLevel, CollectionState, Snapshot } from './types';
import { RemotePulseConfig } from './config';
import { calcAlertLevel, maxAlertLevel, foregroundColorIdFor, backgroundColorIdFor } from './store/statsStore';
import { renderSparkline, formatBytes, formatRate, formatUptime } from './util/sparkline';
import { renderStatusBarText } from './util/statusBarText';

const SHOW_TREND_COMMAND = 'remotePulse.showTrend';

export class PulseStatusBar {
  private readonly item: vscode.StatusBarItem;
  /** 复用同一个 MarkdownString 实例,只改 .value,不重新赋值 item.tooltip——避免 hover 弹出期间被强制刷新导致闪烁。 */
  private readonly tooltipMarkdown: vscode.MarkdownString;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
    this.item.name = 'Remote Pulse';
    this.item.command = SHOW_TREND_COMMAND;
    this.tooltipMarkdown = new vscode.MarkdownString();
    this.tooltipMarkdown.isTrusted = false;
    this.item.tooltip = this.tooltipMarkdown;
    this.showLoading();
    this.item.show();
  }

  showLoading(): void {
    this.item.text = '$(sync~spin)';
    this.item.color = undefined;
    this.item.backgroundColor = undefined;
    this.tooltipMarkdown.value = vscode.l10n.t('Collecting remote host status…');
  }

  /** 采集失败(权限/网络抖动)时静默降级,不弹烦人的错误通知,只在 tooltip 里说明原因。 */
  showError(reason: string): void {
    this.item.text = '$(circle-slash)';
    this.item.color = undefined;
    this.item.backgroundColor = undefined;
    this.tooltipMarkdown.value = vscode.l10n.t('Collection failed: {0}', reason);
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

    const cpuPercent = snapshot.cpu?.percent;
    const memPercent = snapshot.memory?.percent;
    if (cpuPercent === undefined && memPercent === undefined) {
      this.showLoading();
      return;
    }

    const cpuLevel = cpuPercent !== undefined ? calcAlertLevel(cpuPercent, config.warningThreshold, config.criticalThreshold) : 'normal';
    const memLevel = memPercent !== undefined ? calcAlertLevel(memPercent, config.warningThreshold, config.criticalThreshold) : 'normal';
    const level = maxAlertLevel(cpuLevel, memLevel);

    const cpuText = cpuPercent !== undefined ? String(Math.round(cpuPercent)).padStart(2, ' ') : '--';
    const memText = memPercent !== undefined ? String(Math.round(memPercent)).padStart(2, ' ') : '--';

    this.item.text = renderStatusBarText(config.template, cpuText, memText, level === 'critical');
    this.item.color = this.colorFor(level);
    this.item.backgroundColor = this.backgroundColorFor(level);
    this.tooltipMarkdown.value = this.buildTooltip(hostLabel, snapshot, config, sparklines);
  }

  private colorFor(level: AlertLevel): vscode.ThemeColor | undefined {
    const id = foregroundColorIdFor(level);
    return id ? new vscode.ThemeColor(id) : undefined;
  }

  private backgroundColorFor(level: AlertLevel): vscode.ThemeColor | undefined {
    const id = backgroundColorIdFor(level);
    return id ? new vscode.ThemeColor(id) : undefined;
  }

  /** 仅供集成测试读取当前渲染状态用,不做其他用途。 */
  get debugState(): {
    text: string;
    color: string | vscode.ThemeColor | undefined;
    backgroundColor: vscode.ThemeColor | undefined;
    tooltip: string | vscode.MarkdownString | undefined;
    alignment: vscode.StatusBarAlignment;
    priority: number | undefined;
  } {
    return {
      text: this.item.text,
      color: this.item.color,
      backgroundColor: this.item.backgroundColor,
      tooltip: this.item.tooltip,
      alignment: this.item.alignment,
      priority: this.item.priority,
    };
  }

  private buildTooltip(
    hostLabel: string,
    snapshot: Snapshot,
    config: RemotePulseConfig,
    sparklines: { cpu: number[]; memory: number[] },
  ): string {
    const lines: string[] = [];
    lines.push(`**${vscode.l10n.t('Remote host: {0}', hostLabel)}**`, '');

    if (snapshot.cpu) {
      const cpuSpark = renderSparkline(sparklines.cpu.length > 0 ? sparklines.cpu : [snapshot.cpu.percent]);
      lines.push(`CPU  ${cpuSpark}  ${Math.round(snapshot.cpu.percent)}%  (${vscode.l10n.t('{0} cores', snapshot.cpu.cores)})`);
    }
    if (snapshot.memory) {
      const memSpark = renderSparkline(sparklines.memory.length > 0 ? sparklines.memory : [snapshot.memory.percent]);
      lines.push(
        `${vscode.l10n.t('Memory')}  ${memSpark}  ${Math.round(snapshot.memory.percent)}%  (${formatBytes(snapshot.memory.used)} / ${formatBytes(snapshot.memory.total)})`,
      );
    }
    if (snapshot.disks && snapshot.disks.length > 0) {
      lines.push('', `**${vscode.l10n.t('Disks:')}**`);
      for (const disk of snapshot.disks) {
        lines.push(`- ${disk.mountPoint}  ${Math.round(disk.percent)}%  (${formatBytes(disk.used)} / ${formatBytes(disk.total)})`);
      }
    }
    if (config.enableNetwork && snapshot.network) {
      lines.push('', `${vscode.l10n.t('Network')}  ↓ ${formatRate(snapshot.network.rxRate)}  ↑ ${formatRate(snapshot.network.txRate)}`);
    }
    if (config.enableGpu && snapshot.gpus && snapshot.gpus.length > 0) {
      lines.push('', '**GPU:**');
      for (const gpu of snapshot.gpus) {
        lines.push(
          `- #${gpu.index} ${gpu.name ?? ''}  ${gpu.utilizationPercent}%  ${vscode.l10n.t('VRAM {0}/{1} MB', gpu.memoryUsedMb, gpu.memoryTotalMb)}  ${gpu.temperatureC}°C`,
        );
      }
    }
    if (config.enableDocker && snapshot.docker) {
      lines.push('', `**Docker** — ${vscode.l10n.t('Running containers: {0}', snapshot.docker.containerCount)}`);
      for (const c of snapshot.docker.containers.slice(0, 5)) {
        lines.push(`- ${c.name}  CPU ${c.cpuPercent.toFixed(1)}%  ${vscode.l10n.t('Memory')} ${formatBytes(c.memoryUsedBytes)}`);
      }
    }
    if (snapshot.uptimeSeconds !== undefined) {
      lines.push('', `Uptime  ${formatUptime(snapshot.uptimeSeconds)}`);
    }
    lines.push('', '---', vscode.l10n.t('Click to view trend chart'));

    return lines.join('  \n');
  }

  dispose(): void {
    this.item.dispose();
  }
}
