import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import { CollectorAvailability, DockerContainerStats, DockerStats } from '../types';
import { ThrottledProbe } from '../util/platform';
import { errorMessage } from '../util/error';

const SYSTEM_SOCKET = '/var/run/docker.sock';
/** 探测失败后最多每 2 分钟重试一次:docker/podman daemon 可能在扩展激活之后才启动。 */
const PROBE_RETRY_MS = 2 * 60 * 1000;

/**
 * 候选 socket 按优先级:DOCKER_HOST(unix:// 形式,和 docker CLI 行为一致)→
 * 系统级 socket → rootless docker / podman 的用户级 socket(/run/user/<uid>/…)。
 * 只写死 /var/run/docker.sock 会把 rootless 用户整体排除在外。
 */
export function candidateSockets(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates: string[] = [];
  const fromEnv = env.DOCKER_HOST;
  if (fromEnv?.startsWith('unix://')) {
    candidates.push(fromEnv.slice('unix://'.length));
  }
  candidates.push(SYSTEM_SOCKET);
  const xdgRuntime = env.XDG_RUNTIME_DIR ?? (env.USER ? `/run/user/${uidOf(env)}` : undefined);
  if (xdgRuntime) {
    candidates.push(`${xdgRuntime}/docker.sock`, `${xdgRuntime}/podman/podman.sock`);
  }
  return [...new Set(candidates)];
}

function uidOf(env: NodeJS.ProcessEnv): string | number {
  try {
    return os.userInfo().uid;
  } catch {
    return env.USER ?? 0;
  }
}

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

function requestDockerApi<T>(socketPath: string, path: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath, path, method: 'GET', timeout: 3000 },
      res => {
        let data = '';
        res.on('data', chunk => (data += chunk));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            try {
              resolve(JSON.parse(data) as T);
            } catch (err) {
              reject(new Error(`Docker API ${path} returned invalid JSON: ${errorMessage(err)}`));
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

export type { CollectorAvailability };

export class DockerCollector {
  /** 找到过候选 socket 但 R/W 权限全被拒——和"根本没找到 socket"区分开,面板提示语才不会误导。 */
  private permissionDeniedSeen = false;
  /** 探测成功一次后短路,失败按 PROBE_RETRY_MS 节流重试(daemon 可能晚于扩展激活才启动)。 */
  private readonly probe = new ThrottledProbe(async () => {
    this.permissionDeniedSeen = false;
    for (const candidate of candidateSockets()) {
      try {
        await fs.promises.access(candidate, fs.constants.R_OK | fs.constants.W_OK);
        this.resolvedSocket = candidate;
        return true;
      } catch (err) {
        // 存在但不可读写 = 权限问题;压根不存在 = 未安装。EACCES/EPERM 之外(ENOENT 等)按未安装处理。
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EACCES' || code === 'EPERM') {
          this.permissionDeniedSeen = true;
        }
      }
    }
    return false;
  }, PROBE_RETRY_MS);
  private resolvedSocket: string | undefined;
  /**
   * 最近一次采集失败的原因,由调用方(extension.ts)写进输出日志。采集器不 import vscode,
   * 否则纯 `node --test` 跑不到它;对外仍然是返回 undefined 走优雅降级。
   */
  lastError?: string;

  /** 无 socket(或无权限)时优雅降级为不显示该模块,而不是报错。 */
  async isAvailable(): Promise<boolean> {
    if (await this.probe.check()) {
      return true;
    }
    this.resolvedSocket = undefined;
    return false;
  }

  async availabilityStatus(): Promise<CollectorAvailability> {
    if (await this.isAvailable()) {
      return 'available';
    }
    return this.permissionDeniedSeen ? 'no_permission' : 'not_installed';
  }

  async collect(): Promise<DockerStats | undefined> {
    if (!(await this.isAvailable()) || !this.resolvedSocket) {
      return undefined;
    }
    const socket = this.resolvedSocket;
    this.lastError = undefined;
    try {
      const containers = await requestDockerApi<DockerContainerSummary[]>(socket, '/containers/json');
      const statsList = await Promise.all(
        containers.map(async c => {
          try {
            const raw = await requestDockerApi<DockerStatsResponse>(socket, `/containers/${c.Id}/stats?stream=false`);
            const name = (c.Names?.[0] ?? c.Id).replace(/^\//, '');
            return parseContainerStats(c.Id.slice(0, 12), name, raw);
          } catch (err) {
            this.lastError = errorMessage(err);
            return undefined;
          }
        }),
      );
      const containersStats = statsList.filter((s): s is DockerContainerStats => s !== undefined);
      return { containerCount: containers.length, containers: containersStats };
    } catch (err) {
      // daemon 在但请求失败(版本不匹配、权限被策略拒绝等),记下来供日志排查;
      // 对外仍然按"没有 Docker 数据"优雅降级。
      this.lastError = errorMessage(err);
      return undefined;
    }
  }
}
