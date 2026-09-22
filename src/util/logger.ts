/**
 * 采集失败时状态栏只显示一个 $(circle-slash),刻意不弹通知——但"不打扰"不等于"查不到原因"。
 * 所有降级路径都往这里写一行,用户执行 "Remote Pulse: Show Logs" 就能看到到底是权限、
 * 路径缺失还是超时。
 *
 * 这个模块刻意不 import vscode:采集器全都依赖它,一旦它把整棵依赖树绑到扩展宿主上,
 * 所有采集器的纯解析函数就再也没法用 node:test 跑了。输出目的地由扩展侧在激活时注入。
 *
 * 日志内容一律英文,不走 l10n:日志的读者是来排查问题的人(常常是贴到 issue 里的),
 * 一个可搜索的固定字符串比一句被翻译过的话更有用。
 */
type LogSink = (line: string) => void;

/** 默认丢弃:单测和未激活的场景下不该凭空产生副作用。 */
let sink: LogSink = () => {};

export function setLogSink(next: LogSink): void {
  sink = next;
}

export function resetLogSink(): void {
  sink = () => {};
}

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

export function log(message: string): void {
  sink(`[${timestamp()}] ${message}`);
}

/** 同一个错误每轮采集都会复现,原样写进日志会 2 秒一行地刷屏;相同来源只记第一次和每第 100 次。 */
const repeatCounts = new Map<string, number>();

export function logThrottled(key: string, message: string): void {
  const count = (repeatCounts.get(key) ?? 0) + 1;
  repeatCounts.set(key, count);
  if (count === 1) {
    log(message);
  } else if (count % 100 === 0) {
    log(`${message} (repeated ${count} times)`);
  }
}

/** 某个采集路径恢复正常后清掉计数,下次再出问题仍然会立刻记录第一条。 */
export function clearThrottle(key: string): void {
  repeatCounts.delete(key);
}

export function resetThrottleForTest(): void {
  repeatCounts.clear();
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
