import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderStatusBarText } from '../src/util/statusBarText';

const TEMPLATE = '$(pulse) CPU ${cpu}%  MEM ${mem}%';

test('renderStatusBarText 替换 cpu/mem 占位符', () => {
  assert.equal(renderStatusBarText(TEMPLATE, '12', '34', false), '$(pulse) CPU 12%  MEM 34%');
});

test('renderStatusBarText 严重态时把开头图标换成警告图标', () => {
  assert.equal(renderStatusBarText(TEMPLATE, '99', '10', true), '$(warning) CPU 99%  MEM 10%');
});

test('renderStatusBarText 非严重态保留原图标', () => {
  assert.equal(renderStatusBarText(TEMPLATE, '10', '10', false).startsWith('$(pulse)'), true);
});
