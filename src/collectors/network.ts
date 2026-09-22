import * as fs from 'fs';
import { NetSample, NetworkRate } from '../types';
import { isPathReadable } from '../util/platform';

const PROC_NET_DEV = '/proc/net/dev';

/**
 * 默认排除的虚拟网卡。跑容器的机器上 docker0/veth* 承载的是宿主机内部的容器间流量,
 * 把它们加进"网速"里会凭空多出几百 MB/s——用户看到的是一个和自己感知完全对不上的数字。
 * tun/tap 同理:VPN 流量在 tun0 和物理网卡上各记一次,不排除就会翻倍。
 */
const VIRTUAL_IFACE_PATTERNS = [
  /^lo$/,
  /^docker\d*$/,
  /^br-/,
  /^bridge\d*$/,
  /^veth/,
  /^virbr/,
  /^vmnet/,
  /^tun\d*$/,
  /^tap\d*$/,
  /^cni/,
  /^flannel/,
  /^cali/,
  /^dummy\d*$/,
  /^kube-/,
];

export function isVirtualInterface(iface: string): boolean {
  return VIRTUAL_IFACE_PATTERNS.some(pattern => pattern.test(iface));
}

/**
 * 解析 /proc/net/dev,累加网卡的收发字节数。
 * 格式(跳过前两行表头): iface: rxBytes rxPackets ... txBytes txPackets ...
 *
 * allowList 非空时只统计其中列出的网卡(用户显式指定,不再做任何过滤);
 * 为空时统计全部物理网卡,虚拟网卡按 VIRTUAL_IFACE_PATTERNS 排除。
 */
export function parseNetDev(content: string, allowList: string[] = []): NetSample {
  const allowed = new Set(allowList);
  const lines = content.split('\n').slice(2);
  let rxBytes = 0;
  let txBytes = 0;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) {
      continue;
    }
    const iface = line.slice(0, colonIndex).trim();
    if (allowed.size > 0 ? !allowed.has(iface) : isVirtualInterface(iface)) {
      continue;
    }
    const fields = line.slice(colonIndex + 1).trim().split(/\s+/).map(Number);
    rxBytes += fields[0] || 0;
    txBytes += fields[8] || 0;
  }
  return { rxBytes, txBytes };
}

export function calcNetworkRate(
  prev: NetSample & { timestamp: number },
  curr: NetSample & { timestamp: number },
): NetworkRate {
  const intervalSec = (curr.timestamp - prev.timestamp) / 1000;
  if (intervalSec <= 0) {
    return { rxRate: 0, txRate: 0 };
  }
  return {
    rxRate: Math.max(0, (curr.rxBytes - prev.rxBytes) / intervalSec),
    txRate: Math.max(0, (curr.txBytes - prev.txBytes) / intervalSec),
  };
}

export class NetworkCollector {
  private prev: (NetSample & { timestamp: number }) | undefined;
  /** 网卡白名单变了,累计基线的口径也就变了,必须丢掉上一次采样,否则会算出一个巨大的假速率。 */
  private prevAllowKey = '';

  constructor(private readonly allowList: () => string[] = () => []) {}

  /** 非 Linux 远程主机没有 /proc/net/dev,该模块直接不激活,而不是抛错。 */
  async isAvailable(): Promise<boolean> {
    return isPathReadable(PROC_NET_DEV);
  }

  async collect(): Promise<NetworkRate | undefined> {
    if (!(await this.isAvailable())) {
      return undefined;
    }
    const allowList = this.allowList();
    const allowKey = allowList.join(',');
    if (allowKey !== this.prevAllowKey) {
      this.prevAllowKey = allowKey;
      this.prev = undefined;
    }
    const content = await fs.promises.readFile(PROC_NET_DEV, 'utf8');
    const curr = { ...parseNetDev(content, allowList), timestamp: Date.now() };
    const prev = this.prev;
    this.prev = curr;
    if (!prev) {
      return undefined;
    }
    return calcNetworkRate(prev, curr);
  }
}
