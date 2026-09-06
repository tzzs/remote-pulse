import * as vscode from 'vscode';
import { AlertLevel, CollectionState, Snapshot } from './types';
import { RemotePulseConfig } from './config';
import { calcAlertLevel, maxAlertLevel, backgroundColorIdFor } from './store/statsStore';
import { renderSparkline, formatBytes, formatRate, formatUptime } from './util/sparkline';
import { renderStatusBarText } from './util/statusBarText';
import { visualWidth, padLabel } from './util/align';

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
    this.item.backgroundColor = undefined;
    this.tooltipMarkdown.value = vscode.l10n.t('Collecting remote host status…');
  }

  /** 采集失败(权限/网络抖动)时静默降级,不弹烦人的错误通知,只在 tooltip 里说明原因。 */
  showError(reason: string): void {
    this.item.text = '$(circle-slash)';
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
    this.item.backgroundColor = this.backgroundColorFor(level);
    this.tooltipMarkdown.value = this.buildTooltip(hostLabel, snapshot, config, sparklines);
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
   * 每个指标一行 "标签 + 数值",放进一个 markdown 代码块里手动补空格对齐——
   * 代码块是等宽字体,普通段落/列表是不定宽字体,单纯拼空格在普通文本里对不齐。
   * 标签只用固定的短词(CPU/内存/GPU #N/VRAM/温度...),挂载点、GPU 型号、容器名这些
   * 长度不定的内容一律放进数值那一列,避免某一行标签特别长时把所有行的对齐都拖垮。
   */
  private buildTooltip(
    hostLabel: string,
    snapshot: Snapshot,
    config: RemotePulseConfig,
    sparklines: { cpu: number[]; memory: number[] },
  ): string {
    const rows: [string, string][] = [];

    if (snapshot.cpu) {
      const cpuSpark = renderSparkline(sparklines.cpu.length > 0 ? sparklines.cpu : [snapshot.cpu.percent]);
      rows.push(['CPU', `${cpuSpark} ${Math.round(snapshot.cpu.percent)}% (${vscode.l10n.t('{0} cores', snapshot.cpu.cores)})`]);
    }
    if (snapshot.memory) {
      const memSpark = renderSparkline(sparklines.memory.length > 0 ? sparklines.memory : [snapshot.memory.percent]);
      rows.push([
        vscode.l10n.t('Memory'),
        `${memSpark} ${Math.round(snapshot.memory.percent)}% (${formatBytes(snapshot.memory.used)} / ${formatBytes(snapshot.memory.total)})`,
      ]);
    }
    for (const disk of snapshot.disks ?? []) {
      rows.push([vscode.l10n.t('Disk'), `${disk.mountPoint}  ${Math.round(disk.percent)}% (${formatBytes(disk.used)} / ${formatBytes(disk.total)})`]);
    }
    if (config.enableNetwork && snapshot.network) {
      rows.push([vscode.l10n.t('Network'), `↓ ${formatRate(snapshot.network.rxRate)}  ↑ ${formatRate(snapshot.network.txRate)}`]);
    }
    if (config.enableGpu) {
      for (const gpu of snapshot.gpus ?? []) {
        const utilization = vscode.l10n.t('{0}% utilization', gpu.utilizationPercent);
        rows.push([`GPU #${gpu.index}`, gpu.name ? `${gpu.name} · ${utilization}` : utilization]);
        rows.push([`  ${vscode.l10n.t('VRAM')}`, `${gpu.memoryUsedMb}/${gpu.memoryTotalMb} MB`]);
        rows.push([`  ${vscode.l10n.t('Temp')}`, `${gpu.temperatureC}°C`]);
      }
    }
    if (config.enableDocker && snapshot.docker) {
      rows.push(['Docker', vscode.l10n.t('Running containers: {0}', snapshot.docker.containerCount)]);
      for (const c of snapshot.docker.containers.slice(0, 5)) {
        rows.push([`  ${c.name}`, `CPU ${c.cpuPercent.toFixed(1)}%  ${vscode.l10n.t('Memory')} ${formatBytes(c.memoryUsedBytes)}`]);
      }
    }
    if (snapshot.uptimeSeconds !== undefined) {
      rows.push([vscode.l10n.t('Uptime'), formatUptime(snapshot.uptimeSeconds)]);
    }

    const labelWidth = Math.max(0, ...rows.map(([label]) => visualWidth(label))) + 2;
    const body = rows.map(([label, value]) => `${padLabel(label, labelWidth)}${value}`).join('\n');

    return [`**${vscode.l10n.t('Remote host: {0}', hostLabel)}**`, '', '```', body, '```'].join('\n');
  }

  dispose(): void {
    this.item.dispose();
  }
}
