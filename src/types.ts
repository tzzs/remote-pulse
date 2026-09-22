export interface CpuTimes {
  idleTime: number;
  totalTime: number;
}

export interface CpuStats {
  percent: number;
  cores: number;
  /** 数据来源:宿主机 /proc 还是容器自己的 cgroup 配额。容器里两者的差别足以让百分比失去意义,所以要标出来。 */
  source: MetricSource;
  /** cgroup 限额折算出的核数(例如 cpu.max = 200000 100000 → 2);无限额时 undefined。 */
  quotaCores?: number;
}

/** 'host' = 直接读 /proc(宿主机视角);'cgroup' = 读到了容器自己的配额,百分比以配额为分母。 */
export type MetricSource = 'host' | 'cgroup';

export interface MemoryStats {
  total: number;
  used: number;
  available: number;
  percent: number;
  source: MetricSource;
}

export interface SwapStats {
  total: number;
  used: number;
  percent: number;
}

/** /proc/loadavg 的 1/5/15 分钟平均值。除以核数才有"是否过载"的语义,所以核数一起带着。 */
export interface LoadAverage {
  one: number;
  five: number;
  fifteen: number;
}

export interface MountEntry {
  mountPoint: string;
  fsType: string;
}

export interface DiskStats {
  mountPoint: string;
  total: number;
  used: number;
  percent: number;
}

export interface DiskIoSample {
  readBytes: number;
  writeBytes: number;
}

export interface DiskIoRate {
  readRate: number;
  writeRate: number;
}

export interface NetSample {
  rxBytes: number;
  txBytes: number;
}

export interface NetworkRate {
  rxRate: number;
  txRate: number;
}

export interface GpuStats {
  index: number;
  name?: string;
  utilizationPercent: number;
  memoryUsedMb: number;
  memoryTotalMb: number;
  temperatureC: number;
}

export interface ProcessStats {
  pid: number;
  name: string;
  cpuPercent: number;
  memoryBytes: number;
}

export interface DockerContainerStats {
  id: string;
  name: string;
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryLimitBytes: number;
}

export interface DockerStats {
  containerCount: number;
  /** 实际取到明细的容器(受 dockerMaxContainers 上限限制),可能少于 containerCount。 */
  containers: DockerContainerStats[];
}

export interface Snapshot {
  timestamp: number;
  cpu?: CpuStats;
  memory?: MemoryStats;
  swap?: SwapStats;
  load?: LoadAverage;
  disks?: DiskStats[];
  diskIo?: DiskIoRate;
  network?: NetworkRate;
  gpus?: GpuStats[];
  processes?: ProcessStats[];
  docker?: DockerStats;
  uptimeSeconds?: number;
}

export type AlertLevel = 'normal' | 'warning' | 'critical';

export type CollectionState = 'loading' | 'ok' | 'error';
