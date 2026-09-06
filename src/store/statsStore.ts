import { AlertLevel, Snapshot } from '../types';
import { RingBuffer } from './ringBuffer';

/** 900 个采样点对应 30 分钟 @ 2 秒/次的默认前台刷新间隔,供 sparkline 和趋势图使用。 */
export const HISTORY_CAPACITY = 900;

export class StatsStore {
  private readonly history: RingBuffer<Snapshot>;

  constructor(capacity: number = HISTORY_CAPACITY) {
    this.history = new RingBuffer<Snapshot>(capacity);
  }

  push(snapshot: Snapshot): void {
    this.history.push(snapshot);
  }

  latest(): Snapshot | undefined {
    return this.history.last();
  }

  getHistory(): Snapshot[] {
    return this.history.toArray();
  }

  /** 取最近 windowMs 毫秒内某个数值序列(用于 sparkline / 趋势图),缺失值跳过。 */
  recentValues(windowMs: number, pick: (s: Snapshot) => number | undefined): number[] {
    const now = Date.now();
    return this.history
      .toArray()
      .filter(s => now - s.timestamp <= windowMs)
      .map(pick)
      .filter((v): v is number => v !== undefined);
  }
}

export function calcAlertLevel(percent: number, warningThreshold: number, criticalThreshold: number): AlertLevel {
  if (percent >= criticalThreshold) {
    return 'critical';
  }
  if (percent >= warningThreshold) {
    return 'warning';
  }
  return 'normal';
}

const ALERT_LEVEL_RANK: Record<AlertLevel, number> = { normal: 0, warning: 1, critical: 2 };

/** 多个指标(CPU/内存)各自的告警级别取最严重的一个,决定状态栏整体的颜色。 */
export function maxAlertLevel(...levels: AlertLevel[]): AlertLevel {
  return levels.reduce((worst, level) => (ALERT_LEVEL_RANK[level] > ALERT_LEVEL_RANK[worst] ? level : worst), 'normal' as AlertLevel);
}

/**
 * VS Code 状态栏没有官方的"正常态"前景色,只能自己挑一个语义色;
 * 返回主题色 id(不直接依赖 vscode 模块),由调用方套进 new vscode.ThemeColor(id)。
 */
export function foregroundColorIdFor(level: AlertLevel): string | undefined {
  return level === 'normal' ? 'charts.green' : undefined;
}

/** VS Code 状态栏背景色官方只承认 error/warning 两种语义色,normal 态没有对应背景。 */
export function backgroundColorIdFor(level: AlertLevel): string | undefined {
  if (level === 'critical') {
    return 'statusBarItem.errorBackground';
  }
  if (level === 'warning') {
    return 'statusBarItem.warningBackground';
  }
  return undefined;
}
