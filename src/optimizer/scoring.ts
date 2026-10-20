/**
 * 候选组合评分。
 *
 * 评分只用于「挑选送去官方核价的候选」与「解释为什么推荐它」，
 * 最终排序一律以官方 calculate-price 的返回结果为准（见 optimizer.ts）。
 * 营养分在数据缺失时为 null，并从权重归一化中剔除 —— 缺数据不加分也不扣分。
 */

import type { Cents } from "../domain/money";
import type { MenuItem, NutritionAggregate, Requirement, ScoreBreakdown } from "../domain/types";
import type { SatietyReport } from "../domain/satiety";

/**
 * 权重设计要点：
 * - satiety 权重最高。预算是上限而不是目标，「两个人只点一个汉堡」即使最便宜也不该被推荐。
 * - budgetFit 权重最低且语义是「预算内即可」：不再奖励越便宜越好，
 *   只对「过度节俭、可能没点够」做轻微扣分（份量硬约束兜底后这层只是微调）。
 */
export const WEIGHTS = {
  satiety: 0.3,
  taste: 0.22,
  diversity: 0.18,
  budgetFit: 0.15,
  nutrition: 0.1,
  combo: 0.05,
} as const;

export interface ScoreInput {
  lines: Array<{ code: string; quantity: number }>;
  requirement: Requirement;
  menu: Map<string, MenuItem>;
  nutrition: NutritionAggregate;
  estimateCents: Cents | null;
  satiety: SatietyReport;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function tasteScore(input: ScoreInput): { value: number; hit: number; total: number; detail: string } {
  const { lines, requirement, menu } = input;
  const kw = requirement.tasteKeywords;
  if (kw.length === 0) return { value: 50, hit: 0, total: 0, detail: "未指定口味关键词，口味分取中性 50" };
  let hit = 0;
  let total = 0;
  for (const l of lines) {
    const item = menu.get(l.code);
    const text = `${item?.name ?? ""}|${(item?.tags ?? []).join("|")}|${item?.category ?? ""}`;
    total += l.quantity;
    if (kw.some((k) => text.includes(k))) hit += l.quantity;
  }
  const value = total === 0 ? 0 : Math.round(100 * (hit / total));
  return { value, hit, total, detail: `命中 ${hit}/${total} 件（关键词：${kw.join("、")}）` };
}

function diversityScore(input: ScoreInput): { value: number; detail: string } {
  const { lines, menu, requirement } = input;
  const cats = new Set<string>();
  for (const l of lines) {
    const c = menu.get(l.code)?.category;
    if (c) cats.add(c);
  }
  const total = lines.reduce((s, l) => s + l.quantity, 0);
  if (total === 0) return { value: 0, detail: "空组合" };
  const people = Math.max(1, requirement.people);
  const coverage = clamp01(cats.size / Math.max(1, total));
  // 只惩罚「同一商品数量超过人数」。
  // 按人数配齐造成的重复（2 人点 2 个同样的汉堡）是合理的，不该算堆量。
  const overRepeat = lines.reduce((s, l) => s + Math.max(0, l.quantity - people), 0);
  const repeatPenalty = clamp01(overRepeat / Math.max(1, total));
  const value = Math.round(100 * (0.7 * coverage + 0.3 * (1 - repeatPenalty)));
  return {
    value,
    detail: `覆盖 ${cats.size} 个分类 / 共 ${total} 件${overRepeat > 0 ? `（超人数重复 ${overRepeat} 件）` : ""}`,
  };
}

function budgetScore(input: ScoreInput): { value: number | null; detail: string } {
  const { requirement, estimateCents } = input;
  if (requirement.budgetCents === null) {
    return { value: null, detail: "未设置预算，预算分不参与" };
  }
  if (estimateCents === null) {
    return { value: null, detail: "估算不可用，预算分不参与" };
  }
  const u = estimateCents / requirement.budgetCents;
  if (u > 1) {
    return { value: 0, detail: `估算 ${(u * 100).toFixed(0)}% 超预算` };
  }
  // 预算是上限而非目标：预算内不再奖励更便宜。
  // 只对「花得太少、大概率没点够」做轻微区分，避免过度节俭的方案靠低价取胜。
  const value = u < 0.4 ? Math.min(100, Math.round(60 + u * 100)) : 100;
  return { value, detail: `估算占预算 ${(u * 100).toFixed(0)}%（预算内即满分，不鼓励过度节俭）` };
}

/**
 * 份量充足度。
 * 达到所需人份给 85+；略有余量（1.25 人份内）最高；明显过量则回落，避免浪费。
 * 不足时线性低分 —— 虽然硬约束已淘汰，但审计场景仍需要这个分数做解释。
 */
function satietyScore(input: ScoreInput): { value: number; detail: string } {
  const { satiety, requirement } = input;
  const required = Math.max(0.01, Math.max(1, requirement.people) * requirement.minSatietyPerPerson);
  const ratio = satiety.totalUnits / required;
  let value: number;
  if (ratio >= 1 && ratio <= 1.25) {
    value = 85 + Math.round((ratio - 1) * 60);
  } else if (ratio > 1.25) {
    value = Math.max(55, 100 - Math.round((ratio - 1.25) * 55));
  } else {
    value = Math.round(85 * ratio);
  }
  return {
    value: Math.max(0, Math.min(100, value)),
    detail: `折算 ${satiety.totalUnits} 人份 / 需要 ${required} 人份（${(ratio * 100).toFixed(0)}%，主食 ${satiety.mainUnits} 人份${satiety.drinkCount > 0 ? `、饮料 ${satiety.drinkCount} 杯` : ""}）`,
  };
}

function nutritionScore(
  nutrition: NutritionAggregate,
  requirement: Requirement,
): { value: number | null; detail: string } {
  const np = requirement.nutritionPreference;
  if (!np) return { value: null, detail: "未设置营养偏好，营养分不参与" };
  if (nutrition.status === "missing" || nutrition.status === "unknown") {
    return { value: null, detail: "营养数据缺失，营养分剔除（不加分也不扣分）" };
  }
  const parts: number[] = [];
  const details: string[] = [];
  if (np.maxKcalPerPerson !== null && nutrition.energyKcal !== null) {
    const limit = np.maxKcalPerPerson * Math.max(1, requirement.people);
    parts.push(nutrition.energyKcal <= limit ? 1 : clamp01(1 - (nutrition.energyKcal - limit) / Math.max(1, limit)));
    details.push(`热量 ${Math.round(nutrition.energyKcal)}/${limit} kcal`);
  }
  if (np.minProteinTotal !== null && nutrition.protein !== null) {
    parts.push(clamp01(nutrition.protein / np.minProteinTotal));
    details.push(`蛋白 ${Math.round(nutrition.protein)}/${np.minProteinTotal} g`);
  }
  if (np.maxSodiumTotal !== null && nutrition.sodium !== null) {
    // 数据不完整时无法确认是否超限，保守给 0
    if (nutrition.isLowerBound) {
      parts.push(0);
      details.push("钠：数据不完整，保守计 0");
    } else {
      parts.push(nutrition.sodium <= np.maxSodiumTotal ? 1 : clamp01(1 - (nutrition.sodium - np.maxSodiumTotal) / Math.max(1, np.maxSodiumTotal)));
      details.push(`钠 ${Math.round(nutrition.sodium)}/${np.maxSodiumTotal} mg`);
    }
  }
  if (parts.length === 0) return { value: null, detail: "营养偏好无可判定项，营养分不参与" };
  const value = Math.round(100 * (parts.reduce((a, b) => a + b, 0) / parts.length));
  return { value, detail: details.join("，") };
}

function comboScore(input: ScoreInput): { value: number | null; detail: string } {
  const { lines, menu, requirement } = input;
  if (!requirement.preferCombo) return { value: null, detail: "未偏好套餐，套餐分不参与" };
  let comboItems = 0;
  let total = 0;
  for (const l of lines) {
    total += l.quantity;
    if (menu.get(l.code)?.isCombo === true) comboItems += l.quantity;
  }
  if (total === 0) return { value: 0, detail: "空组合" };
  return { value: Math.round(100 * (comboItems / total)), detail: `套餐件数 ${comboItems}/${total}` };
}

export function scoreCandidate(input: ScoreInput): ScoreBreakdown {
  const taste = tasteScore(input);
  const diversity = diversityScore(input);
  const budget = budgetScore(input);
  const nutrition = nutritionScore(input.nutrition, input.requirement);
  const combo = comboScore(input);
  const satiety = satietyScore(input);

  // 权重归一化：只在实际参与打分的维度之间重新分配权重
  const active: Array<{ key: keyof typeof WEIGHTS; value: number }> = [
    { key: "satiety", value: satiety.value },
    { key: "taste", value: taste.value },
    { key: "diversity", value: diversity.value },
    ...(budget.value !== null ? [{ key: "budgetFit" as const, value: budget.value }] : []),
    ...(nutrition.value !== null ? [{ key: "nutrition" as const, value: nutrition.value }] : []),
    ...(combo.value !== null ? [{ key: "combo" as const, value: combo.value }] : []),
  ];
  const totalWeight = active.reduce((s, a) => s + WEIGHTS[a.key], 0);
  const total = totalWeight === 0
    ? 0
    : Math.round(active.reduce((s, a) => s + (WEIGHTS[a.key] / totalWeight) * a.value, 0));

  const weights: Record<string, number> = {};
  for (const a of active) weights[a.key] = Number((WEIGHTS[a.key] / totalWeight).toFixed(3));

  const explanation = [
    `份量：${satiety.value} 分 — ${satiety.detail}`,
    `口味：${taste.value} 分 — ${taste.detail}`,
    `多样性：${diversity.value} 分 — ${diversity.detail}`,
    `预算：${budget.value ?? "不参与"} — ${budget.detail}`,
    `营养：${nutrition.value ?? "不参与"} — ${nutrition.detail}`,
    `套餐：${combo.value ?? "不参与"} — ${combo.detail}`,
  ];

  return {
    total,
    taste: taste.value,
    diversity: diversity.value,
    budgetFit: budget.value ?? 0,
    nutrition: nutrition.value,
    satiety: satiety.value,
    comboAffinity: combo.value ?? 0,
    weights,
    explanation,
  };
}
