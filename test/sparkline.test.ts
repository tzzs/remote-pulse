import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSparkline, formatBytes, formatRate, formatUptime, sampleForSparkline } from '../src/util/sparkline';

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

test('sampleForSparkline 点数不超过宽度时原样返回', () => {
  assert.deepEqual(sampleForSparkline([1, 2, 3], 20), [1, 2, 3]);
});

test('sampleForSparkline 压到目标宽度并取桶内均值', () => {
  const values = Array.from({ length: 100 }, (_, i) => i);
  const out = sampleForSparkline(values, 10);
  assert.equal(out.length, 10);
  assert.equal(out[0], 4.5);
});

test('sampleForSparkline 用均值而不是抽样,短暂的尖峰至少能把那一格抬起来', () => {
  const values = new Array(40).fill(0);
  values[21] = 100;
  const out = sampleForSparkline(values, 20);
  assert.ok(out.some(v => v > 0), '尖峰不应该被整个漏掉');
});
