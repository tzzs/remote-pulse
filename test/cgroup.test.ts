import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCpuMaxV2,
  parseCpuQuotaV1,
  parseCpuStatUsageUsec,
  parseSingleNumber,
  parseInactiveFile,
  isUnlimited,
} from '../src/util/cgroup';
import { calcCgroupCpuUsage } from '../src/collectors/cpu';

test('parseCpuMaxV2 把 quota/period 折算成核数', () => {
  assert.equal(parseCpuMaxV2('200000 100000'), 2);
  assert.equal(parseCpuMaxV2('50000 100000'), 0.5);
});

test('parseCpuMaxV2 遇到 "max" 返回 undefined,表示没有限额', () => {
  assert.equal(parseCpuMaxV2('max 100000'), undefined);
});

test('parseCpuQuotaV1 的 -1 同样表示没有限额', () => {
  assert.equal(parseCpuQuotaV1('-1', '100000'), undefined);
  assert.equal(parseCpuQuotaV1('400000', '100000'), 4);
});

test('parseCpuStatUsageUsec 取 usage_usec 行', () => {
  const raw = 'usage_usec 12345678\nuser_usec 1000\nsystem_usec 2000\n';
  assert.equal(parseCpuStatUsageUsec(raw), 12345678);
});

test('parseInactiveFile 支持 v1 的 total_ 前缀', () => {
  assert.equal(parseInactiveFile('inactive_file 4096\n'), 4096);
  assert.equal(parseInactiveFile('total_inactive_file 8192\n'), 8192);
  assert.equal(parseInactiveFile('anon 1\n'), 0);
});

test('isUnlimited 把 v1 的巨大哨兵值也视作无限额', () => {
  assert.equal(isUnlimited(parseSingleNumber('max')), true);
  assert.equal(isUnlimited(Number.MAX_SAFE_INTEGER), true);
  assert.equal(isUnlimited(2 * 1024 ** 3), false);
});

test('calcCgroupCpuUsage 的分母是配额核数,不是宿主机核数', () => {
  // 被限到 2 核的容器,1 秒墙上时间里消耗 2 秒 CPU = 额度打满 = 100%。
  const prev = { usageUsec: 0, timestamp: 0 };
  const curr = { usageUsec: 2_000_000, timestamp: 1000 };
  assert.equal(calcCgroupCpuUsage(prev, curr, 2), 100);
  // 同样的消耗,配额是 4 核时只用了一半。
  assert.equal(calcCgroupCpuUsage(prev, curr, 4), 50);
});

test('calcCgroupCpuUsage 把调度抖动产生的 >100% 截断', () => {
  const prev = { usageUsec: 0, timestamp: 0 };
  const curr = { usageUsec: 5_000_000, timestamp: 1000 };
  assert.equal(calcCgroupCpuUsage(prev, curr, 2), 100);
});
