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
 * 用固定十六进制颜色而不是主题 token(之前是 charts.*,后来改成 terminal.ansiBright*)——
 * 两者都在某些主题下被重新定义成偏灰、偏淡的取值,状态栏背景又可能被 Remote-SSH/WSL 指示器、
 * 主题、Vim 模式插件改成任意深色(比如深青色),依赖 token 就意味着颜色能不能看清完全赌
 * 用户当前主题怎么定义它。写死具体色值不会被任何主题重新解释,始终是同一个鲜艳的绿/黄/红。
 * 仅根据明暗两套取值(而不是逐主题适配),在浅色背景下用更深、更饱和的版本保证对比度。
 */
const DARK_THEME_COLORS: Record<AlertLevel, string> = {
  normal: '#23d18b',
  warning: '#f5f543',
  critical: '#f14c4c',
};

const LIGHT_THEME_COLORS: Record<AlertLevel, string> = {
  normal: '#16794f',
  warning: '#9a6700',
  critical: '#cf222e',
};

export function foregroundColorFor(level: AlertLevel, isLightTheme: boolean): string {
  return (isLightTheme ? LIGHT_THEME_COLORS : DARK_THEME_COLORS)[level];
}
