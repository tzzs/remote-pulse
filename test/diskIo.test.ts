import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDiskStats, calcDiskIoRate, isWholeDevice } from '../src/collectors/diskIo';

const SAMPLE = `   8       0 sda 100 0 2000 50 200 0 4000 80 0 0 0
   8       1 sda1 90 0 1800 45 180 0 3600 70 0 0 0
 259       0 nvme0n1 10 0 1000 5 20 0 2000 8 0 0 0
   7       0 loop0 1 0 100 1 0 0 0 0 0 0 0
 253       0 dm-0 50 0 900 20 60 0 1800 30 0 0 0
`;

test('parseDiskStats 只累加整块设备,不把分区重复算一遍', () => {
  // sda 和 sda1 的字节数是包含关系,两个都加会把同一次写入算两次。
  const sample = parseDiskStats(SAMPLE);
  assert.equal(sample.readBytes, (2000 + 1000) * 512);
  assert.equal(sample.writeBytes, (4000 + 2000) * 512);
});

test('isWholeDevice 排除分区、loop 与 dm 映射', () => {
  for (const name of ['sda', 'nvme0n1', 'vdb', 'xvda', 'mmcblk0']) {
    assert.equal(isWholeDevice(name), true, name);
  }
  for (const name of ['sda1', 'nvme0n1p2', 'loop0', 'dm-0', 'ram0']) {
    assert.equal(isWholeDevice(name), false, name);
  }
});

test('calcDiskIoRate 按时间间隔算吞吐', () => {
  const prev = { readBytes: 0, writeBytes: 0, timestamp: 0 };
  const curr = { readBytes: 2048, writeBytes: 1024, timestamp: 2000 };
  const rate = calcDiskIoRate(prev, curr);
  assert.equal(rate.readRate, 1024);
  assert.equal(rate.writeRate, 512);
});

test('calcDiskIoRate 对计数器回绕(重启后归零)返回 0 而不是负数', () => {
  const prev = { readBytes: 5000, writeBytes: 5000, timestamp: 0 };
  const curr = { readBytes: 10, writeBytes: 10, timestamp: 1000 };
  const rate = calcDiskIoRate(prev, curr);
  assert.equal(rate.readRate, 0);
  assert.equal(rate.writeRate, 0);
});
