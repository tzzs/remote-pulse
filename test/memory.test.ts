import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMemInfo } from '../src/collectors/memory';

test('parseMemInfo 用 MemAvailable 计算已用内存', () => {
  const content = `MemTotal:       16384000 kB
MemFree:         2048000 kB
MemAvailable:    9830400 kB
Buffers:          512000 kB
Cached:          5000000 kB
`;
  const stats = parseMemInfo(content);
  assert.equal(stats.total, 16384000 * 1024);
  assert.equal(stats.available, 9830400 * 1024);
  assert.equal(stats.used, (16384000 - 9830400) * 1024);
  assert.ok(Math.abs(stats.percent - ((16384000 - 9830400) / 16384000) * 100) < 1e-6);
});

test('parseMemInfo 缺少关键字段时抛出明确错误', () => {
  assert.throws(() => parseMemInfo('Foo: 1 kB\n'));
});
