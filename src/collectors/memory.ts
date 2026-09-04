import * as fs from 'fs';
import * as os from 'os';
import { MemoryStats } from '../types';
import { isPathReadable } from '../util/platform';

const PROC_MEMINFO = '/proc/meminfo';

function parseMemLineKb(content: string, key: string): number | undefined {
  const match = content.match(new RegExp(`^${key}:\\s*(\\d+)\\s*kB`, 'm'));
  return match ? Number(match[1]) * 1024 : undefined;
}

/**
 * 用 MemAvailable 而不是 MemFree 计算已用内存,因为 Linux 会把可回收的
 * buffer/cache 算作"可用",MemFree 会严重低估实际可用内存。
 */
export function parseMemInfo(content: string): MemoryStats {
  const total = parseMemLineKb(content, 'MemTotal');
  const available = parseMemLineKb(content, 'MemAvailable');
  if (total === undefined || available === undefined) {
    throw new Error('无法解析 /proc/meminfo: 缺少 MemTotal 或 MemAvailable 字段');
  }
  const used = Math.max(0, total - available);
  return { total, used, available, percent: total === 0 ? 0 : (used / total) * 100 };
}

async function readLinuxMemInfo(): Promise<MemoryStats> {
  const content = await fs.promises.readFile(PROC_MEMINFO, 'utf8');
  return parseMemInfo(content);
}

/** 非 Linux 兜底:os.totalmem/freemem 精度较低(不区分可回收 cache),但跨平台可用。 */
export function fallbackMemInfo(): MemoryStats {
  const total = os.totalmem();
  const free = os.freemem();
  const used = Math.max(0, total - free);
  return { total, used, available: free, percent: total === 0 ? 0 : (used / total) * 100 };
}

export class MemoryCollector {
  async collect(): Promise<MemoryStats> {
    const useLinux = await isPathReadable(PROC_MEMINFO);
    return useLinux ? readLinuxMemInfo() : fallbackMemInfo();
  }
}
