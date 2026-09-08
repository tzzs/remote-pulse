import * as vscode from 'vscode';
import { AlertLevel, CollectionState, Snapshot } from './types';
import { RemotePulseConfig } from './config';
import { calcAlertLevel, maxAlertLevel, backgroundColorIdFor } from './store/statsStore';
import { renderStatusBarText } from './util/statusBarText';

/** 状态栏本身只显示 CPU/内存两个数字,其余指标全部在趋势面板里——点击是进入面板的唯一入口。 */
const SHOW_TREND_COMMAND = 'remotePulse.showTrend';

export class PulseStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
    this.item.name = 'Remote Pulse';
    this.item.command = SHOW_TREND_COMMAND;
    this.showLoading();
    this.item.show();
  }

  showLoading(): void {
    this.item.text = '$(sync~spin)';
    this.item.backgroundColor = undefined;
  }

  /** 采集失败(权限/网络抖动)时静默降级,不弹烦人的错误通知。 */
  showError(_reason: string): void {
    this.item.text = '$(circle-slash)';
    this.item.backgroundColor = undefined;
  }

  update(snapshot: Snapshot, config: RemotePulseConfig, state: CollectionState): void {
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

  dispose(): void {
    this.item.dispose();
  }
}
