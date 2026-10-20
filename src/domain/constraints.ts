/**
 * 硬约束与软偏好的统一校验。
 *
 * 原则：
 * - 数据缺失导致的"无法判定"一律记为未满足，并写明原因，绝不静默通过。
 * - 硬约束不满足 => 候选直接淘汰（由调用方执行）。
 */

import { formatCents } from "./money";
import { bindSlotWithEquivalents } from "./requirement";
import { computeSatiety, describeSatiety, structureUnitsOf } from "./satiety";
import type {
  ConstraintKind,
  ConstraintReport,
  ConstraintResult,
  CouponState,
  MenuItem,
  NutritionAggregate,
  Requirement,
} from "./types";

export interface ConstraintInput {
  lines: Array<{ code: string; quantity: number }>;
  requirement: Requirement;
  menu: Map<string, MenuItem>;
  /** 用于预算判定的价格：优先官方核价，其次本地估算；都为 null 则无法判定 */
  effectiveCents: number | null;
  effectiveSource: "verified" | "estimated" | "none";
  nutrition: NutritionAggregate;
  couponState: CouponState;
  /** 该门店是否有可用的结构化券 */
  couponAvailable: boolean;
}

function result(
  kind: ConstraintKind,
  label: string,
  hard: boolean,
  satisfied: boolean,
  reason: string | null = null,
): ConstraintResult {
  return { kind, label, hard, satisfied, reason };
}

