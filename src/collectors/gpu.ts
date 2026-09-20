import { execFile } from 'child_process';
import { promisify } from 'util';
import { CollectorAvailability, GpuStats } from '../types';
import { ThrottledProbe } from '../util/platform';
import { errorMessage } from '../util/error';

const execFileAsync = promisify(execFile);
const QUERY_FIELDS = 'index,name,utilization.gpu,memory.used,memory.total,temperature.gpu';
/** 探测失败后最多每 5 分钟重试一次:WSL 的 GPU 支持(usbipd 附件、驱动加载)可能在扩展激活之后才就绪。 */
const PROBE_RETRY_MS = 5 * 60 * 1000;

export function parseNvidiaSmiCsv(stdout: string): GpuStats[] {
  return stdout
    .trim()
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => {
      const [index, name, util, memUsed, memTotal, temp] = line.split(',').map(s => s.trim());
      return {
        index: Number(index),
        name,
        utilizationPercent: Number(util),
        memoryUsedMb: Number(memUsed),
        memoryTotalMb: Number(memTotal),
        temperatureC: Number(temp),
      };
    });
}

export class GpuCollector {
  /** 探测成功后短路,失败按 PROBE_RETRY_MS 节流重试,而不是"一次失败整个模块永久不激活"。 */
  private readonly availability = new ThrottledProbe(async () => {
    try {
      await execFileAsync('nvidia-smi', ['-L'], { timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }, PROBE_RETRY_MS);
  /**
   * 最近一次采集失败的原因,由调用方(extension.ts)写进输出日志。采集器不 import vscode,
   * 否则纯 `node --test` 跑不到它;对外仍然是返回 undefined 走优雅降级。
   */
  lastError?: string;

  async isAvailable(): Promise<boolean> {
    return this.availability.check();
  }

  /** GPU 只有"装了驱动"和"没有"两种状态;EACCES 之类的极端情况也归入 not_installed 即可。 */
  async availabilityStatus(): Promise<CollectorAvailability> {
    return (await this.availability.check()) ? 'available' : 'not_installed';
  }

  async collect(): Promise<GpuStats[] | undefined> {
    if (!(await this.isAvailable())) {
      return undefined;
    }
    try {
      const { stdout } = await execFileAsync(
        'nvidia-smi',
        [`--query-gpu=${QUERY_FIELDS}`, '--format=csv,noheader,nounits'],
        { timeout: 5000 },
      );
      const stats = parseNvidiaSmiCsv(stdout);
      this.lastError = undefined;
      return stats;
    } catch (err) {
      // `-L` 能过但查询失败(驱动版本不匹配、被 seccomp 拦掉等),留给日志排查。
      this.lastError = errorMessage(err);
      return undefined;
    }
  }
}
