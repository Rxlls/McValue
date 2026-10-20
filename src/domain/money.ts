/**
 * 金额工具。
 *
 * 麦当劳官方 MCP 所有价格字段单位均为「分」（由 calculate-price 的 outputSchema
 * 明确标注：productOriginalPrice / productPrice / price / discount … 单位分）。
 * 本项目内部一律以「分」为整数单位流转，仅在展示层格式化为元。
 */

export type Cents = number;

/** 元 -> 分。菜单接口返回的 currentPrice 是字符串（如 "25.5"）。 */
export function yuanToCents(yuan: string | number | null | undefined): Cents | null {
  if (yuan === null || yuan === undefined || yuan === "") return null;
  const n = typeof yuan === "number" ? yuan : Number.parseFloat(yuan);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

export function centsToYuan(cents: Cents | null | undefined): number | null {
  return cents === null || cents === undefined ? null : cents / 100;
}

/** 展示用：¥25.50；空值返回占位符，绝不显示为 0。 */
export function formatCents(cents: Cents | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  return `¥${(cents / 100).toFixed(2)}`;
}

/** 展示用带状态的金额。 */
export function formatCentsWithNote(cents: Cents | null | undefined, note?: string): string {
  const base = formatCents(cents);
  return note ? `${base}（${note}）` : base;
}

/** 金额求和，任一项缺失则整体缺失（不把缺失当 0 参与计算）。 */
export function sumCents(values: Array<Cents | null>): Cents | null {
  let total = 0;
  for (const v of values) {
    if (v === null) return null;
    total += v;
  }
  return total;
}

/** 两个金额是否一致（用于核价一致性校验）。 */
export function centsEqual(a: Cents | null, b: Cents | null): boolean {
  return a !== null && b !== null && a === b;
}

/** 差额，任一侧缺失返回 null。 */
export function centsDiff(a: Cents | null, b: Cents | null): Cents | null {
  return a === null || b === null ? null : a - b;
}
