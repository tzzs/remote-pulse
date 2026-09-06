import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visualWidth, padLabel } from '../src/util/align';

test('visualWidth ASCII 字符按 1 计算', () => {
  assert.equal(visualWidth('CPU'), 3);
});

test('visualWidth 中文字符按 2 计算', () => {
  assert.equal(visualWidth('内存'), 4);
});

test('visualWidth 中英混合正确累加', () => {
  assert.equal(visualWidth('磁盘 /'), 6);
});

test('padLabel 按视觉宽度补空格,而不是按字符数', () => {
  assert.equal(padLabel('CPU', 10), `CPU${' '.repeat(7)}`);
  assert.equal(padLabel('内存', 10), `内存${' '.repeat(6)}`);
});

test('padLabel 已经达到或超过目标宽度时原样返回,不截断', () => {
  assert.equal(padLabel('CPU', 2), 'CPU');
  assert.equal(padLabel('CPU', 3), 'CPU');
});
