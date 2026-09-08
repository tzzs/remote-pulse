import { test } from 'node:test';
import assert from 'node:assert/strict';
import { iconGlyphFor } from '../src/util/statusBarText';

const TEMPLATE = '$(pulse) CPU ${cpu}%  MEM ${mem}%';

test('iconGlyphFor 从模板开头抠出图标', () => {
  assert.equal(iconGlyphFor(TEMPLATE, false), '$(pulse)');
});

test('iconGlyphFor 支持自定义图标', () => {
  assert.equal(iconGlyphFor('$(dashboard) CPU ${cpu}%  MEM ${mem}%', false), '$(dashboard)');
});

test('iconGlyphFor 严重态时把图标换成警告图标,忽略模板本身的图标', () => {
  assert.equal(iconGlyphFor(TEMPLATE, true), '$(warning)');
  assert.equal(iconGlyphFor('$(dashboard) CPU ${cpu}%  MEM ${mem}%', true), '$(warning)');
});

test('iconGlyphFor 模板不以图标开头时兜底成默认图标', () => {
  assert.equal(iconGlyphFor('CPU ${cpu}%  MEM ${mem}%', false), '$(pulse)');
});
