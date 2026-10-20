/**
 * 本地估算（estimate）。
 *
 * 明确边界：本地估算 = 菜单 currentPrice × 数量的求和。
 * 它不包含配送费、包装费、餐具费，也不包含任何优惠与券，
 * 因此永远不能被称为"核价结果"。UI 与报告必须把它标为「本地估算」。
 */

import { sumCents, type Cents } from "./money";
import type { MenuItem, NutritionAggregate, PriceEstimate } from "./types";

/**
 * 用于估算的单价。
 * 条件价商品（随单购卡类优惠）在未满足前置条件时按原价成交，因此估算必须用原价。
 */
export function unitPriceForEstimate(item: MenuItem): Cents | null {
  if (item.priceConditional) return item.originalPriceCents ?? item.currentPriceCents;
  return item.currentPriceCents;
}

export function estimateLines(
  lines: Array<{ code: string; quantity: number }>,
  menu: Map<string, MenuItem>,
): PriceEstimate {
  let missing = 0;
  const values: Array<Cents | null> = [];
  for (const l of lines) {
    const item = menu.get(l.code);
    const unit = item ? unitPriceForEstimate(item) : null;
    if (!item || unit === null) {
      missing += 1;
      values.push(null);
    } else {
      values.push(unit * l.quantity);
    }
  }
  const total = sumCents(values);
  if (total === null) {
    return {
      status: "unknown",
      totalCents: null,
      missingPriceCount: missing,
      note: `${missing} 件商品缺少菜单价，无法估算`,
    };
  }
  return {
    status: "estimated",
    totalCents: total,
    missingPriceCount: missing,
    note: missing > 0
      ? `按菜单价求和（随单购条件价商品按原价），${missing} 件缺价未计入；不含配送费/包装费/优惠`
      : "按菜单价求和（随单购条件价商品按原价）；不含配送费/包装费/优惠",
  };
}

export function aggregateNutrition(
  lines: Array<{ code: string; quantity: number; name: string }>,
  menu: Map<string, MenuItem>,
): NutritionAggregate {
  let matched = 0;
  let total = 0;
  const unmatched: string[] = [];
  const approximate: string[] = [];
  let kcal: Cents | null = 0;
  let protein: number | null = 0;
  let fat: number | null = 0;
  let carb: number | null = 0;
  let sodium: number | null = 0;

  // 未匹配的商品不参与累加；此时合计值只是「下界」，由 isLowerBound 标注，绝不当作完整合计
  const add = (cur: number | null, v: number | null, qty: number): number | null =>
    cur === null || v === null ? cur : cur + v * qty;

  for (const l of lines) {
    total += l.quantity;
    const item = menu.get(l.code);
    const match = item?.nutrition;
    if (!match || match.status !== "available" || !match.fact) {
      unmatched.push(l.name);
      continue;
    }
    matched += l.quantity;
    if (match.matchKind === "contains") approximate.push(l.name);
    const f = match.fact;
    kcal = add(kcal, f.energyKcal, l.quantity);
    protein = add(protein, f.protein, l.quantity);
    fat = add(fat, f.fat, l.quantity);
    carb = add(carb, f.carbohydrate, l.quantity);
    sodium = add(sodium, f.sodium, l.quantity);
  }

  const status: NutritionAggregate["status"] =
    total === 0 ? "unknown" : matched === 0 ? "missing" : matched < total ? "partial" : "available";

  // 一件都没匹配上时，合计值必须是 null（而不是 0），否则会被误判为"热量 0"这种假事实
  if (status === "missing" || status === "unknown") {
    kcal = null;
    protein = null;
    fat = null;
    carb = null;
    sodium = null;
  }

  return {
    status,
    matchedItems: matched,
    totalItems: total,
    energyKcal: kcal,
    protein,
    fat,
    carbohydrate: carb,
    sodium,
    unmatchedNames: unmatched,
    approximateNames: approximate,
    isLowerBound: unmatched.length > 0,
  };
}

/** 营养聚合的自然语言说明，用于 UI 标注数据缺失情况。 */
export function describeNutrition(agg: NutritionAggregate): string {
  switch (agg.status) {
    case "unknown":
      return "无营养数据";
    case "missing":
      return `营养数据缺失（${agg.totalItems} 件均未匹配到官方营养库）`;
    case "partial":
      return `营养数据不完整：合计值仅为下界（已匹配 ${agg.matchedItems}/${agg.totalItems} 件，缺少 ${agg.unmatchedNames.join("、")}）`;
    case "available":
      return agg.approximateNames.length > 0
        ? `已匹配 ${agg.matchedItems}/${agg.totalItems} 件，其中 ${agg.approximateNames.join("、")} 为名称近似匹配`
        : `已匹配 ${agg.matchedItems}/${agg.totalItems} 件`;
  }
}
