import * as fs from 'fs';
import { NetSample, NetworkRate } from '../types';
import { isPathReadable } from '../util/platform';

const PROC_NET_DEV = '/proc/net/dev';

/**
 * 解析 /proc/net/dev,累加除回环接口(lo)外所有网卡的收发字节数。
 * 格式(跳过前两行表头): iface: rxBytes rxPackets ... txBytes txPackets ...
 */
export function parseNetDev(content: string): NetSample {
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
    if (iface === 'lo') {
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

async function readNetDev(): Promise<NetSample> {
  const content = await fs.promises.readFile(PROC_NET_DEV, 'utf8');
  return parseNetDev(content);
}

export class NetworkCollector {
  private prev: (NetSample & { timestamp: number }) | undefined;

  /** 非 Linux 远程主机没有 /proc/net/dev,该模块直接不激活,而不是抛错。 */
  async isAvailable(): Promise<boolean> {
    return isPathReadable(PROC_NET_DEV);
  }

  async collect(): Promise<NetworkRate | undefined> {
    if (!(await this.isAvailable())) {
      return undefined;
    }
    const sample = await readNetDev();
    const curr = { ...sample, timestamp: Date.now() };
    const prev = this.prev;
    this.prev = curr;
    if (!prev) {
      return undefined;
    }
    return calcNetworkRate(prev, curr);
  }
}
