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

/**
 * 状态栏专用的定宽速率格式:数字部分右对齐补齐到 5 字符(0-99999,覆盖到 99.9 GB/s),
 * 单位保持原位。每轮刷新宽度恒定,不会因 9.8 KB/s → 240.0 KB/s 的长度变化把状态栏
 * 图标推得左右抖动。
 */
export function formatRateFixed(bytesPerSec: number, width = 5): string {
  const text = formatRate(bytesPerSec);
  const match = /^([\d.]+) (.+)$/.exec(text);
  if (!match) {
    return text;
  }
  return match[1].padStart(width, ' ') + ' ' + match[2];
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
