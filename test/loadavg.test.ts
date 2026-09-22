import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLoadAvg, loadPercent } from '../src/collectors/loadavg';

test('parseLoadAvg 取 1/5/15 分钟平均值', () => {
  const load = parseLoadAvg('0.52 0.58 0.59 1/1234 5678\n');
  assert.deepEqual(load, { one: 0.52, five: 0.58, fifteen: 0.59 });
});

test('parseLoadAvg 对畸形内容返回 undefined', () => {
  assert.equal(parseLoadAvg('not a load average\n'), undefined);
});

test('loadPercent 除以核数才有"是否过载"的语义', () => {
  // 8 核机器上 load 8 就是刚好跑满。
  assert.equal(loadPercent(8, 8), 100);
  assert.equal(loadPercent(4, 8), 50);
  assert.equal(loadPercent(16, 8), 200);
});

test('loadPercent 核数为 0 时返回 0,不除零', () => {
  assert.equal(loadPercent(4, 0), 0);
});
