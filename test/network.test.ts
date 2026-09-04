import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNetDev, calcNetworkRate } from '../src/collectors/network';

const SAMPLE = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1000       10    0    0    0     0          0         0     1000      10    0    0    0     0       0          0
  eth0: 500000     300    0    0    0     0          0         0   200000     150    0    0    0     0       0          0
`;

test('parseNetDev 累加除 lo 外所有网卡流量,忽略回环接口', () => {
  const sample = parseNetDev(SAMPLE);
  assert.equal(sample.rxBytes, 500000);
  assert.equal(sample.txBytes, 200000);
});

test('calcNetworkRate 按时间间隔计算收发速率', () => {
  const prev = { rxBytes: 1000, txBytes: 2000, timestamp: 0 };
  const curr = { rxBytes: 3000, txBytes: 2500, timestamp: 2000 };
  const rate = calcNetworkRate(prev, curr);
  assert.equal(rate.rxRate, 1000); // (3000-1000)/2s
  assert.equal(rate.txRate, 250); // (2500-2000)/2s
});

test('calcNetworkRate 时间间隔非正时返回 0,不产生负值或除零', () => {
  const prev = { rxBytes: 1000, txBytes: 2000, timestamp: 1000 };
  const curr = { rxBytes: 900, txBytes: 1900, timestamp: 1000 };
  const rate = calcNetworkRate(prev, curr);
  assert.deepEqual(rate, { rxRate: 0, txRate: 0 });
});
