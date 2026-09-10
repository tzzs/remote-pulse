import * as fs from 'fs';
import { DiskStats, MountEntry } from '../types';
import { isPathReadable } from '../util/platform';

const PROC_MOUNTS = '/proc/mounts';

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

function pathDepth(mountPoint: string): number {
  return mountPoint.split('/').filter(Boolean).length;
}

/**
 * 同一块底层存储经常被挂载在不止一个路径下——WSL2 的 /mnt/wslg/distro 是发行版根文件系统的
 * bind mount,和 / 是同一块盘;/usr/lib/wsl/drivers 挂的是 Windows C 盘,和 /mnt/c 也是同一块。
 * Node 的 fs.statfs 不暴露设备号之类能直接判断"同一个文件系统"的字段,但 total/used 字节数
 * 完全相同这件事本身概率极低,足够当作"同一块盘"的判据。撞上了就留路径更浅的那个——
 * bind mount 的目标路径几乎总是比源路径更深,浅路径更接近用户会关心的那个"名字"。
 */
export function dedupeByCapacity(disks: DiskStats[]): DiskStats[] {
  const byCapacity = new Map<string, DiskStats>();
  for (const disk of disks) {
    const key = `${disk.total}:${disk.used}`;
    const existing = byCapacity.get(key);
    if (
      !existing ||
      pathDepth(disk.mountPoint) < pathDepth(existing.mountPoint) ||
      (pathDepth(disk.mountPoint) === pathDepth(existing.mountPoint) && disk.mountPoint < existing.mountPoint)
    ) {
      byCapacity.set(key, disk);
    }
  }
  return Array.from(byCapacity.values());
}

export class DiskCollector {
  constructor(private readonly configuredMountPoints: () => string[]) {}

  async collect(): Promise<DiskStats[]> {
    const configured = this.configuredMountPoints();
    const candidates = configured.length > 0 ? configured : await this.autoDiscoverMountPoints();

    const results = await Promise.all(candidates.map(readDiskUsage));
    const valid = results.filter((s): s is DiskStats => s !== undefined);

    if (configured.length > 0) {
      // 用户手动列出的挂载点,即使其中几个其实是同一块盘也原样展示——是不是重复由用户自己判断,
      // 这里不替用户做主砍掉他明确列出来的路径。
      return valid;
    }
    // 自动发现时展示全部真实挂载点(已经过滤掉虚拟文件系统 + 同一块盘的重复挂载),不再只挑
    // 使用率最高的几个——按使用率降序排,只是为了让最该关注的挂载点排在前面。
    return dedupeByCapacity(valid).sort((a, b) => b.percent - a.percent);
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
