import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseContainerStats } from '../src/collectors/docker';

test('parseContainerStats 按 docker stats 同款算法计算 CPU 百分比', () => {
  const raw = {
    cpu_stats: {
      cpu_usage: { total_usage: 2_000_000_000 },
      system_cpu_usage: 10_000_000_000,
      online_cpus: 4,
    },
    precpu_stats: {
      cpu_usage: { total_usage: 1_000_000_000 },
      system_cpu_usage: 8_000_000_000,
    },
    memory_stats: { usage: 104857600, limit: 1073741824 },
  };
  const stats = parseContainerStats('abc123', 'web', raw);
  // cpuDelta=1e9 systemDelta=2e9 -> (1e9/2e9)*4*100 = 200
  assert.equal(stats.cpuPercent, 200);
  assert.equal(stats.memoryUsedBytes, 104857600);
  assert.equal(stats.memoryLimitBytes, 1073741824);
});

test('parseContainerStats systemDelta 为 0 时返回 0,不除零', () => {
  const raw = {
    cpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 500 },
    precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 500 },
  };
  const stats = parseContainerStats('id', 'name', raw);
  assert.equal(stats.cpuPercent, 0);
});
