import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNvidiaSmiCsv, selectGpu } from '../src/collectors/gpu';

test('parseNvidiaSmiCsv 解析 nvidia-smi --format=csv,noheader,nounits 输出', () => {
  const stdout = '0, NVIDIA A100, 45, 8192, 40960, 62\n1, NVIDIA A100, 12, 1024, 40960, 55\n';
  const gpus = parseNvidiaSmiCsv(stdout);
  assert.equal(gpus.length, 2);
  assert.deepEqual(gpus[0], {
    index: 0,
    name: 'NVIDIA A100',
    utilizationPercent: 45,
    memoryUsedMb: 8192,
    memoryTotalMb: 40960,
    temperatureC: 62,
  });
});

test('parseNvidiaSmiCsv 空输出返回空数组', () => {
  assert.deepEqual(parseNvidiaSmiCsv('\n'), []);
});

test('selectGpu primary 固定返回 nvidia-smi 顺序里的第一张卡', () => {
  const gpus = parseNvidiaSmiCsv('0, A, 10, 1, 2, 40\n1, B, 90, 1, 2, 70\n');
  assert.equal(selectGpu(gpus, 'primary')?.index, 0);
});

test('selectGpu busiest 返回当前利用率最高的那张卡', () => {
  // 多卡训练常常是 GPU 3 打满而 GPU 0 闲着,盯着 GPU 0 的状态栏会一直显示 0%。
  const gpus = parseNvidiaSmiCsv('0, A, 10, 1, 2, 40\n1, B, 90, 1, 2, 70\n2, C, 55, 1, 2, 60\n');
  assert.equal(selectGpu(gpus, 'busiest')?.index, 1);
});

test('selectGpu 在没有 GPU 时返回 undefined,而不是造一个 0% 的假卡', () => {
  assert.equal(selectGpu(undefined, 'busiest'), undefined);
  assert.equal(selectGpu([], 'primary'), undefined);
});
