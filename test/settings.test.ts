import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeThresholds, historyCapacityFor } from '../src/util/settings';

test('normalizeThresholds 保持正常顺序不变', () => {
  assert.deepEqual(normalizeThresholds(80, 95), { warning: 80, critical: 95 });
});

test('normalizeThresholds 在两个阈值填反时互换,而不是让黄色永远不出现', () => {
  // calcAlertLevel 先判 critical,不归一化的话 warning=95/critical=80 会让 80% 直接变红。
  assert.deepEqual(normalizeThresholds(95, 80), { warning: 80, critical: 95 });
});

test('normalizeThresholds 两值相等时原样返回', () => {
  assert.deepEqual(normalizeThresholds(90, 90), { warning: 90, critical: 90 });
});

test('historyCapacityFor 按窗口÷间隔推导,并留出 20% 余量', () => {
  // 30 分钟 @ 2 秒 = 900 个点,留余量后 1080。
  assert.equal(historyCapacityFor(30, 2000), 1080);
});

test('historyCapacityFor 采集间隔变大时按比例缩小容量,不再白占内存', () => {
  assert.equal(historyCapacityFor(30, 10000), 216);
});

test('historyCapacityFor 对极端配置设上下界,不让监控插件自己造成内存问题', () => {
  assert.equal(historyCapacityFor(1, 60000), 60);
  assert.equal(historyCapacityFor(240, 500), 20000);
});
