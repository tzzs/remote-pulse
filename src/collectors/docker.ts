import * as http from 'http';
import * as fs from 'fs';
import { DockerContainerStats, DockerStats } from '../types';

const DOCKER_SOCKET = '/var/run/docker.sock';

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
            reject(new Error(`Docker API ${path} 返回状态码 ${status}`));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`Docker API ${path} 请求超时`)));
    req.on('error', reject);
    req.end();
  });
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

  /** 无 socket 权限(常见于生产环境限制)时优雅降级为不显示该模块,而不是报错。 */
  async isAvailable(): Promise<boolean> {
    if (this.available !== undefined) {
      return this.available;
    }
    try {
      await fs.promises.access(DOCKER_SOCKET, fs.constants.R_OK | fs.constants.W_OK);
      this.available = true;
    } catch {
      this.available = false;
    }
    return this.available;
  }

  async collect(): Promise<DockerStats | undefined> {
    if (!(await this.isAvailable())) {
      return undefined;
    }
    try {
      const containers = await requestDockerApi<DockerContainerSummary[]>('/containers/json');
      const statsList = await Promise.all(
        containers.map(async c => {
          try {
            const raw = await requestDockerApi<DockerStatsResponse>(`/containers/${c.Id}/stats?stream=false`);
            const name = (c.Names?.[0] ?? c.Id).replace(/^\//, '');
            return parseContainerStats(c.Id.slice(0, 12), name, raw);
          } catch {
            return undefined;
          }
        }),
      );
      const containersStats = statsList.filter((s): s is DockerContainerStats => s !== undefined);
      return { containerCount: containers.length, containers: containersStats };
    } catch {
      return undefined;
    }
  }
}
