/**
 * 由配置推导出来的纯数值逻辑。单独成模块是为了能脱离扩展宿主跑单测——
 * config.ts 和 extension.ts 都 import 了 vscode,在 node:test 里根本加载不起来。
 */

/**
 * warning > critical 是一个完全合法的 JSON 配置,但会让分级逻辑彻底失效:
 * calcAlertLevel 先判 critical,于是 warning=95 / critical=80 的用户在 80% 就直接看到红色,
 * 黄色永远不会出现。这里做一次归一化,让"顺手把两个数填反了"退化成一个温和的结果,而不是
 * 一个需要用户自己想明白的诡异现象。
 */
export function normalizeThresholds(warning: number, critical: number): { warning: number; critical: number } {
  return warning > critical ? { warning: critical, critical: warning } : { warning, critical };
}

/**
 * 历史容量 = 趋势窗口 ÷ 采集间隔。之前是写死的 900(按 2 秒间隔推算的 30 分钟),
 * 用户把间隔改成 10 秒之后,900 个点实际覆盖 2.5 小时,多出来的两小时数据白占内存又永远不会被画出来;
 * 反过来把窗口调到 2 小时,900 个点又不够铺满。多留 20% 余量吸收调度抖动,
 * 上下界兜住极端配置(500ms × 240 分钟 = 34 万个点,那是在给监控插件自己制造内存泄漏)。
 */
export function historyCapacityFor(trendWindowMinutes: number, refreshIntervalMs: number): number {
  const windowMs = Math.max(1, trendWindowMinutes) * 60 * 1000;
  const intervalMs = Math.max(500, refreshIntervalMs);
  return Math.min(20000, Math.max(60, Math.ceil((windowMs / intervalMs) * 1.2)));
}
