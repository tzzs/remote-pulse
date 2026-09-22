import * as fs from 'fs';
import * as os from 'os';
import { LoadAverage } from '../types';
import { isPathReadable } from '../util/platform';

const PROC_LOADAVG = '/proc/loadavg';

/** 格式:"0.52 0.58 0.59 1/1234 5678" —— 前三个数就是 1/5/15 分钟平均运行队列长度。 */
export function parseLoadAvg(content: string): LoadAverage | undefined {
  const parts = content.trim().split(/\s+/);
  const [one, five, fifteen] = parts.slice(0, 3).map(Number);
  if (![one, five, fifteen].every(Number.isFinite)) {
    return undefined;
  }
  return { one, five, fifteen };
}

/**
 * 负载本身没有上限,要除以核数才有"是否过载"的语义:8 核机器上 load 8 = 刚好跑满。
 * 换算成百分比后就能和 CPU/内存共用同一套阈值配色。
 */
export function loadPercent(load: number, cores: number): number {
  if (cores <= 0) {
    return 0;
  }
  return (load / cores) * 100;
}

export class LoadAverageCollector {
  async collect(): Promise<LoadAverage | undefined> {
    if (await isPathReadable(PROC_LOADAVG)) {
      return parseLoadAvg(await fs.promises.readFile(PROC_LOADAVG, 'utf8'));
    }
    // 非 Linux 兜底:os.loadavg() 在 Windows 上返回 [0,0,0],此时不显示这一行。
    const [one, five, fifteen] = os.loadavg();
    return one === 0 && five === 0 && fifteen === 0 ? undefined : { one, five, fifteen };
  }
}
