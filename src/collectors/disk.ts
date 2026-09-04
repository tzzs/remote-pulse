import * as fs from 'fs';
import { DiskStats, MountEntry } from '../types';
import { isPathReadable } from '../util/platform';

const PROC_MOUNTS = '/proc/mounts';
const DEFAULT_TOP_N = 3;

/** 虚拟/伪文件系统,不代表真实磁盘容量,展示这些挂载点对用户没有意义。 */
const IGNORED_FS_TYPES = new Set([
  'proc', 'sysfs', 'devtmpfs', 'devpts', 'tmpfs', 'cgroup', 'cgroup2', 'mqueue',
  'debugfs', 'tracefs', 'securityfs', 'pstore', 'bpf', 'autofs', 'hugetlbfs',
  'overlay', 'squashfs', 'rpc_pipefs', 'binfmt_misc', 'configfs', 'fusectl', 'nsfs',
]);

export function parseMounts(content: string): MountEntry[] {
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map((line): MountEntry | undefined => {
      const parts = line.split(/\s+/);
      const mountPoint = parts[1];
      const fsType = parts[2];
      if (!mountPoint || !fsType) {
        return undefined;
      }
      return { mountPoint, fsType };
    })
    .filter((entry): entry is MountEntry => entry !== undefined && !IGNORED_FS_TYPES.has(entry.fsType));
}

async function readMountList(): Promise<MountEntry[]> {
  const content = await fs.promises.readFile(PROC_MOUNTS, 'utf8');
  return parseMounts(content);
}

export function calcDiskStatsFromStatfs(
  mountPoint: string,
  stats: { blocks: number; bsize: number; bavail: number },
): DiskStats {
  const total = stats.blocks * stats.bsize;
  const free = stats.bavail * stats.bsize;
  const used = Math.max(0, total - free);
  return { mountPoint, total, used, percent: total === 0 ? 0 : (used / total) * 100 };
}

async function readDiskUsage(mountPoint: string): Promise<DiskStats | undefined> {
  try {
    const stats = await fs.promises.statfs(mountPoint);
    return calcDiskStatsFromStatfs(mountPoint, stats);
  } catch {
    return undefined;
  }
}

export class DiskCollector {
  constructor(private readonly configuredMountPoints: () => string[]) {}

  async collect(): Promise<DiskStats[]> {
    const configured = this.configuredMountPoints();
    const candidates = configured.length > 0 ? configured : await this.autoDiscoverMountPoints();

    const results = await Promise.all(candidates.map(readDiskUsage));
    const valid = results.filter((s): s is DiskStats => s !== undefined);

    if (configured.length > 0) {
      return valid;
    }
    return valid.sort((a, b) => b.percent - a.percent).slice(0, DEFAULT_TOP_N);
  }

  private async autoDiscoverMountPoints(): Promise<string[]> {
    if (await isPathReadable(PROC_MOUNTS)) {
      const mounts = await readMountList();
      const points = mounts.map(m => m.mountPoint);
      return points.length > 0 ? points : ['/'];
    }
    // 非 Linux 兜底:至少展示根目录所在挂载点
    return ['/'];
  }
}
