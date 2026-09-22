import * as fs from 'fs';
import { DiskStats, MountEntry } from '../types';
import { isPathReadable } from '../util/platform';
import { logThrottled } from '../util/logger';

const PROC_MOUNTS = '/proc/mounts';

/** 单个挂载点的 statfs 超时。挂死的 NFS/CIFS 会让 statfs 在 libuv 线程池里无限期挂住。 */
const STATFS_TIMEOUT_MS = 2000;

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

/**
 * 口径与 `df` 完全一致,这很重要:用户会拿面板里的数字和自己在终端敲的 df 对照,对不上就会当成 bug。
 *
 * - 已用 = (blocks - bfree) × bsize —— 真正被文件占掉的部分
 * - 百分比 = 已用 /(已用 + 可用),分母**不是** total
 *
 * 差别来自 ext4 默认给 root 预留的 5% 块:它既不是"已用"也不对普通用户"可用"。
 * 早先的实现用 bavail 反推已用(used = total - bavail),等于把这 5% 算进了占用——
 * 一块全空的 1 TB 盘会显示 5%,而 df 显示 0%。
 * total 仍然按 blocks 报告,和 df 的 Size 列一致;因此 used/total 与 percent 不会完全相等,这是 df 本来的行为。
 */
export function calcDiskStatsFromStatfs(
  mountPoint: string,
  stats: { blocks: number; bsize: number; bavail: number; bfree?: number },
): DiskStats {
  const total = stats.blocks * stats.bsize;
  // bfree 缺失时退回旧口径,保证异常平台上仍有数可看。
  const free = (stats.bfree ?? stats.bavail) * stats.bsize;
  const available = stats.bavail * stats.bsize;
  const used = Math.max(0, total - free);
  const capacity = used + available;
  return { mountPoint, total, used, percent: capacity === 0 ? 0 : (used / capacity) * 100 };
}

/** statfs 本身没有超时参数,用 Promise.race 给它加一个——超时的挂载点当作读不到,整轮采集继续。 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T | undefined> {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      logThrottled(`disk-timeout:${label}`, `statfs timed out after ${ms}ms: ${label}`);
      resolve(undefined);
    }, ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

async function readDiskUsage(mountPoint: string): Promise<DiskStats | undefined> {
  const stats = await withTimeout(fs.promises.statfs(mountPoint), STATFS_TIMEOUT_MS, mountPoint);
  return stats ? calcDiskStatsFromStatfs(mountPoint, stats) : undefined;
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
