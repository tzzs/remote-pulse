import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMounts, calcDiskStatsFromStatfs, dedupeByCapacity } from '../src/collectors/disk';
import { DiskStats } from '../src/types';

test('parseMounts 过滤虚拟文件系统,只保留真实磁盘挂载点', () => {
  const content = `sysfs /sys sysfs rw 0 0
proc /proc proc rw 0 0
/dev/sda1 / ext4 rw,relatime 0 0
tmpfs /run tmpfs rw 0 0
/dev/sdb1 /data ext4 rw,relatime 0 0
overlay /var/lib/docker/overlay2/xyz/merged overlay rw 0 0
`;
  const mounts = parseMounts(content);
  assert.deepEqual(
    mounts.map(m => m.mountPoint),
    ['/', '/data'],
  );
});

test('calcDiskStatsFromStatfs 按 blocks*bsize 换算容量', () => {
  const stats = calcDiskStatsFromStatfs('/', { blocks: 1000, bsize: 4096, bavail: 250 });
  assert.equal(stats.total, 1000 * 4096);
  assert.equal(stats.used, (1000 - 250) * 4096);
  assert.equal(stats.percent, 75);
});

function disk(mountPoint: string, total: number, used: number): DiskStats {
  return { mountPoint, total, used, percent: total === 0 ? 0 : (used / total) * 100 };
}

test('dedupeByCapacity 合并 total/used 完全相同的挂载点,只留路径更浅的那个', () => {
  // 对应 WSL2 实测场景:/mnt/wslg/distro 是 / 的 bind mount,/usr/lib/wsl/drivers 是 /mnt/c 的 bind mount。
  const disks = [
    disk('/', 1_006_900_000_000, 57_600_000_000),
    disk('/mnt/wslg/distro', 1_006_900_000_000, 57_600_000_000),
    disk('/usr/lib/wsl/drivers', 299_100_000_000, 273_400_000_000),
    disk('/mnt/c', 299_100_000_000, 273_400_000_000),
    disk('/mnt/d', 631_200_000_000, 480_600_000_000),
  ];
  const result = dedupeByCapacity(disks);
  assert.deepEqual(
    result.map(d => d.mountPoint).sort(),
    ['/', '/mnt/c', '/mnt/d'],
  );
});

test('dedupeByCapacity 路径深度相同时按字典序取靠前的,保持结果确定性', () => {
  const disks = [disk('/mnt/z', 100, 50), disk('/mnt/a', 100, 50)];
  const result = dedupeByCapacity(disks);
  assert.deepEqual(result.map(d => d.mountPoint), ['/mnt/a']);
});

test('dedupeByCapacity 容量不同的挂载点即使都叫类似的名字也不会被误合并', () => {
  const disks = [disk('/mnt/c', 100, 50), disk('/mnt/d', 200, 50)];
  const result = dedupeByCapacity(disks);
  assert.equal(result.length, 2);
});
