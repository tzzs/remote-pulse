import * as fs from 'fs';

/**
 * Dev Container / Codespaces / 任何 docker exec 进去的远程,`vscode.env.remoteName` 一样是"远程",
 * 但 /proc/meminfo 和 /proc/stat 读到的是**宿主机**的数字。一个被限到 2 GB 的容器里显示宿主机
 * 64 GB 的占用率,数字不是不准,是答非所问——用户关心的是"我还剩多少额度",不是"这台物理机忙不忙"。
 *
 * 所以优先读 cgroup 的配额与用量;没有配额(cpu.max 是 "max"、memory.max 是 "max",或者根本不在
 * 容器里)时返回 undefined,调用方原样退回 /proc 路径。
 */

const V2_CPU_MAX = '/sys/fs/cgroup/cpu.max';
const V2_CPU_STAT = '/sys/fs/cgroup/cpu.stat';
const V2_MEMORY_MAX = '/sys/fs/cgroup/memory.max';
const V2_MEMORY_CURRENT = '/sys/fs/cgroup/memory.current';
const V2_MEMORY_STAT = '/sys/fs/cgroup/memory.stat';

const V1_CPU_QUOTA = '/sys/fs/cgroup/cpu/cpu.cfs_quota_us';
const V1_CPU_PERIOD = '/sys/fs/cgroup/cpu/cpu.cfs_period_us';
const V1_CPU_USAGE = '/sys/fs/cgroup/cpuacct/cpuacct.usage';
const V1_MEMORY_LIMIT = '/sys/fs/cgroup/memory/memory.limit_in_bytes';
const V1_MEMORY_USAGE = '/sys/fs/cgroup/memory/memory.usage_in_bytes';
const V1_MEMORY_STAT = '/sys/fs/cgroup/memory/memory.stat';

/**
 * 没有限额时内核写的是字面量 "max"(v1 是一个接近 2^63 的巨大数),两种都视作"无限额"。
 * v1 的哨兵值没有统一常量,实践中是 PAGE_SIZE 对齐后的 2^63 附近;超过 2^53 一律当无限额,
 * 既覆盖了各种内核版本的具体取值,也远高于任何真实机器的内存。
 */
const UNLIMITED_SENTINEL = Number.MAX_SAFE_INTEGER;

export function isUnlimited(value: number | undefined): boolean {
  return value === undefined || !Number.isFinite(value) || value >= UNLIMITED_SENTINEL;
}

/** cgroup v2 的 cpu.max 格式是 "<quota> <period>",quota 为 "max" 表示不限。返回折算出的核数。 */
export function parseCpuMaxV2(raw: string): number | undefined {
  const [quota, period] = raw.trim().split(/\s+/);
  if (!quota || quota === 'max') {
    return undefined;
  }
  const quotaNum = Number(quota);
  const periodNum = Number(period ?? '100000');
  if (!Number.isFinite(quotaNum) || !Number.isFinite(periodNum) || periodNum <= 0 || quotaNum <= 0) {
    return undefined;
  }
  return quotaNum / periodNum;
}

/** cgroup v1 把 quota/period 拆在两个文件里,quota 为 -1 表示不限。 */
export function parseCpuQuotaV1(quotaRaw: string, periodRaw: string): number | undefined {
  const quota = Number(quotaRaw.trim());
  const period = Number(periodRaw.trim());
  if (!Number.isFinite(quota) || quota <= 0 || !Number.isFinite(period) || period <= 0) {
    return undefined;
  }
  return quota / period;
}

/** cpu.stat 里的 usage_usec 是该 cgroup 累计消耗的 CPU 微秒数,和 /proc/stat 一样靠两次差值算占用。 */
export function parseCpuStatUsageUsec(raw: string): number | undefined {
  const match = /^usage_usec\s+(\d+)/m.exec(raw);
  return match ? Number(match[1]) : undefined;
}

export function parseSingleNumber(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === 'max') {
    return undefined;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * 容器里的"已用内存"要扣掉 inactive_file(可回收的页缓存),否则读过一遍大文件之后
 * 占用率就再也下不来了——`docker stats` 用的是同一套扣减口径。
 */
export function parseInactiveFile(raw: string): number {
  const match = /^(?:total_)?inactive_file\s+(\d+)/m.exec(raw);
  return match ? Number(match[1]) : 0;
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

export interface CgroupCpuLimit {
  quotaCores: number;
  usageUsec: number;
}

export interface CgroupMemoryLimit {
  limitBytes: number;
  usedBytes: number;
}

/** 读一次 cgroup 的 CPU 配额与累计用量;无配额或读不到时返回 undefined,由调用方回退到 /proc/stat。 */
export async function readCgroupCpu(): Promise<CgroupCpuLimit | undefined> {
  const v2Max = await readText(V2_CPU_MAX);
  if (v2Max !== undefined) {
    const quotaCores = parseCpuMaxV2(v2Max);
    if (quotaCores === undefined) {
      return undefined;
    }
    const stat = await readText(V2_CPU_STAT);
    const usageUsec = stat !== undefined ? parseCpuStatUsageUsec(stat) : undefined;
    return usageUsec !== undefined ? { quotaCores, usageUsec } : undefined;
  }

  const [quotaRaw, periodRaw, usageRaw] = await Promise.all([
    readText(V1_CPU_QUOTA),
    readText(V1_CPU_PERIOD),
    readText(V1_CPU_USAGE),
  ]);
  if (quotaRaw === undefined || periodRaw === undefined || usageRaw === undefined) {
    return undefined;
  }
  const quotaCores = parseCpuQuotaV1(quotaRaw, periodRaw);
  const usageNs = parseSingleNumber(usageRaw);
  if (quotaCores === undefined || usageNs === undefined) {
    return undefined;
  }
  // v1 的 cpuacct.usage 是纳秒,统一换算成微秒,让上层只认一种单位。
  return { quotaCores, usageUsec: usageNs / 1000 };
}

/** 读一次 cgroup 的内存限额与用量;无限额或读不到时返回 undefined,由调用方回退到 /proc/meminfo。 */
export async function readCgroupMemory(): Promise<CgroupMemoryLimit | undefined> {
  const v2Max = await readText(V2_MEMORY_MAX);
  if (v2Max !== undefined) {
    const limitBytes = parseSingleNumber(v2Max);
    if (isUnlimited(limitBytes)) {
      return undefined;
    }
    const [currentRaw, statRaw] = await Promise.all([readText(V2_MEMORY_CURRENT), readText(V2_MEMORY_STAT)]);
    const current = currentRaw !== undefined ? parseSingleNumber(currentRaw) : undefined;
    if (current === undefined) {
      return undefined;
    }
    const inactive = statRaw !== undefined ? parseInactiveFile(statRaw) : 0;
    return { limitBytes: limitBytes as number, usedBytes: Math.max(0, current - inactive) };
  }

  const [limitRaw, usageRaw, statRaw] = await Promise.all([
    readText(V1_MEMORY_LIMIT),
    readText(V1_MEMORY_USAGE),
    readText(V1_MEMORY_STAT),
  ]);
  if (limitRaw === undefined || usageRaw === undefined) {
    return undefined;
  }
  const limitBytes = parseSingleNumber(limitRaw);
  const usage = parseSingleNumber(usageRaw);
  if (isUnlimited(limitBytes) || usage === undefined) {
    return undefined;
  }
  const inactive = statRaw !== undefined ? parseInactiveFile(statRaw) : 0;
  return { limitBytes: limitBytes as number, usedBytes: Math.max(0, usage - inactive) };
}
