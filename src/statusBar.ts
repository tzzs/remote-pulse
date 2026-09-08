import * as vscode from 'vscode';
import { AlertLevel, CollectionState, Snapshot } from './types';
import { RemotePulseConfig } from './config';
import { calcAlertLevel, maxAlertLevel, foregroundColorIdFor } from './store/statsStore';
import { iconGlyphFor } from './util/statusBarText';

/** 状态栏本身只显示 CPU/内存两个数字,其余指标全部在趋势面板里——点击是进入面板的唯一入口。 */
const SHOW_TREND_COMMAND = 'remotePulse.showTrend';

/** 单个 StatusBarItem 只能有一种颜色,CPU 和内存要各自独立变色,图标还要反映两者里更严重的一个——
 * 所以拆成三个相邻的项而不是一条拼接文本,和 VS Code 自带的多段状态栏组合(比如 Git 分支+同步)是同一种做法。 */
export class PulseStatusBar {
  private readonly iconItem: vscode.StatusBarItem;
  private readonly cpuItem: vscode.StatusBarItem;
  private readonly memItem: vscode.StatusBarItem;
  /** vscode.StatusBarItem 不暴露"当前是否可见"的读取接口,自己记一份供调试状态用。 */
  private cpuVisible = false;
  private memVisible = false;

  constructor() {
    this.iconItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
    this.iconItem.name = 'Remote Pulse: Alert';
    this.iconItem.command = SHOW_TREND_COMMAND;

    this.cpuItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 999);
    this.cpuItem.name = 'Remote Pulse: CPU';
    this.cpuItem.command = SHOW_TREND_COMMAND;

    this.memItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 998);
    this.memItem.name = 'Remote Pulse: Memory';
    this.memItem.command = SHOW_TREND_COMMAND;

    this.showLoading();
    this.iconItem.show();
  }

  showLoading(): void {
    this.iconItem.text = '$(sync~spin)';
    this.iconItem.color = undefined;
    this.iconItem.show();
    this.cpuItem.hide();
    this.memItem.hide();
    this.cpuVisible = false;
    this.memVisible = false;
  }

  /** 采集失败(权限/网络抖动)时静默降级,不弹烦人的错误通知。 */
  showError(_reason: string): void {
    this.iconItem.text = '$(circle-slash)';
    this.iconItem.color = undefined;
    this.iconItem.show();
    this.cpuItem.hide();
    this.memItem.hide();
    this.cpuVisible = false;
    this.memVisible = false;
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
    const overallLevel = maxAlertLevel(cpuLevel, memLevel);

    const cpuText = cpuPercent !== undefined ? String(Math.round(cpuPercent)).padStart(2, ' ') : '--';
    const memText = memPercent !== undefined ? String(Math.round(memPercent)).padStart(2, ' ') : '--';

    this.iconItem.text = iconGlyphFor(config.template, overallLevel === 'critical');
    this.iconItem.color = this.foregroundColorFor(overallLevel);
    this.iconItem.show();

    this.cpuItem.text = `CPU ${cpuText}%`;
    this.cpuItem.color = this.foregroundColorFor(cpuLevel);
    this.cpuItem.show();
    this.cpuVisible = true;

    this.memItem.text = `MEM ${memText}%`;
    this.memItem.color = this.foregroundColorFor(memLevel);
    this.memItem.show();
    this.memVisible = true;
  }

  private foregroundColorFor(level: AlertLevel): vscode.ThemeColor {
    return new vscode.ThemeColor(foregroundColorIdFor(level));
  }

  /** 仅供集成测试读取当前渲染状态用,不做其他用途。 */
  get debugState(): {
    icon: StatusBarItemDebugState;
    cpu: StatusBarItemDebugState;
    mem: StatusBarItemDebugState;
  } {
    return {
      icon: { ...debugStateOf(this.iconItem), visible: true },
      cpu: { ...debugStateOf(this.cpuItem), visible: this.cpuVisible },
      mem: { ...debugStateOf(this.memItem), visible: this.memVisible },
    };
  }

  dispose(): void {
    this.iconItem.dispose();
    this.cpuItem.dispose();
    this.memItem.dispose();
  }
}

interface StatusBarItemDebugState {
  text: string;
  color: string | vscode.ThemeColor | undefined;
  backgroundColor: vscode.ThemeColor | undefined;
  tooltip: string | vscode.MarkdownString | undefined;
  alignment: vscode.StatusBarAlignment;
  priority: number | undefined;
  command: string | vscode.Command | undefined;
  visible: boolean;
}

function debugStateOf(item: vscode.StatusBarItem): Omit<StatusBarItemDebugState, 'visible'> {
  return {
    text: item.text,
    color: item.color,
    backgroundColor: item.backgroundColor,
    tooltip: item.tooltip,
    alignment: item.alignment,
    priority: item.priority,
    command: item.command,
  };
}
