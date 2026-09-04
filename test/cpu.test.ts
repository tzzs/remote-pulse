import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCpuTimes, parseCpuCoreCount, calcCpuUsage } from '../src/collectors/cpu';

test('parseCpuTimes 解析 /proc/stat 第一行', () => {
  const raw = 'cpu  1000 0 500 8000 100 0 50\ncpu0 500 0 250 4000 50 0 25\n';
  const times = parseCpuTimes(raw);
  assert.equal(times.idleTime, 8000 + 100);
  assert.equal(times.totalTime, 1000 + 0 + 500 + 8000 + 100 + 0 + 50);
});

test('parseCpuCoreCount 统计 cpuN 行数量', () => {
  const raw = 'cpu  1 2 3 4 5 6 7\ncpu0 1 1 1 1 1 1 1\ncpu1 1 1 1 1 1 1 1\nintr 123\n';
  assert.equal(parseCpuCoreCount(raw), 2);
});

test('parseCpuCoreCount 无核心行时至少返回 1', () => {
  const raw = 'cpu  1 2 3 4 5 6 7\nintr 123\n';
  assert.equal(parseCpuCoreCount(raw), 1);
});

test('calcCpuUsage 计算两次采样间的使用率', () => {
  const prev = { idleTime: 8000, totalTime: 9650 };
  const curr = { idleTime: 8100, totalTime: 9850 };
  // idleDelta=100 totalDelta=200 -> usage = (1-0.5)*100 = 50
  assert.equal(calcCpuUsage(prev, curr), 50);
});

test('calcCpuUsage totalDelta 为 0 时返回 0,不除零', () => {
  const same = { idleTime: 100, totalTime: 200 };
  assert.equal(calcCpuUsage(same, same), 0);
});

test('calcCpuUsage 结果被夹在 [0, 100] 区间内', () => {
  const prev = { idleTime: 100, totalTime: 200 };
  const curr = { idleTime: 50, totalTime: 210 }; // idleDelta 为负,异常输入
  const usage = calcCpuUsage(prev, curr);
  assert.ok(usage >= 0 && usage <= 100);
});
