export const DEFAULT_STATUS_BAR_TEMPLATE = '$(pulse) CPU ${cpu}%  MEM ${mem}%';

/**
 * 把 CPU/内存百分比套进用户自定义模板,严重态时把开头图标换成警告图标——不依赖 vscode,方便单独跑单元测试。
 * 旧版本用的是 ${value} 占位符,老用户 settings.json 里可能还存着这种模板;
 * 一旦模板里一个新占位符都没有,就说明是遗留配置,直接兜底成新默认模板,避免状态栏永远显示不会被替换的字面量。
 */
export function renderStatusBarText(template: string, cpuText: string, memText: string, isCritical: boolean): string {
  const hasKnownPlaceholder = template.includes('${cpu}') || template.includes('${mem}');
  const effectiveTemplate = hasKnownPlaceholder ? template : DEFAULT_STATUS_BAR_TEMPLATE;
  let text = effectiveTemplate.replace('${cpu}', cpuText).replace('${mem}', memText);
  if (isCritical) {
    text = text.replace(/^\$\([a-zA-Z-]+\)/, '$(warning)');
  }
  return text;
}