export function evaluateConstraints(input: ConstraintInput): ConstraintReport {
  const { lines, requirement, menu, effectiveCents, effectiveSource, nutrition } = input;
  const results: ConstraintResult[] = [];
  const itemCount = lines.reduce((s, l) => s + l.quantity, 0);

  /* 预算 */
  if (requirement.budgetCents !== null) {
    if (effectiveCents === null) {
      results.push(
        result("budget", `总预算 ≤ ${formatCents(requirement.budgetCents)}`, true, false,
          "无可信价格（核价未成功且菜单价缺失），无法判定预算"),
      );
    } else {
      const ok = effectiveCents <= requirement.budgetCents;
      results.push(
        result("budget", `总预算 ≤ ${formatCents(requirement.budgetCents)}`, true, ok,
          ok ? null : `${effectiveSource === "verified" ? "官方核价" : "本地估算"}金额 ${formatCents(effectiveCents)} 超出预算 ${formatCents(effectiveCents - requirement.budgetCents)}`),
      );
    }
  }

  /* 必选类别 */
  const categories = [...new Set([...menu.values()].map((m) => m.category))];
  for (const req of requirement.requiredCategories) {
    // 用等价扩展绑定：「要汉堡」也允许由含汉堡的套餐/单人餐满足
    const bound = bindSlotWithEquivalents(req.category, categories);
    if (bound.length === 0) {
      results.push(
        result("required-category", `必选类别「${req.category}」≥ ${req.minCount} 件`, true, false,
          `菜单中不存在可识别为「${req.category}」的分类，无法判定`),
      );
      continue;
    }
    const count = lines.reduce((s, l) => {
      const item = menu.get(l.code);
      if (!item) return s;
      return bound.includes(item.category) ? s + l.quantity : s;
    }, 0);
    results.push(
      result("required-category", `必选类别「${req.category}」≥ ${req.minCount} 件`, true, count >= req.minCount,
        count >= req.minCount ? null : `实际 ${count} 件（匹配分类：${bound.join("、")}）`),
    );
  }

  /* 份量（饱腹）：N 个人至少要 N 人份 —— 这是「吃不饱」问题的硬防线 */
  {
    // 只有营养数据完整覆盖时才把热量交给份量模型做参考展示，缺失则传 null
    const kcalTotal = nutrition.status === "available" ? nutrition.energyKcal : null;
    const sat = computeSatiety({ lines, menu }, requirement.people, kcalTotal);
    // 下限取「按人数所需」与「结构折算份量」的较小值：
    // 用户主动选了「1 主食 2 饮料 1 小食」这种吃法时，不该用人数把他挡回去
    const byPeople = Math.max(1, requirement.people) * requirement.minSatietyPerPerson;
    const byStructure = requirement.mealStructure ? structureUnitsOf(requirement.mealStructure) : null;
    const requiredUnits =
      Math.round((byStructure === null ? byPeople : Math.min(byPeople, byStructure)) * 100) / 100;
    const ok = sat.totalUnits >= requiredUnits;
    results.push(
      result(
        "satiety",
        `份量 ≥ ${requiredUnits} 人份（${byStructure !== null ? `按结构 ${byStructure} 人份` : `${requirement.people} 人 × ${requirement.minSatietyPerPerson}`}）`,
        requirement.satietyHard,
        ok,
        ok ? null : describeSatiety(sat, requirement.people),
      ),
    );
  }

  /* 件数 */
  if (requirement.maxItems !== null) {
    results.push(
      result("max-items", `整单件数 ≤ ${requirement.maxItems}`, true, itemCount <= requirement.maxItems,
        itemCount <= requirement.maxItems ? null : `实际 ${itemCount} 件`),
    );
  }
  if (requirement.minItems !== null) {
    results.push(
      result("min-items", `整单件数 ≥ ${requirement.minItems}`, true, itemCount >= requirement.minItems,
        itemCount >= requirement.minItems ? null : `实际 ${itemCount} 件`),
    );
  }

  /* 单品数量上限 */
  const overQty = lines.find((l) => l.quantity > requirement.maxQtyPerItem);
  results.push(
    result("max-qty-per-item", `单个商品数量 ≤ ${requirement.maxQtyPerItem}`, true, !overQty,
      overQty ? `${overQty.code} 数量为 ${overQty.quantity}` : null),
  );

  /* 必含 / 排除 */
  for (const code of requirement.mustIncludeCodes) {
    results.push(
      result("must-include", `必须包含 ${menu.get(code)?.name ?? code}`, true, lines.some((l) => l.code === code),
        lines.some((l) => l.code === code) ? null : "组合中不包含该商品"),
    );
  }
  for (const code of requirement.excludeCodes) {
    results.push(
      result("exclude", `必须排除 ${menu.get(code)?.name ?? code}`, true, !lines.some((l) => l.code === code),
        lines.some((l) => l.code === code) ? "组合中包含该商品" : null),
    );
  }

  /* 忌口关键词（硬约束） */
  for (const kw of requirement.avoidKeywords) {
    const hit = lines.find((l) => (menu.get(l.code)?.name ?? "").includes(kw));
    results.push(
      result("avoid-keyword", `忌口：不含「${kw}」`, true, !hit, hit ? `命中 ${menu.get(hit.code)?.name ?? hit.code}` : null),
    );
  }

  /* 可售性（硬约束） */
  const unavailable = lines.filter((l) => {
    const item = menu.get(l.code);
    return !item || item.availability !== "available";
  });
  results.push(
    result("availability", "全部商品在该门店可售", true, unavailable.length === 0,
      unavailable.length > 0 ? `${unavailable.map((l) => l.code).join("、")} 状态未知或不可售` : null),
  );

  /* 营养（默认软偏好） */
  const np = requirement.nutritionPreference;
  if (np) {
    const hard = np.enforceAsHard;
    if (np.maxKcalPerPerson !== null) {
      const limit = np.maxKcalPerPerson * Math.max(1, requirement.people);
      if (nutrition.energyKcal === null) {
        results.push(result("nutrition", `总热量 ≤ ${limit} kcal`, hard, false, "营养数据缺失，无法判定"));
      } else {
        const ok = nutrition.energyKcal <= limit;
        results.push(result("nutrition", `总热量 ≤ ${limit} kcal`, hard, ok,
          ok ? null : `实际 ${Math.round(nutrition.energyKcal)} kcal${nutrition.isLowerBound ? "（下界值）" : ""}`));
      }
    }
    if (np.minProteinTotal !== null) {
      if (nutrition.protein === null) {
        results.push(result("nutrition", `蛋白质 ≥ ${np.minProteinTotal} g`, hard, false, "营养数据缺失，无法判定"));
      } else {
        const ok = nutrition.protein >= np.minProteinTotal;
        results.push(result("nutrition", `蛋白质 ≥ ${np.minProteinTotal} g`, hard, ok,
          ok ? null : `实际 ${Math.round(nutrition.protein)} g${nutrition.isLowerBound ? "（下界值）" : ""}`));
      }
    }
    if (np.maxSodiumTotal !== null) {
      if (nutrition.sodium === null) {
        results.push(result("nutrition", `钠 ≤ ${np.maxSodiumTotal} mg`, hard, false, "营养数据缺失，无法判定"));
      } else {
        const ok = nutrition.isLowerBound ? false : nutrition.sodium <= np.maxSodiumTotal;
        results.push(result("nutrition", `钠 ≤ ${np.maxSodiumTotal} mg`, hard, ok,
          ok ? null : nutrition.isLowerBound ? "营养数据不完整，无法确认是否超限" : `实际 ${Math.round(nutrition.sodium)} mg`));
      }
    }
  }

  /* 优惠券（require 时为硬约束） */
  if (requirement.couponPreference === "require") {
    if (!input.couponAvailable) {
      results.push(result("coupon", "必须使用优惠券", true, false, "该门店当前没有可用的结构化优惠券（券源无 couponId）"));
    } else if (input.couponState === "rejected") {
      results.push(result("coupon", "必须使用优惠券", true, false, "券已传入核价但未产生优惠，视为不适用"));
    } else {
      results.push(result("coupon", "必须使用优惠券", true, input.couponState === "applied",
        input.couponState === "applied" ? null : "尚未用券核价"));
    }
  }

  const hardViolations = results.filter((r) => r.hard && !r.satisfied);
  const softViolations = results.filter((r) => !r.hard && !r.satisfied);
  return {
    results,
    hardAllSatisfied: hardViolations.length === 0,
    hardViolations,
    softViolations,
  };
}
