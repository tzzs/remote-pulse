import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ThrottledProbe } from '../src/util/platform';
import { candidateSockets } from '../src/collectors/docker';
import { isVirtualInterface, parseNetDev } from '../src/collectors/network';
import { formatRateFixed } from '../src/util/sparkline';
import { RingBuffer } from '../src/store/ringBuffer';

test('ThrottledProbe: 失败按节流重试,成功后短路不再探测', async () => {
  let calls = 0;
  const probe = new ThrottledProbe(async () => ++calls === 2, 1000);
  assert.equal(await probe.check(10_000), false);
  assert.equal(await probe.check(10_500), false); // 节流窗口内直接 false,不探测
  assert.equal(calls, 1);
  assert.equal(await probe.check(11_000), true);
  assert.equal(calls, 2);
  assert.equal(await probe.check(11_100), true);
  assert.equal(await probe.check(999_999), true); // 成功后永不重探
  assert.equal(calls, 2);
});

test('candidateSockets: DOCKER_HOST unix:// 优先,其次系统 socket,再 rootless/podman', () => {
  const list = candidateSockets({ DOCKER_HOST: 'unix:///custom/docker.sock', XDG_RUNTIME_DIR: '/run/user/1000' });
  assert.deepEqual(list, ['/custom/docker.sock', '/var/run/docker.sock', '/run/user/1000/docker.sock', '/run/user/1000/podman/podman.sock']);
});

test('candidateSockets: tcp:// 形式的 DOCKER_HOST 不适用 unix socket,忽略之', () => {
  const list = candidateSockets({ DOCKER_HOST: 'tcp://1.2.3.4:2375', XDG_RUNTIME_DIR: '/run/user/0' });
  assert.equal(list[0], '/var/run/docker.sock');
  assert.ok(!list.some(p => p.includes('1.2.3.4')));
});

test('isVirtualInterface: 排除 lo/docker0/veth/br- 等,保留 eth0/wlan0/bond0', () => {
  for (const iface of ['lo', 'docker0', 'veth1a2b3c', 'br-95784f27fb59', 'virbr0', 'tap0', 'dummy0']) {
    assert.equal(isVirtualInterface(iface), true, iface);
  }
  for (const iface of ['eth0', 'wlan0', 'bond0', 'enp3s0']) {
    assert.equal(isVirtualInterface(iface), false, iface);
  }
});

test('parseNetDev: 虚拟接口流量不计入总速率', () => {
  const content = [
    'Inter-| Receive                      | Transmit',
    ' face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed',
    '    lo:  999999   100    0    0    0     0          0         0     999999   100    0    0    0     0       0          0',
    '  eth0: 1000000    10    0    0    0     0          0         0    2000000    10    0    0    0     0       0          0',
    'docker0: 8888888    10    0    0    0     0          0         0    7777777    10    0    0    0     0       0          0',
    'veth12ab: 5555555    10    0    0    0     0          0         0    4444444    10    0    0    0     0       0          0',
  ].join('\n');
  assert.deepEqual(parseNetDev(content), { rxBytes: 1000000, txBytes: 2000000 });
});

test('formatRateFixed: 数字定宽右对齐,单位保持原位', () => {
  assert.equal(formatRateFixed(900_000), '878.9 KB/s');
  assert.equal(formatRateFixed(12_000), ' 11.7 KB/s');
  assert.equal(formatRateFixed(0), '    0 B/s');
  assert.equal(formatRateFixed(900_000).length, formatRateFixed(12_000).length);
});

test('RingBuffer 写满后按覆盖最旧元素的环形语义工作', () => {
  const buf = new RingBuffer<number>(3);
  for (const v of [1, 2, 3, 4, 5]) {
    buf.push(v);
  }
  assert.deepEqual(buf.toArray(), [3, 4, 5]);
  assert.equal(buf.last(), 5);
  assert.equal(buf.length, 3);
  buf.push(6);
  assert.deepEqual(buf.toArray(), [4, 5, 6]);
  buf.clear();
  assert.deepEqual(buf.toArray(), []);
  assert.equal(buf.last(), undefined);
});
