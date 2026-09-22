import * as http from 'http';
import * as fs from 'fs';
import { DockerContainerStats, DockerStats } from '../types';
import { logThrottled, clearThrottle, errorMessage } from '../util/logger';

const DOCKER_SOCKET = '/var/run/docker.sock';

/** 和 GPU 同一个理由:daemon 可能是后启动的,"不可用"不该缓存到进程结束。 */
const UNAVAILABLE_RECHECK_MS = 5 * 60 * 1000;

/**
 * `/containers/{id}/stats?stream=false` 在 daemon 侧要采两次样才返回,单次就是一秒级。
 * 之前对所有容器一次性 Promise.all 齐发,30 个容器就是 30 条并发请求压在同一个 socket 上,
 * 每 10 秒一轮——对 daemon 和远程机都不友好。限制同时在飞的请求数,分批推进。
 */
const STATS_CONCURRENCY = 4;

interface DockerContainerSummary {
  Id: string;
  Names?: string[];
}

interface DockerStatsResponse {
  cpu_stats: {
    cpu_usage: { total_usage: number; percpu_usage?: number[] };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats: {
    cpu_usage: { total_usage: number };
    system_cpu_usage?: number;
  };
  memory_stats?: { usage?: number; limit?: number };
}

function requestDockerApi<T>(path: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: DOCKER_SOCKET, path, method: 'GET', timeout: 3000 },
      res => {
        let data = '';
        res.on('data', chunk => (data += chunk));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            try {
              resolve(JSON.parse(data) as T);
            } catch (err) {
              reject(err);
            }
          } else {
            reject(new Error(`Docker API ${path} returned status ${status}`));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`Docker API ${path} timed out`)));
    req.on('error', reject);
    req.end();
  });
}

/** 依次取走任务队列,最多 limit 个"工人"同时在跑——比一次性 Promise.all 多几行,换来可控的并发。 */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * CPU 百分比算法与 `docker stats` 一致:用容器与系统两次采样的 CPU 时间增量之比,
 * 再乘以在线核心数换算成百分比(单核 100% 打满时,4 核系统显示 400%)。
 */
export function parseContainerStats(id: string, name: string, raw: DockerStatsResponse): DockerContainerStats {
  const cpuDelta = raw.cpu_stats.cpu_usage.total_usage - raw.precpu_stats.cpu_usage.total_usage;
  const systemDelta = (raw.cpu_stats.system_cpu_usage ?? 0) - (raw.precpu_stats.system_cpu_usage ?? 0);
  const onlineCpus = raw.cpu_stats.online_cpus ?? raw.cpu_stats.cpu_usage.percpu_usage?.length ?? 1;
  const cpuPercent = systemDelta > 0 && cpuDelta > 0 ? (cpuDelta / systemDelta) * onlineCpus * 100 : 0;
  return {
    id,
    name,
    cpuPercent,
    memoryUsedBytes: raw.memory_stats?.usage ?? 0,
    memoryLimitBytes: raw.memory_stats?.limit ?? 0,
  };
}

export class DockerCollector {
  private available: boolean | undefined;
  private lastProbeAt = 0;

  constructor(private readonly maxContainers: () => number = () => 20) {}

  /** 无 socket 权限(常见于生产环境限制)时优雅降级为不显示该模块,而不是报错。 */
  async isAvailable(): Promise<boolean> {
    if (this.available === true) {
      return true;
    }
    if (this.available === false && Date.now() - this.lastProbeAt < UNAVAILABLE_RECHECK_MS) {
      return false;
    }
    this.lastProbeAt = Date.now();
    try {
      await fs.promises.access(DOCKER_SOCKET, fs.constants.R_OK | fs.constants.W_OK);
      this.available = true;
      clearThrottle('docker-probe');
    } catch (err) {
      this.available = false;
      logThrottled('docker-probe', `${DOCKER_SOCKET} is not accessible, Docker metrics disabled: ${errorMessage(err)}`);
    }
    return this.available;
  }

  async collect(): Promise<DockerStats | undefined> {
    if (!(await this.isAvailable())) {
      return undefined;
    }
    try {
      const containers = await requestDockerApi<DockerContainerSummary[]>('/containers/json');
      // 容器多到几十上百时,逐个拉 stats 的代价远大于这份明细的价值;超出上限的只计入总数。
      const sampled = containers.slice(0, Math.max(1, this.maxContainers()));
      const statsList = await mapWithConcurrency(sampled, STATS_CONCURRENCY, async c => {
        try {
          const raw = await requestDockerApi<DockerStatsResponse>(`/containers/${c.Id}/stats?stream=false`);
          const name = (c.Names?.[0] ?? c.Id).replace(/^\//, '');
          return parseContainerStats(c.Id.slice(0, 12), name, raw);
        } catch (err) {
          logThrottled('docker-stats', `Failed to read stats for container ${c.Id.slice(0, 12)}: ${errorMessage(err)}`);
          return undefined;
        }
      });
      const containersStats = statsList.filter((s): s is DockerContainerStats => s !== undefined);
      clearThrottle('docker-list');
      return { containerCount: containers.length, containers: containersStats };
    } catch (err) {
      logThrottled('docker-list', `Failed to list Docker containers: ${errorMessage(err)}`);
      this.available = undefined;
      return undefined;
    }
  }
}
