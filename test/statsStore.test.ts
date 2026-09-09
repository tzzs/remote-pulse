import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StatsStore, calcAlertLevel, maxAlertLevel, foregroundColorFor } from '../src/store/statsStore';

test('calcAlertLevel 按阈值分级', () => {
  assert.equal(calcAlertLevel(50, 80, 95), 'normal');
  assert.equal(calcAlertLevel(80, 80, 95), 'warning');
  assert.equal(calcAlertLevel(95, 80, 95), 'critical');
});

test('maxAlertLevel 取多个级别里最严重的一个', () => {
  assert.equal(maxAlertLevel('normal', 'normal'), 'normal');
  assert.equal(maxAlertLevel('normal', 'warning'), 'warning');
  assert.equal(maxAlertLevel('critical', 'warning'), 'critical');
  assert.equal(maxAlertLevel('normal', 'critical', 'warning'), 'critical');
});

test('foregroundColorFor 按级别映射固定十六进制色值,不经过任何主题 token', () => {
  assert.equal(foregroundColorFor('normal', false), '#23d18b');
  assert.equal(foregroundColorFor('warning', false), '#f5f543');
  assert.equal(foregroundColorFor('critical', false), '#f14c4c');
});

test('foregroundColorFor 浅色主题下用更深的一套取值,保证在白色背景上仍有对比度', () => {
  assert.equal(foregroundColorFor('normal', true), '#16794f');
  assert.equal(foregroundColorFor('warning', true), '#9a6700');
  assert.equal(foregroundColorFor('critical', true), '#cf222e');
});

test('StatsStore.recentValues 只返回窗口内且已定义的数值', () => {
  const store = new StatsStore(10);
  const now = Date.now();
  store.push({ timestamp: now - 60_000, cpu: { percent: 10, cores: 4 } });
  store.push({ timestamp: now - 1000, cpu: { percent: 20, cores: 4 } });
  store.push({ timestamp: now, memory: { total: 1, used: 1, available: 0, percent: 100 } });

  const values = store.recentValues(30_000, s => s.cpu?.percent);
  assert.deepEqual(values, [20]);
});

test('StatsStore.latest 返回最近一次快照', () => {
  const store = new StatsStore(10);
  store.push({ timestamp: 1 });
  store.push({ timestamp: 2 });
  assert.equal(store.latest()?.timestamp, 2);
});
