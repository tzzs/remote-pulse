import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatHostLabel } from '../src/util/hostLabel';

test('formatHostLabel 普通主机名 + IP', () => {
  assert.equal(formatHostLabel('my-pc', '192.168.1.2', undefined), 'my-pc (192.168.1.2)');
});

test('formatHostLabel 没有 IP 时只显示主机名', () => {
  assert.equal(formatHostLabel('my-pc', undefined, undefined), 'my-pc');
});

test('formatHostLabel 检测到 WSL 时附加发行版标签', () => {
  assert.equal(formatHostLabel('TZZs-HOMEPC', '172.29.141.137', 'Ubuntu'), 'TZZs-HOMEPC [WSL:Ubuntu] (172.29.141.137)');
});

test('formatHostLabel WSL 场景没有 IP', () => {
  assert.equal(formatHostLabel('TZZs-HOMEPC', undefined, 'Ubuntu'), 'TZZs-HOMEPC [WSL:Ubuntu]');
});
