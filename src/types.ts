export interface CpuTimes {
  idleTime: number;
  totalTime: number;
}

export interface CpuStats {
  percent: number;
  cores: number;
}

export interface MemoryStats {
  total: number;
  used: number;
  available: number;
  percent: number;
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

export interface DockerContainerStats {
  id: string;
  name: string;
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryLimitBytes: number;
}

export interface DockerStats {
  containerCount: number;
  containers: DockerContainerStats[];
}

export interface Snapshot {
  timestamp: number;
  cpu?: CpuStats;
  memory?: MemoryStats;
  disks?: DiskStats[];
  network?: NetworkRate;
  gpus?: GpuStats[];
  docker?: DockerStats;
  uptimeSeconds?: number;
}

export type AlertLevel = 'normal' | 'warning' | 'critical';

export type CollectionState = 'loading' | 'ok' | 'error';

/** 可选数据源(GPU/Docker)的可用性状态,趋势面板据此给出明确的空态提示。 */
export type CollectorAvailability = 'pending' | 'available' | 'not_installed' | 'no_permission';
