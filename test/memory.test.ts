import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMemInfo, parseSwapInfo } from '../src/collectors/memory';

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

test('parseSwapInfo 在配置了 swap 时返回用量', () => {
  const content = `MemTotal:       16384000 kB
SwapTotal:       2097152 kB
SwapFree:        1048576 kB
`;
  const swap = parseSwapInfo(content);
  assert.ok(swap);
  assert.equal(swap.total, 2097152 * 1024);
  assert.equal(swap.used, 1048576 * 1024);
  assert.equal(swap.percent, 50);
});

test('parseSwapInfo 在 SwapTotal 为 0 时返回 undefined,不占一行恒为 0% 的位置', () => {
  const content = 'SwapTotal:             0 kB\nSwapFree:              0 kB\n';
  assert.equal(parseSwapInfo(content), undefined);
});

test('parseMemInfo 在容器外标记数据来源为宿主机', () => {
  const stats = parseMemInfo('MemTotal: 100 kB\nMemAvailable: 40 kB\n');
  assert.equal(stats.source, 'host');
});
