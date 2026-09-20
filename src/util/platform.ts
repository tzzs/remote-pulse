import * as fs from 'fs';

const accessibilityCache = new Map<string, boolean>();

/**
 * 检测某个路径是否存在且可读。成功结果按路径缓存(平台能力一旦就绪不会倒退);
 * 失败不缓存——WSL 冷启动时 /proc 可能短暂未就绪,启动瞬间的失败不代表永远不可用,
 * 缓存 false 会把整个 Linux 采集路径永久禁用。探测开销只有一次 access() 系统调用,可以不省。
 */
export async function isPathReadable(path: string): Promise<boolean> {
  if (accessibilityCache.get(path)) {
    return true;
  }
  try {
    await fs.promises.access(path, fs.constants.R_OK);
    accessibilityCache.set(path, true);
    return true;
  } catch {
    return false;
  }
}

export function resetPlatformCacheForTest(): void {
  accessibilityCache.clear();
}

/**
 * 带节流的可用性探测:成功一次后就短路(能力不会倒退),失败则最多每 retryMs 重试一次。
 * 用于 nvidia-smi / docker.sock 这类"启动时可能还没就绪、之后才出现"的外部依赖——
 * 一次失败永久禁用会让 WSL 晚启动的 GPU/Docker 再也显示不出来。
 */
export class ThrottledProbe {
  private available = false;
  private lastAttempt = 0;

  constructor(
    private readonly probe: () => Promise<boolean>,
    private readonly retryMs: number,
  ) {}

  async check(now: number = Date.now()): Promise<boolean> {
    if (this.available) {
      return true;
    }
    if (now - this.lastAttempt < this.retryMs) {
      return false;
    }
    this.lastAttempt = now;
    this.available = await this.probe();
    return this.available;
  }
}
