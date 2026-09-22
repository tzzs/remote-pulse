import * as fs from 'fs';
import * as os from 'os';
import { CpuStats, CpuTimes } from '../types';
import { isPathReadable } from '../util/platform';
import { readCgroupCpu } from '../util/cgroup';

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

/**
 * cgroup 口径:分母是"配额核数 × 墙上时间",不是宿主机的全部核心。
 * 容器被限到 2 核、两核都打满时返回 100%,这才是用户真正想知道的"额度用了多少"。
 * 超过 100% 的瞬时值(调度抖动、统计窗口错位)截断到 100,避免进度条冲出轨道。
 */
export function calcCgroupCpuUsage(
  prev: { usageUsec: number; timestamp: number },
  curr: { usageUsec: number; timestamp: number },
  quotaCores: number,
): number {
  const elapsedUsec = (curr.timestamp - prev.timestamp) * 1000;
  if (elapsedUsec <= 0 || quotaCores <= 0) {
    return 0;
  }
  const usage = ((curr.usageUsec - prev.usageUsec) / (elapsedUsec * quotaCores)) * 100;
  return Math.min(100, Math.max(0, usage));
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
  private prevCgroup: { usageUsec: number; timestamp: number } | undefined;
  /** 逻辑核数在进程生命周期内不变,之前每 2 秒会为了数它把 /proc/stat 整个再读一遍。 */
  private cachedCores: number | undefined;

  constructor(private readonly cgroupAware: () => boolean = () => true) {}

  async collect(): Promise<CpuStats | undefined> {
    const useLinux = await isPathReadable(PROC_STAT);
    if (!useLinux) {
      const curr = fallbackCpuTimes();
      const prev = this.prevFallback;
      this.prevFallback = curr;
      if (!prev) {
        return undefined;
      }
      return { percent: calcCpuUsage(prev, curr), cores: os.cpus().length || 1, source: 'host' };
    }

    // 一次读取同时供增量计算和核数统计,不再为了数核心第二次打开同一个文件。
    const raw = await fs.promises.readFile(PROC_STAT, 'utf8');
    if (this.cachedCores === undefined) {
      this.cachedCores = parseCpuCoreCount(raw);
    }
    const hostCores = this.cachedCores;

    if (this.cgroupAware()) {
      const cgroup = await readCgroupCpu();
      if (cgroup) {
        const curr = { usageUsec: cgroup.usageUsec, timestamp: Date.now() };
        const prev = this.prevCgroup;
        this.prevCgroup = curr;
        // 宿主机口径的基线照样推进,用户关掉 cgroupAware 时不用再等一轮才有数。
        this.prevLinux = parseCpuTimes(raw);
        if (prev) {
          return {
            percent: calcCgroupCpuUsage(prev, curr, cgroup.quotaCores),
            cores: hostCores,
            source: 'cgroup',
            quotaCores: cgroup.quotaCores,
          };
        }
        return undefined;
      }
      this.prevCgroup = undefined;
    }

    const curr = parseCpuTimes(raw);
    const prev = this.prevLinux;
    this.prevLinux = curr;
    if (!prev) {
      return undefined;
    }
    return { percent: calcCpuUsage(prev, curr), cores: hostCores, source: 'host' };
  }
}
