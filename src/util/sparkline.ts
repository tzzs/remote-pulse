const BLOCKS = '▁▂▃▄▅▆▇█';

/** 用 unicode 块字符画迷你趋势图,不需要额外起 Webview 就能在 tooltip 里表达趋势。 */
export function renderSparkline(values: number[], min = 0, max = 100): string {
  if (values.length === 0) {
    return '';
  }
  const range = max - min || 1;
  return values
    .map(v => {
      const clamped = Math.min(max, Math.max(min, v));
      const idx = Math.round(((clamped - min) / range) * (BLOCKS.length - 1));
      return BLOCKS[idx];
    })
    .join('');
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

export function formatRate(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatUptime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return '-';
  }
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

/**
 * 把任意长度的历史序列压到 sparkline 能显示的宽度(默认 20 个块字符)。
 * 均值降采样而不是等距抽样:抽样会把一次短暂的尖峰整个漏掉,均值至少让那一格抬起来。
 */
export function sampleForSparkline(values: number[], width = 20): number[] {
  if (values.length <= width) {
    return values;
  }
  const bucket = values.length / width;
  const out: number[] = [];
  for (let i = 0; i < width; i += 1) {
    const from = Math.floor(i * bucket);
    const to = Math.max(from + 1, Math.min(values.length, Math.floor((i + 1) * bucket)));
    let sum = 0;
    for (let j = from; j < to; j += 1) {
      sum += values[j];
    }
    out.push(sum / (to - from));
  }
  return out;
}
