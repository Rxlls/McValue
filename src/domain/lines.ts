/**
 * 组合行的规范化与去重指纹。
 *
 * 去重口径：把 (code, quantity) 按 code 字典序排序后拼接。
 * 这样「巨无霸x1 + 薯条x2」与「薯条x2 + 巨无霸x1」是同一个组合，只保留一次。
 */

export interface SimpleLine {
  code: string;
  quantity: number;
}

export function normalizeLines(lines: SimpleLine[]): SimpleLine[] {
  const merged = new Map<string, number>();
  for (const l of lines) {
    if (l.quantity <= 0) continue;
    merged.set(l.code, (merged.get(l.code) ?? 0) + l.quantity);
  }
  return [...merged.entries()]
    .map(([code, quantity]) => ({ code, quantity }))
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

export function fingerprintOf(lines: SimpleLine[]): string {
  return normalizeLines(lines)
    .map((l) => `${l.code}:${l.quantity}`)
    .join(",");
}

export function itemCountOf(lines: SimpleLine[]): number {
  return normalizeLines(lines).reduce((s, l) => s + l.quantity, 0);
}
