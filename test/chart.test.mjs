import { test } from 'node:test';
import assert from 'node:assert/strict';
import { niceMax, downsample, toY, formatRate, describeChart } from '../media/chart.js';

// 这些函数以前活在扩展侧的一个模板字符串里,既不过语法检查也无法测试。
// 搬进 media/chart.js 之后 webview 和 node:test 可以加载同一份源码(见 media/package.json)。

test('niceMax 覆盖 10~1024 之间的峰值,不会算出比峰值还小的上限', () => {
  // 回归:旧实现的阶梯只到 10,878 KB/s 会落到 "10",算出 10 KB 的轴上限,把线整条顶到轴外面。
  const peak = 878 * 1024;
  assert.ok(niceMax(peak) >= peak);
  assert.equal(niceMax(peak), 1024 * 1024);
});

test('niceMax 按 1024 进制取整,轴标签才是整数的 KB/MB', () => {
  assert.equal(niceMax(1), 1);
  assert.equal(niceMax(1500), 2 * 1024);
  assert.equal(niceMax(3 * 1024 * 1024), 5 * 1024 * 1024);
});

test('niceMax 对非正数/非有限值返回 1,不产生 0 或 NaN 的坐标轴', () => {
  assert.equal(niceMax(0), 1);
  assert.equal(niceMax(-5), 1);
  assert.equal(niceMax(NaN), 1);
});

test('downsample 点数不超过上限时原样返回', () => {
  const values = [1, 2, 3];
  assert.equal(downsample(values, 10), values);
});

test('downsample 取桶内均值,并且恰好产出 maxPoints 个点', () => {
  const values = [0, 10, 20, 30, 40, 50, 60, 70];
  const out = downsample(values, 4);
  assert.equal(out.length, 4);
  assert.deepEqual(out, [5, 25, 45, 65]);
});

test('downsample 对同样长度的数组切出同样的桶,时间轴才能和数值逐点对上', () => {
  const a = downsample([1, 2, 3, 4, 5, 6, 7], 3);
  const b = downsample([10, 20, 30, 40, 50, 60, 70], 3);
  assert.equal(a.length, b.length);
});

test('toY 把 domain 顶端映射到绘图区顶部,底端映射到底部', () => {
  const domain = { min: 0, max: 100 };
  assert.equal(toY(100, domain, 8, 120), 8);
  assert.equal(toY(0, domain, 8, 120), 128);
  assert.equal(toY(50, domain, 8, 120), 68);
});

test('toY 把超出 domain 的值夹住,不画到坐标轴外面', () => {
  const domain = { min: 0, max: 100 };
  assert.equal(toY(150, domain, 8, 120), 8);
  assert.equal(toY(-20, domain, 8, 120), 128);
});

test('formatRate 与扩展侧的 formatRate 同一套二进制单位', () => {
  assert.equal(formatRate(0), '0 B/s');
  assert.equal(formatRate(1024), '1.0 KB/s');
  assert.equal(formatRate(-1), '0 B/s');
});

test('describeChart 把图例拼成屏幕阅读器能读的一句话', () => {
  const text = describeChart([{ name: 'CPU', value: '23%' }, { name: 'Memory', value: '61%' }], 'past 30 minutes');
  assert.equal(text, 'past 30 minutes: CPU 23%, Memory 61%');
});

test('describeChart 没有图例时退化成窗口描述,不产出空的 alt 文本', () => {
  assert.equal(describeChart([], 'past 30 minutes'), 'past 30 minutes');
});
