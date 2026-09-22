import * as fs from 'fs';
import { DiskIoRate, DiskIoSample } from '../types';
import { isPathReadable } from '../util/platform';

const PROC_DISKSTATS = '/proc/diskstats';

/** 内核统计里一个扇区恒为 512 字节,与文件系统的块大小无关。 */
const SECTOR_BYTES = 512;

/**
 * 只统计整块设备,不统计分区——/proc/diskstats 里 sda 和 sda1 的字节数是包含关系,
 * 两个都加就会把同一次写入算两遍。dm-*(LVM/加密卷)与底层 sd* 同样重复,一并排除。
 */
const WHOLE_DEVICE = /^(sd[a-z]+|hd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;

export function isWholeDevice(name: string): boolean {
  return WHOLE_DEVICE.test(name);
}

/**
 * /proc/diskstats 每行: major minor name reads merged sectorsRead msRead writes merged sectorsWritten ...
 * 设备名之后的第 3 个数是累计读扇区,第 7 个是累计写扇区。
 */
export function parseDiskStats(content: string): DiskIoSample {
  let readSectors = 0;
  let writeSectors = 0;
  for (const rawLine of content.split('\n')) {
    const parts = rawLine.trim().split(/\s+/);
    if (parts.length < 10) {
      continue;
    }
    const name = parts[2];
    if (!isWholeDevice(name)) {
      continue;
    }
    readSectors += Number(parts[5]) || 0;
    writeSectors += Number(parts[9]) || 0;
  }
  return { readBytes: readSectors * SECTOR_BYTES, writeBytes: writeSectors * SECTOR_BYTES };
}

export function calcDiskIoRate(
  prev: DiskIoSample & { timestamp: number },
  curr: DiskIoSample & { timestamp: number },
): DiskIoRate {
  const intervalSec = (curr.timestamp - prev.timestamp) / 1000;
  if (intervalSec <= 0) {
    return { readRate: 0, writeRate: 0 };
  }
  return {
    readRate: Math.max(0, (curr.readBytes - prev.readBytes) / intervalSec),
    writeRate: Math.max(0, (curr.writeBytes - prev.writeBytes) / intervalSec),
  };
}

export class DiskIoCollector {
  private prev: (DiskIoSample & { timestamp: number }) | undefined;

  async collect(): Promise<DiskIoRate | undefined> {
    if (!(await isPathReadable(PROC_DISKSTATS))) {
      return undefined;
    }
    const content = await fs.promises.readFile(PROC_DISKSTATS, 'utf8');
    const curr = { ...parseDiskStats(content), timestamp: Date.now() };
    const prev = this.prev;
    this.prev = curr;
    return prev ? calcDiskIoRate(prev, curr) : undefined;
  }
}
