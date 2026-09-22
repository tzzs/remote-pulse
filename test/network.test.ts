import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNetDev, calcNetworkRate, isVirtualInterface } from '../src/collectors/network';

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

const CONTAINER_SAMPLE = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1000       10    0    0    0     0          0         0     1000      10    0    0    0     0       0          0
  eth0: 500000     300    0    0    0     0          0         0   200000     150    0    0    0     0       0          0
docker0: 900000     900    0    0    0     0          0         0   900000     900    0    0    0     0       0          0
vethabc123: 800000  800    0    0    0     0          0         0   800000     800    0    0    0     0       0          0
  tun0: 400000     400    0    0    0     0          0         0   100000     100    0    0    0     0       0          0
`;

test('parseNetDev 默认排除虚拟网卡,容器间流量不会被算成"网速"', () => {
  // 不排除的话这台机器会凭空多出 docker0 + veth 的 170 万字节内部流量。
  const sample = parseNetDev(CONTAINER_SAMPLE);
  assert.equal(sample.rxBytes, 500000);
  assert.equal(sample.txBytes, 200000);
});

test('parseNetDev 排除 tun/tap,避免 VPN 流量在物理网卡上被重复计算一次', () => {
  const sample = parseNetDev(CONTAINER_SAMPLE);
  assert.equal(sample.rxBytes, 500000);
});

test('parseNetDev 给了白名单就只认白名单,用户显式指定的网卡不再被任何规则过滤', () => {
  const sample = parseNetDev(CONTAINER_SAMPLE, ['docker0']);
  assert.equal(sample.rxBytes, 900000);
  assert.equal(sample.txBytes, 900000);
});

test('isVirtualInterface 只匹配虚拟网卡命名,不误伤 eth/en/wl 开头的物理网卡', () => {
  for (const name of ['docker0', 'br-1a2b3c', 'veth0abc', 'virbr0', 'tun0', 'lo']) {
    assert.equal(isVirtualInterface(name), true, name);
  }
  for (const name of ['eth0', 'ens33', 'wlan0', 'enp0s3', 'wg0']) {
    assert.equal(isVirtualInterface(name), false, name);
  }
});
