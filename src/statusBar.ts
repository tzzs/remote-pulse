import * as vscode from 'vscode';
import { AlertLevel, CollectionState, Snapshot } from './types';
import { RemotePulseConfig } from './config';
import { calcAlertLevel, maxAlertLevel } from './store/statsStore';

/**
 * 之前用写死的十六进制色值(不经过主题 token),理由是主题可能把 charts.* / terminal.ansiBright*
 * 重新定义成偏灰偏淡的取值。但这样做丢掉了主题系统真正解决的问题:Remote-SSH/WSL 会把整条
 * 状态栏背景强制换色(常见的是深青绿色),写死的绿色文字("正常"态)在这种背景上对比度经
 * 实测只有 ~2.4:1,远低于 WCAG 最低的 3:1——正是因为它和背景撞了色相,只是明暗不同。
 *
 * 现在换成 VS Code 官方为状态栏预留的 warning/error 主题 token 对(前景+背景成对出现,
 * 主题作者写背景色时就会配套写足够对比度的前景色,这是平台保证,不是赌运气);
 * "正常"态干脆不设色,让文字继承 statusBar.foreground——这个 token 天生保证与
 * statusBar.background(包括被 Remote-SSH 改写后的版本)对比度达标。
 * 代价是拿不到一个专属的"健康绿"背景块,因为 VS Code 没有对外暴露 successBackground token。
 */
function foregroundFor(level: AlertLevel): vscode.ThemeColor | undefined {
  if (level === 'critical') return new vscode.ThemeColor('statusBarItem.errorForeground');
  if (level === 'warning') return new vscode.ThemeColor('statusBarItem.warningForeground');
  return undefined;
}

function backgroundFor(level: AlertLevel): vscode.ThemeColor | undefined {
  if (level === 'critical') return new vscode.ThemeColor('statusBarItem.errorBackground');
  if (level === 'warning') return new vscode.ThemeColor('statusBarItem.warningBackground');
  return undefined;
}

const NORMAL_ICON = '$(pulse)';
const CRITICAL_ICON = '$(warning)';

/** 状态栏本身最多只显示 CPU/内存两个数字(可通过 statusBarMetrics 单独隐藏其中一个),其余指标全部在趋势面板里——点击是进入面板的唯一入口。 */
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
    this.iconItem.backgroundColor = undefined;
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
    this.iconItem.backgroundColor = undefined;
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

    const showCpu = config.statusBarMetrics.includes('cpu');
    const showMem = config.statusBarMetrics.includes('memory');

    const cpuLevel = cpuPercent !== undefined ? calcAlertLevel(cpuPercent, config.warningThreshold, config.criticalThreshold) : 'normal';
    const memLevel = memPercent !== undefined ? calcAlertLevel(memPercent, config.warningThreshold, config.criticalThreshold) : 'normal';
    // 图标只反映用户实际勾选展示的那些指标——隐藏掉的指标即使越阈值,也不该影响图标颜色。
    const consideredLevels: AlertLevel[] = [];
    if (showCpu) {
      consideredLevels.push(cpuLevel);
    }
    if (showMem) {
      consideredLevels.push(memLevel);
    }
    const overallLevel = maxAlertLevel(...consideredLevels);

    const cpuText = cpuPercent !== undefined ? String(Math.round(cpuPercent)).padStart(2, ' ') : '--';
    const memText = memPercent !== undefined ? String(Math.round(memPercent)).padStart(2, ' ') : '--';

    this.iconItem.text = overallLevel === 'critical' ? CRITICAL_ICON : NORMAL_ICON;
    this.iconItem.color = foregroundFor(overallLevel);
    this.iconItem.backgroundColor = backgroundFor(overallLevel);
    this.iconItem.show();

    if (showCpu) {
      this.cpuItem.text = `CPU ${cpuText}%`;
      this.cpuItem.color = foregroundFor(cpuLevel);
      this.cpuItem.backgroundColor = backgroundFor(cpuLevel);
      this.cpuItem.show();
      this.cpuVisible = true;
    } else {
      this.cpuItem.hide();
      this.cpuVisible = false;
    }

    if (showMem) {
      this.memItem.text = `MEM ${memText}%`;
      this.memItem.color = foregroundFor(memLevel);
      this.memItem.backgroundColor = backgroundFor(memLevel);
      this.memItem.show();
      this.memVisible = true;
    } else {
      this.memItem.hide();
      this.memVisible = false;
    }
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
