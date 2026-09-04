import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMounts, calcDiskStatsFromStatfs } from '../src/collectors/disk';

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
