import { execFile } from 'child_process';
import { promisify } from 'util';
import { GpuStats } from '../types';
import { logThrottled, clearThrottle, errorMessage } from '../util/logger';

const execFileAsync = promisify(execFile);
const QUERY_FIELDS = 'index,name,utilization.gpu,memory.used,memory.total,temperature.gpu';

/**
 * 探测到"不可用"时的重探间隔。之前这个结果被缓存到进程结束,于是用户中途装上驱动、
 * 或者 nvidia-persistenced 起来之后,必须重载整个窗口才能被认出来。
 * 只缓存"可用"是永久的(能力不会消失),"不可用"退避重试,既不浪费资源也不会一直错过。
 */
const UNAVAILABLE_RECHECK_MS = 5 * 60 * 1000;

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

/**
 * 多卡机器上"第 0 张卡"是个任意选择:跑训练时经常是 GPU 3 打满而 GPU 0 闲着,
 * 状态栏盯着 GPU 0 就会一直显示 0%。'busiest' 让摘要始终反映最需要被看见的那张卡。
 */
export function selectGpu(gpus: GpuStats[] | undefined, selection: 'primary' | 'busiest'): GpuStats | undefined {
  if (!gpus || gpus.length === 0) {
    return undefined;
  }
  if (selection === 'primary') {
    return gpus[0];
  }
  return gpus.reduce((worst, gpu) => (gpu.utilizationPercent > worst.utilizationPercent ? gpu : worst), gpus[0]);
}

export class GpuCollector {
  private available: boolean | undefined;
  private lastProbeAt = 0;

  /** 可用结果永久缓存;不可用结果在 UNAVAILABLE_RECHECK_MS 之后重探一次。 */
  async isAvailable(): Promise<boolean> {
    if (this.available === true) {
      return true;
    }
    if (this.available === false && Date.now() - this.lastProbeAt < UNAVAILABLE_RECHECK_MS) {
      return false;
    }
    this.lastProbeAt = Date.now();
    try {
      await execFileAsync('nvidia-smi', ['-L'], { timeout: 3000 });
      this.available = true;
      clearThrottle('gpu-probe');
    } catch (err) {
      this.available = false;
      logThrottled('gpu-probe', `nvidia-smi is unavailable, GPU metrics disabled: ${errorMessage(err)}`);
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
      clearThrottle('gpu-collect');
      return parseNvidiaSmiCsv(stdout);
    } catch (err) {
      logThrottled('gpu-collect', `nvidia-smi query failed: ${errorMessage(err)}`);
      // 查询失败(驱动重置、卡掉线)要让能力探测重新跑一遍,而不是继续每轮硬查。
      this.available = undefined;
      return undefined;
    }
  }
}
