import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visualWidth, padLabel, formatTooltipTable } from '../src/util/align';

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

test('formatTooltipTable 按视觉宽度对齐各列,中文标签不会把后面的列顶歪', () => {
  const lines = formatTooltipTable([
    { label: 'CPU', spark: '▁▃▅', value: '9%', detail: '8 cores' },
    { label: '内存', spark: '▂▂▃', value: '61%', detail: '9.8 GB / 16 GB' },
  ]).split('\n');
  // "内存" 视觉宽度是 4,"CPU" 是 3,所以 CPU 那行要多补一个空格才对齐。
  assert.equal(lines[0], 'CPU   ▁▃▅   9%  8 cores');
  assert.equal(lines[1], '内存  ▂▂▃  61%  9.8 GB / 16 GB');
});

test('formatTooltipTable 数值列右对齐,个位数不会和两位数错开', () => {
  const lines = formatTooltipTable([
    { label: 'A', spark: '', value: '9%', detail: '' },
    { label: 'B', spark: '', value: '61%', detail: '' },
  ]).split('\n');
  assert.equal(lines[0], 'A   9%');
  assert.equal(lines[1], 'B  61%');
});

test('formatTooltipTable 在没有 sparkline 的行上不留空列', () => {
  const line = formatTooltipTable([{ label: 'Uptime', spark: '', value: '12d 4h', detail: '' }]);
  assert.equal(line, 'Uptime  12d 4h');
});
