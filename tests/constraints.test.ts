import { describe, expect, it } from "vitest";
import { evaluateConstraints } from "../src/domain/constraints";
import { aggregateNutrition, estimateLines } from "../src/domain/pricing";
import { MOCK_CATALOG } from "../src/mcp/mock";
import type { MenuItem, NutritionAggregate, Requirement } from "../src/domain/types";

const menu = new Map<string, MenuItem>(
  MOCK_CATALOG.map((i) => [
    i.code,
    {
      code: i.code,
      name: i.name,
      category: i.category,
      tags: i.tags ?? [],
      image: null,
      currentPriceCents: i.priceCents,
      originalPriceCents: i.priceCents,
      discountType: null,
      priceConditional: false,
      canWithOrder: false,
      availability: "available" as const,
      isCombo: i.isCombo ?? false,
      comboDetection: "heuristic" as const,
      comboComponentCodes: i.components ?? null,
      nutrition: {
        status: i.nutrition ? ("available" as const) : ("missing" as const),
        fact: i.nutrition
          ? {
              productName: i.name,
              energyKj: null,
              energyKcal: i.nutrition.energyKcal ?? null,
              protein: i.nutrition.protein ?? null,
              fat: i.nutrition.fat ?? null,
              carbohydrate: i.nutrition.carbohydrate ?? null,
              sodium: i.nutrition.sodium ?? null,
              calcium: null,
            }
          : null,
        matchKind: i.nutrition ? ("exact" as const) : ("none" as const),
      },
    },
  ]),
);

function baseRequirement(over: Partial<Requirement> = {}): Requirement {
  const defaults: Requirement = {
    rawText: "",
    budgetCents: null,
    people: 1,
    requiredCategories: [],
    maxItems: null,
    minItems: null,
    maxQtyPerItem: 3,
    mustIncludeCodes: [],
    excludeCodes: [],
    tasteKeywords: [],
    avoidKeywords: [],
    couponPreference: "auto",
    nutritionPreference: null,
    preferCombo: false,
    // 历史用例不针对份量建模，默认关闭；份量行为由 tests/satiety.test.ts 单独覆盖
    mealStructure: null,
    minSatietyPerPerson: 1,
    satietyHard: false,
  };
  return { ...defaults, ...(over as Requirement) };
}

function evaluate(lines: Array<{ code: string; quantity: number }>, req: Requirement, eff?: number | null) {
  const nutrition = aggregateNutrition(
    lines.map((l) => ({ ...l, name: menu.get(l.code)?.name ?? l.code })),
    menu,
  );
  return evaluateConstraints({
    lines,
    requirement: req,
    menu,
    effectiveCents: eff ?? estimateLines(lines, menu).totalCents,
    effectiveSource: "estimated",
    nutrition,
    couponState: "not-applied",
    couponAvailable: false,
  });
}

describe("硬约束", () => {
  it("超预算直接判为硬约束不满足", () => {
    const rep = evaluate(
      [{ code: "SIM-BG-02", quantity: 2 }],
      baseRequirement({ budgetCents: 3000 }),
    );
    const budget = rep.results.find((r) => r.kind === "budget");
    expect(budget?.satisfied).toBe(false);
    expect(rep.hardAllSatisfied).toBe(false);
  });

  it("预算内通过", () => {
    const rep = evaluate(
      [{ code: "SIM-BG-01", quantity: 1 }],
      baseRequirement({ budgetCents: 2000 }),
    );
    expect(rep.hardAllSatisfied).toBe(true);
  });

  it("价格缺失时预算约束判为不满足，并写明原因", () => {
    const rep = evaluate([{ code: "SIM-UNKNOWN", quantity: 1 }], baseRequirement({ budgetCents: 2000 }), null);
    const budget = rep.results.find((r) => r.kind === "budget");
    expect(budget?.satisfied).toBe(false);
    expect(budget?.reason).toContain("无法判定预算");
  });

  it("必选类别未达到数量即淘汰", () => {
    const rep = evaluate(
      [{ code: "SIM-SN-01", quantity: 1 }],
      baseRequirement({ requiredCategories: [{ category: "burger", minCount: 1 }] }),
    );
    expect(rep.hardAllSatisfied).toBe(false);
    expect(rep.hardViolations[0].kind).toBe("required-category");
  });

  it("必选类别无法满足时（菜单无该分类）记为不满足而非忽略", () => {
    const rep = evaluate(
      [{ code: "SIM-SN-01", quantity: 1 }],
      baseRequirement({ requiredCategories: [{ category: "不存在的分类", minCount: 1 }] }),
    );
    expect(rep.hardAllSatisfied).toBe(false);
    expect(rep.hardViolations[0].reason).toContain("不存在可识别");
  });

  it("忌口关键词命中即淘汰", () => {
    const rep = evaluate(
      [{ code: "SIM-BG-02", quantity: 1 }],
      baseRequirement({ avoidKeywords: ["牛肉"] }),
    );
    expect(rep.hardAllSatisfied).toBe(false);
  });

  it("超过单品数量上限被淘汰", () => {
    const rep = evaluate(
      [{ code: "SIM-SN-01", quantity: 5 }],
      baseRequirement({ maxQtyPerItem: 3 }),
    );
    expect(rep.hardAllSatisfied).toBe(false);
  });

  it("不可售商品被淘汰", () => {
    const rep = evaluate([{ code: "SIM-NOT-IN-MENU", quantity: 1 }], baseRequirement());
    expect(rep.hardViolations.some((v) => v.kind === "availability")).toBe(true);
  });
});

describe("营养偏好", () => {
  it("营养数据缺失时判为不满足而非静默通过", () => {
    const lines = [{ code: "SIM-DR-02", quantity: 1 }]; // 模拟无糖可乐无营养数据
    const rep = evaluate(
      lines,
      baseRequirement({
        nutritionPreference: { maxKcalPerPerson: 800, minProteinTotal: null, maxSodiumTotal: null, enforceAsHard: false },
      }),
    );
    const nut = rep.results.find((r) => r.kind === "nutrition");
    expect(nut?.satisfied).toBe(false);
    expect(nut?.reason).toContain("营养数据缺失");
    // 软偏好不淘汰
    expect(rep.hardAllSatisfied).toBe(true);
    expect(rep.softViolations.length).toBeGreaterThan(0);
  });

  it("部分缺失时合计值标记为下界", () => {
    const agg: NutritionAggregate = aggregateNutrition(
      [
        { code: "SIM-BG-01", quantity: 1, name: "模拟吉士汉堡" },
        { code: "SIM-DR-02", quantity: 1, name: "模拟无糖可乐" },
      ],
      menu,
    );
    expect(agg.status).toBe("partial");
    expect(agg.isLowerBound).toBe(true);
    expect(agg.unmatchedNames).toContain("模拟无糖可乐");
    expect(agg.energyKcal).toBe(294); // 仅已知项累加
  });
});

describe("优惠券约束", () => {
  it("require 券但门店无券 => 硬约束不满足", () => {
    const rep = evaluate([{ code: "SIM-BG-01", quantity: 1 }], baseRequirement({ couponPreference: "require" }));
    expect(rep.hardViolations.some((v) => v.kind === "coupon")).toBe(true);
  });
});
