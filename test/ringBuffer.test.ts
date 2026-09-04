import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RingBuffer } from '../src/store/ringBuffer';

test('RingBuffer 超出容量后丢弃最旧数据', () => {
  const buf = new RingBuffer<number>(3);
  buf.push(1);
  buf.push(2);
  buf.push(3);
  buf.push(4);
  assert.deepEqual(buf.toArray(), [2, 3, 4]);
  assert.equal(buf.length, 3);
  assert.equal(buf.last(), 4);
});

test('RingBuffer capacity 非正数时抛出错误', () => {
  assert.throws(() => new RingBuffer<number>(0));
});

test('RingBuffer clear 清空所有数据', () => {
  const buf = new RingBuffer<number>(5);
  buf.push(1);
  buf.clear();
  assert.equal(buf.length, 0);
  assert.equal(buf.last(), undefined);
});
