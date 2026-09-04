import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNvidiaSmiCsv } from '../src/collectors/gpu';

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
