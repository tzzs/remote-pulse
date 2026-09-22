import * as fs from 'fs';
import * as path from 'path';
import { ProcessStats } from '../types';
import { isPathReadable } from '../util/platform';

const PROC = '/proc';

/** Linux 的 USER_HZ 在所有主流架构上都是 100,/proc/[pid]/stat 里的 utime/stime 以此为单位。 */
const USER_HZ = 100;

export interface ProcSample {
  pid: number;
  name: string;
  /** utime + stime,单位是时钟滴答。 */
  cpuTicks: number;
  rssPages: number;
}

/**
 * /proc/[pid]/stat 的进程名字段被括号包着,而且**可以包含空格和括号**
 * (例如 `(Web Content)`、`((sd-pam))`),所以只能从最后一个 ')' 切,不能按空格 split 整行。
 */
export function parseProcStat(pid: number, raw: string): ProcSample | undefined {
  const open = raw.indexOf('(');
  const close = raw.lastIndexOf(')');
  if (open === -1 || close === -1 || close < open) {
    return undefined;
  }
  const name = raw.slice(open + 1, close);
  // close 之后的第一个字段是 state,即整行的第 3 个字段;下标因此比 man proc 的编号小 3。
  const rest = raw.slice(close + 2).trim().split(/\s+/);
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  const rssPages = Number(rest[21]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime) || !Number.isFinite(rssPages)) {
    return undefined;
  }
  return { pid, name, cpuTicks: utime + stime, rssPages };
}

/**
 * arm64 上页大小可能是 16K 或 64K,写死 4096 会把内存占用报少一个数量级。
 * 拿本进程的 VmRSS(kB,单位明确)除以它的 rss(页数)就能反推出真实页大小,不需要调任何原生接口。
 */
export async function detectPageSize(): Promise<number> {
  try {
    const [statusRaw, statRaw] = await Promise.all([
      fs.promises.readFile(`${PROC}/self/status`, 'utf8'),
      fs.promises.readFile(`${PROC}/self/stat`, 'utf8'),
    ]);
    const match = /^VmRSS:\s*(\d+)\s*kB/m.exec(statusRaw);
    const sample = parseProcStat(0, statRaw);
    if (match && sample && sample.rssPages > 0) {
      const size = (Number(match[1]) * 1024) / sample.rssPages;
      // 只接受 2 的幂,反推出非整页说明两次读取之间 RSS 变了,这时宁可用默认值。
      if (Number.isInteger(Math.log2(size))) {
        return size;
      }
    }
  } catch {
    // 落到默认值
  }
  return 4096;
}

export function isPid(entry: string): boolean {
  return /^\d+$/.test(entry);
}

/**
 * 进程级 CPU 占用同样靠两次采样差值,分母是"墙上时间 × 核数",于是单核打满的进程在
 * 8 核机器上显示 12.5% —— 与 CPU 那一行的总占用同口径,两个数字能直接相加对照。
 * (`top` 默认显示的是 100% = 一个核,所以同一个进程在 top 里会是 100%,这里是 12.5%。)
 */
export function calcProcessCpuPercent(
  prevTicks: number,
  currTicks: number,
  elapsedMs: number,
  cores: number,
): number {
  if (elapsedMs <= 0 || cores <= 0) {
    return 0;
  }
  const elapsedTicks = (elapsedMs / 1000) * USER_HZ * cores;
  if (elapsedTicks <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, ((currTicks - prevTicks) / elapsedTicks) * 100));
}

export class ProcessCollector {
  private prevTicks = new Map<number, number>();
  private prevTimestamp = 0;
  private pageSize: number | undefined;

  constructor(private readonly topCount: () => number) {}

  async collect(cores: number): Promise<ProcessStats[] | undefined> {
    if (!(await isPathReadable(`${PROC}/self/stat`))) {
      return undefined;
    }
    if (this.pageSize === undefined) {
      this.pageSize = await detectPageSize();
    }

    let entries: string[];
    try {
      entries = await fs.promises.readdir(PROC);
    } catch {
      return undefined;
    }

    const now = Date.now();
    const samples = await Promise.all(
      entries.filter(isPid).map(async (entry): Promise<ProcSample | undefined> => {
        try {
          // 进程随时可能退出,单个读取失败是常态而不是异常,静默跳过即可。
          const raw = await fs.promises.readFile(path.join(PROC, entry, 'stat'), 'utf8');
          return parseProcStat(Number(entry), raw);
        } catch {
          return undefined;
        }
      }),
    );

    const elapsedMs = this.prevTimestamp === 0 ? 0 : now - this.prevTimestamp;
    const nextTicks = new Map<number, number>();
    const stats: ProcessStats[] = [];
    for (const sample of samples) {
      if (!sample) {
        continue;
      }
      nextTicks.set(sample.pid, sample.cpuTicks);
      const prev = this.prevTicks.get(sample.pid);
      // 首轮(或进程刚出现)没有基线,CPU 记 0,下一轮就准了——总比显示一个假数字好。
      const cpuPercent = prev === undefined || elapsedMs <= 0 ? 0 : calcProcessCpuPercent(prev, sample.cpuTicks, elapsedMs, cores);
      stats.push({
        pid: sample.pid,
        name: sample.name,
        cpuPercent,
        memoryBytes: sample.rssPages * (this.pageSize ?? 4096),
      });
    }
    // 退出的进程要从基线里清掉,否则 map 会随着机器上进程的来来去去无限增长。
    this.prevTicks = nextTicks;
    this.prevTimestamp = now;

    if (elapsedMs <= 0) {
      return undefined;
    }
    const top = Math.max(1, this.topCount());
    return stats
      .sort((a, b) => b.cpuPercent - a.cpuPercent || b.memoryBytes - a.memoryBytes)
      .slice(0, top);
  }
}
