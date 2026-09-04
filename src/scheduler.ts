/**
 * 用递归 setTimeout 而不是 setInterval:如果一次采集耗时超过了间隔本身
 * (比如 GPU/Docker 的子进程调用抖动),setInterval 会让任务重叠排队,
 * 递归调度则天然保证"上一次跑完才排下一次",不会越攒越多。
 */
export class Poller {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private running = false;

  constructor(
    private readonly task: () => Promise<void>,
    private intervalMs: number,
  ) {}

  start(): void {
    this.scheduleNext(0);
  }

  setInterval(ms: number): void {
    this.intervalMs = ms;
  }

  /** 供测试/手动刷新命令使用:立即执行一次,不等待下一个调度周期。 */
  async runNow(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      await this.task();
    } finally {
      this.running = false;
    }
  }

  private scheduleNext(delay: number): void {
    if (this.disposed) {
      return;
    }
    this.timer = setTimeout(() => {
      if (this.disposed) {
        return;
      }
      void this.runNow().finally(() => this.scheduleNext(this.intervalMs));
    }, delay);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
