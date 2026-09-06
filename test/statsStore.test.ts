import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StatsStore, calcAlertLevel, maxAlertLevel, foregroundColorIdFor, backgroundColorIdFor } from '../src/store/statsStore';

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

test('foregroundColorIdFor 只有 normal 态返回绿色,其余交给背景色', () => {
  assert.equal(foregroundColorIdFor('normal'), 'charts.green');
  assert.equal(foregroundColorIdFor('warning'), undefined);
  assert.equal(foregroundColorIdFor('critical'), undefined);
});

test('backgroundColorIdFor 按级别映射官方支持的语义背景色', () => {
  assert.equal(backgroundColorIdFor('normal'), undefined);
  assert.equal(backgroundColorIdFor('warning'), 'statusBarItem.warningBackground');
  assert.equal(backgroundColorIdFor('critical'), 'statusBarItem.errorBackground');
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
