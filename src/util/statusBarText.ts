/** 把 CPU/内存百分比套进用户自定义模板,严重态时把开头图标换成警告图标——不依赖 vscode,方便单独跑单元测试。 */
export function renderStatusBarText(template: string, cpuText: string, memText: string, isCritical: boolean): string {
  let text = template.replace('${cpu}', cpuText).replace('${mem}', memText);
  if (isCritical) {
    text = text.replace(/^\$\([a-zA-Z-]+\)/, '$(warning)');
  }
  return text;
}
