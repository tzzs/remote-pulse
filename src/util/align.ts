/** 中日韩字符在等宽字体里占两个字符位,原生 .length 会低估视觉宽度,导致按字符数对齐在中文下算少。 */
const WIDE_RANGES: [number, number][] = [
  [0x1100, 0x115f],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
];

function isWide(codePoint: number): boolean {
  return WIDE_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end);
}

export function visualWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    width += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1;
  }
  return width;
}

/** 补空格到目标视觉宽度,用于等宽代码块里手动对齐列;已经超出目标宽度时原样返回,不截断。 */
export function padLabel(label: string, targetWidth: number): string {
  return label + ' '.repeat(Math.max(0, targetWidth - visualWidth(label)));
}

/** 状态栏 tooltip 里的一行:标签 | sparkline | 数值 | 明细。 */
export interface TooltipRow {
  label: string;
  spark: string;
  value: string;
  detail: string;
}

export function formatTooltipTable(rows: TooltipRow[]): string {
  const labelWidth = Math.max(0, ...rows.map(r => visualWidth(r.label)));
  const sparkWidth = Math.max(0, ...rows.map(r => visualWidth(r.spark)));
  const valueWidth = Math.max(0, ...rows.map(r => visualWidth(r.value)));
  return rows
    .map(row => {
      const spark = sparkWidth > 0 ? `  ${padLabel(row.spark, sparkWidth)}` : '';
      // 数值列右对齐:百分比是等宽数字,左对齐会让 9% 和 61% 的个位数错开一格。
      const value = valueWidth > 0 ? `  ${' '.repeat(Math.max(0, valueWidth - visualWidth(row.value)))}${row.value}` : '';
      const detail = row.detail ? `  ${row.detail}` : '';
      return `${padLabel(row.label, labelWidth)}${spark}${value}${detail}`.trimEnd();
    })
    .join('\n');
}
