export const DEFAULT_STATUS_BAR_TEMPLATE = '$(pulse) CPU ${cpu}%  MEM ${mem}%';
const DEFAULT_ICON_GLYPH = '$(pulse)';

/**
 * CPU/内存现在拆成两个独立着色的状态栏项,模板里 ${cpu}/${mem} 之间的文案排布不再有意义;
 * 唯一还保留的自定义空间是开头的图标——从模板里把这段抠出来,严重态下换成警告图标
 * (和图标脱离颜色单独变化一样,是比纯变色更明显的信号)。不依赖 vscode,方便单独跑单元测试。
 */
export function iconGlyphFor(template: string, isCritical: boolean): string {
  if (isCritical) {
    return '$(warning)';
  }
  const match = template.match(/^\$\([a-zA-Z0-9-]+\)/);
  return match ? match[0] : DEFAULT_ICON_GLYPH;
}
