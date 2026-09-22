import * as fs from 'fs';
import * as os from 'os';
import { MemoryStats, SwapStats } from '../types';
import { isPathReadable } from '../util/platform';
import { readCgroupMemory } from '../util/cgroup';

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
    throw new Error('Cannot parse /proc/meminfo: MemTotal or MemAvailable is missing');
  }
  const used = Math.max(0, total - available);
  return { total, used, available, percent: total === 0 ? 0 : (used / total) * 100, source: 'host' };
}

/**
 * 机器没配 swap 时 SwapTotal 是 0——此时返回 undefined 而不是一行 0%,
 * 面板里多一行恒为 0 的指标只会占地方。开始用 swap 往往是 OOM 的前兆,所以一旦有就值得显示。
 */
export function parseSwapInfo(content: string): SwapStats | undefined {
  const total = parseMemLineKb(content, 'SwapTotal');
  const free = parseMemLineKb(content, 'SwapFree');
  if (total === undefined || free === undefined || total === 0) {
    return undefined;
  }
  const used = Math.max(0, total - free);
  return { total, used, percent: (used / total) * 100 };
}

/** 非 Linux 兜底:os.totalmem/freemem 精度较低(不区分可回收 cache),但跨平台可用。 */
export function fallbackMemInfo(): MemoryStats {
  const total = os.totalmem();
  const free = os.freemem();
  const used = Math.max(0, total - free);
  return { total, used, available: free, percent: total === 0 ? 0 : (used / total) * 100, source: 'host' };
}

export interface MemorySample {
  memory: MemoryStats;
  swap?: SwapStats;
}

export class MemoryCollector {
  constructor(private readonly cgroupAware: () => boolean = () => true) {}

  async collect(): Promise<MemorySample> {
    const useLinux = await isPathReadable(PROC_MEMINFO);
    if (!useLinux) {
      return { memory: fallbackMemInfo() };
    }
    const content = await fs.promises.readFile(PROC_MEMINFO, 'utf8');
    const swap = parseSwapInfo(content);

    if (this.cgroupAware()) {
      const cgroup = await readCgroupMemory();
      if (cgroup) {
        const available = Math.max(0, cgroup.limitBytes - cgroup.usedBytes);
        return {
          memory: {
            total: cgroup.limitBytes,
            used: cgroup.usedBytes,
            available,
            percent: cgroup.limitBytes === 0 ? 0 : (cgroup.usedBytes / cgroup.limitBytes) * 100,
            source: 'cgroup',
          },
          swap,
        };
      }
    }
    return { memory: parseMemInfo(content), swap };
  }
}
