import { execFile } from 'child_process';
import { promisify } from 'util';
import { GpuStats } from '../types';

const execFileAsync = promisify(execFile);
const QUERY_FIELDS = 'index,name,utilization.gpu,memory.used,memory.total,temperature.gpu';

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
  private available: boolean | undefined;

  /** 启动时只探测一次 nvidia-smi 是否存在,不存在则整个模块不激活,避免反复重试浪费资源。 */
  async isAvailable(): Promise<boolean> {
    if (this.available !== undefined) {
      return this.available;
    }
    try {
      await execFileAsync('nvidia-smi', ['-L'], { timeout: 3000 });
      this.available = true;
    } catch {
      this.available = false;
    }
    return this.available;
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
      return parseNvidiaSmiCsv(stdout);
    } catch {
      return undefined;
    }
  }
}
