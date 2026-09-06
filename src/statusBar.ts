import * as vscode from 'vscode';
import { AlertLevel, CollectionState, Snapshot } from './types';
import { RemotePulseConfig } from './config';
import { calcAlertLevel, maxAlertLevel, foregroundColorIdFor, backgroundColorIdFor } from './store/statsStore';
import { renderSparkline, formatBytes, formatRate, formatUptime } from './util/sparkline';
import { renderStatusBarText } from './util/statusBarText';

export class PulseStatusBar {
  private readonly item: vscode.StatusBarItem;
  /** 复用同一个 MarkdownString 实例,只改 .value,不重新赋值 item.tooltip——避免 hover 弹出期间被强制刷新导致闪烁。 */
  private readonly tooltipMarkdown: vscode.MarkdownString;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
    this.item.name = 'Remote Pulse';
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
    command: string | vscode.Command | undefined;
  } {
    return {
      text: this.item.text,
      color: this.item.color,
      backgroundColor: this.item.backgroundColor,
      tooltip: this.item.tooltip,
      alignment: this.item.alignment,
      priority: this.item.priority,
      command: this.item.command,
    };
  }

  /**
   * 用嵌套的 markdown 列表:表格在部分主题下会把单元格文字渲染得偏浅、长文本还会在列内断行错位,
   * 列表没有这些问题——连续的 "- " 行本来就会被解析成独立列表项,不需要额外的硬换行技巧;
   * GPU/Docker 这类多子项信息用两格缩进的子列表(↳ 效果由缩进本身体现,不用箭头符号)分开。
   */
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
      lines.push(`- CPU  ${cpuSpark} ${Math.round(snapshot.cpu.percent)}% (${vscode.l10n.t('{0} cores', snapshot.cpu.cores)})`);
    }
    if (snapshot.memory) {
      const memSpark = renderSparkline(sparklines.memory.length > 0 ? sparklines.memory : [snapshot.memory.percent]);
      lines.push(
        `- ${vscode.l10n.t('Memory')}  ${memSpark} ${Math.round(snapshot.memory.percent)}% (${formatBytes(snapshot.memory.used)} / ${formatBytes(snapshot.memory.total)})`,
      );
    }
    for (const disk of snapshot.disks ?? []) {
      lines.push(`- ${vscode.l10n.t('Disk {0}', disk.mountPoint)}  ${Math.round(disk.percent)}% (${formatBytes(disk.used)} / ${formatBytes(disk.total)})`);
    }
    if (config.enableNetwork && snapshot.network) {
      lines.push(`- ${vscode.l10n.t('Network')}  ↓ ${formatRate(snapshot.network.rxRate)}  ↑ ${formatRate(snapshot.network.txRate)}`);
    }
    if (config.enableGpu) {
      for (const gpu of snapshot.gpus ?? []) {
        lines.push(`- GPU #${gpu.index}${gpu.name ? ` (${gpu.name})` : ''}  ${vscode.l10n.t('{0}% utilization', gpu.utilizationPercent)}`);
        lines.push(`  - ${vscode.l10n.t('VRAM')}  ${gpu.memoryUsedMb}/${gpu.memoryTotalMb} MB`);
        lines.push(`  - ${vscode.l10n.t('Temp')}  ${gpu.temperatureC}°C`);
      }
    }
    if (config.enableDocker && snapshot.docker) {
      lines.push(`- Docker  ${vscode.l10n.t('Running containers: {0}', snapshot.docker.containerCount)}`);
      for (const c of snapshot.docker.containers.slice(0, 5)) {
        lines.push(`  - ${c.name}  CPU ${c.cpuPercent.toFixed(1)}%  ${vscode.l10n.t('Memory')} ${formatBytes(c.memoryUsedBytes)}`);
      }
    }
    if (snapshot.uptimeSeconds !== undefined) {
      lines.push(`- ${vscode.l10n.t('Uptime')}  ${formatUptime(snapshot.uptimeSeconds)}`);
    }

    return lines.join('\n');
  }

  dispose(): void {
    this.item.dispose();
  }
}
