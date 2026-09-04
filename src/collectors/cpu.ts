import * as fs from 'fs';
import * as os from 'os';
import { CpuStats, CpuTimes } from '../types';
import { isPathReadable } from '../util/platform';

const PROC_STAT = '/proc/stat';

/**
 * 解析 /proc/stat 第一行(汇总所有核心的 cpu 行):
 * cpu  user nice system idle iowait irq softirq [steal guest guest_nice]
 */
export function parseCpuTimes(raw: string): CpuTimes {
  const firstLine = raw.split('\n')[0] ?? '';
  const parts = firstLine.trim().split(/\s+/);
  const nums = parts.slice(1).map(Number);
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0] = nums;
  const idleTime = idle + iowait;
  const totalTime = user + nice + system + idle + iowait + irq + softirq;
  return { idleTime, totalTime };
}

export function parseCpuCoreCount(raw: string): number {
  const count = raw.split('\n').filter(line => /^cpu\d+\s/.test(line)).length;
  return count > 0 ? count : 1;
}

/**
 * 两次采样做差值计算使用率,比读取 loadavg 更贴近"此刻"的真实占用,
 * 且不受历史 1/5/15 分钟平滑窗口的滞后影响。
 */
export function calcCpuUsage(prev: CpuTimes, curr: CpuTimes): number {
  const idleDelta = curr.idleTime - prev.idleTime;
  const totalDelta = curr.totalTime - prev.totalTime;
  if (totalDelta <= 0) {
    return 0;
  }
  const usage = (1 - idleDelta / totalDelta) * 100;
  return Math.min(100, Math.max(0, usage));
}

async function readLinuxCpuTimes(): Promise<CpuTimes> {
  const raw = await fs.promises.readFile(PROC_STAT, 'utf8');
  return parseCpuTimes(raw);
}

async function readLinuxCoreCount(): Promise<number> {
  const raw = await fs.promises.readFile(PROC_STAT, 'utf8');
  return parseCpuCoreCount(raw);
}

/** 非 Linux(如 SSH 到 macOS 主机)的兜底实现:用 os.cpus() 的累计时间做同样的增量计算。 */
export function fallbackCpuTimes(): CpuTimes {
  const cpus = os.cpus();
  let idleTime = 0;
  let totalTime = 0;
  for (const cpu of cpus) {
    idleTime += cpu.times.idle;
    totalTime += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idleTime, totalTime };
}

export class CpuCollector {
  private prevLinux: CpuTimes | undefined;
  private prevFallback: CpuTimes | undefined;

  async collect(): Promise<CpuStats | undefined> {
    const useLinux = await isPathReadable(PROC_STAT);
    if (useLinux) {
      const curr = await readLinuxCpuTimes();
      const prev = this.prevLinux;
      this.prevLinux = curr;
      if (!prev) {
        return undefined;
      }
      const cores = await readLinuxCoreCount();
      return { percent: calcCpuUsage(prev, curr), cores };
    }

    const curr = fallbackCpuTimes();
    const prev = this.prevFallback;
    this.prevFallback = curr;
    if (!prev) {
      return undefined;
    }
    return { percent: calcCpuUsage(prev, curr), cores: os.cpus().length || 1 };
  }
}
