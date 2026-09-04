import * as fs from 'fs';

const accessibilityCache = new Map<string, boolean>();

/**
 * 检测某个路径是否存在且可读,结果按路径缓存(平台能力在进程生命周期内不会变化)。
 */
export async function isPathReadable(path: string): Promise<boolean> {
  const cached = accessibilityCache.get(path);
  if (cached !== undefined) {
    return cached;
  }
  try {
    await fs.promises.access(path, fs.constants.R_OK);
    accessibilityCache.set(path, true);
    return true;
  } catch {
    accessibilityCache.set(path, false);
    return false;
  }
}

export function resetPlatformCacheForTest(): void {
  accessibilityCache.clear();
}
