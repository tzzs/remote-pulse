/** 拼出 tooltip 里的主机标签,不依赖 vscode,方便脱离扩展宿主单独跑单元测试。 */
export function formatHostLabel(hostname: string, ip: string | undefined, wslDistroName: string | undefined): string {
  const label = wslDistroName ? `${hostname} [WSL:${wslDistroName}]` : hostname;
  return ip ? `${label} (${ip})` : label;
}
