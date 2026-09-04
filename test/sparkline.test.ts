import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSparkline, formatBytes, formatRate, formatUptime } from '../src/util/sparkline';

test('renderSparkline 空数组返回空字符串', () => {
  assert.equal(renderSparkline([]), '');
});

test('renderSparkline 边界值映射到首尾字符', () => {
  const result = renderSparkline([0, 100], 0, 100);
  assert.equal(result.length, 2);
  assert.equal(result[0], '▁');
  assert.equal(result[1], '█');
});

test('formatBytes 按 1024 进制换算单位', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1024 * 1024 * 3), '3.0 MB');
});

test('formatRate 追加 /s 后缀', () => {
  assert.equal(formatRate(1024), '1.0 KB/s');
});

test('formatUptime 按天/小时/分钟分级展示', () => {
  assert.equal(formatUptime(90), '1m');
  assert.equal(formatUptime(3660), '1h 1m');
  assert.equal(formatUptime(90000), '1d 1h');
});
