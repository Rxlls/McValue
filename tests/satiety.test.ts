/**
 * 份量（饱腹）模型与「N 个人能不能吃饱」的回归测试。
 *
 * 这些用例对应的真实缺陷：
 * 需求「2个人，预算60元，要汉堡和饮料」曾经产出「麦香鱼x1 + 纯悦x1」（¥30，2 件）。
 * 它满足预算与必选类别，但两个人根本吃不饱 —— 因为目标函数被写成了「越便宜越好」。
 */

import { describe, expect, it } from "vitest";
import { computeSatiety, slotSatietyOf, SLOT_SATIETY, MAIN_SLOTS } from "../src/domain/satiety";
import { parseRequirement, bindSlotWithEquivalents } from "../src/domain/requirement";
import { evaluateConstraints } from "../src/domain/constraints";
import { aggregateNutrition } from "../src/domain/pricing";
import { scoreCandidate } from "../src/optimizer/scoring";
import type { MenuItem, NutritionAggregate, Requirement } from "../src/domain/types";

function item(code: string, name: string, category: string, price: number): MenuItem {
  return {
    code,
    name,
    category,
    currentPriceCents: price,
    originalPriceCents: price,
    discountType: null,
    canWithOrder: false,
    priceConditional: false,
    image: null,
    tags: [],
    availability: "available" as const,
    isCombo: false,
    comboDetection: "heuristic" as const,
    comboComponentCodes: null,
    nutrition: { status: "missing" as const, fact: null, matchKind: "none" as const },
  };
}

const MENU = new Map<string, MenuItem>([
  ["BG", "汉堡"],
  ["CM", "套餐"],
  ["DR", "饮料"],
  ["SN", "小食"],
].map(([c, cat]) => [c, item(c, `模拟${cat}`, cat, 1000)]));

const EMPTY_NUTRITION: NutritionAggregate = {
  status: "missing",
  matchedItems: 0,
  totalItems: 0,
  energyKcal: null,
  protein: null,
  fat: null,
  carbohydrate: null,
  sodium: null,
  unmatchedNames: [],
  approximateNames: [],
  isLowerBound: false,
};

function req(over: Partial<Requirement> = {}): Requirement {
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
    mealStructure: null,
    minSatietyPerPerson: 1,
    satietyHard: true,
  };
  return { ...defaults, ...(over as Requirement) };
}

describe("份量折算", () => {
  it("主食按 1 人份计，饮料只算 0.3 人份", () => {
    expect(slotSatietyOf("汉堡")?.units).toBe(SLOT_SATIETY.burger);
    expect(slotSatietyOf("饮料")?.units).toBe(SLOT_SATIETY.drink);
    expect(MAIN_SLOTS).toContain("burger");
  });

  it("1 个汉堡 + 1 杯饮料 = 1.3 人份，不够 2 人吃", () => {
    const r = computeSatiety({ lines: [{ code: "BG", quantity: 1 }, { code: "DR", quantity: 1 }], menu: MENU }, 2, null);
    expect(r.totalUnits).toBeCloseTo(1.3, 5);
    expect(r.requiredUnits).toBe(2);
    expect(r.sufficient).toBe(false);
  });

  it("2 个汉堡 + 2 杯饮料 = 2.6 人份，够 2 人吃", () => {
    const r = computeSatiety({ lines: [{ code: "BG", quantity: 2 }, { code: "DR", quantity: 2 }], menu: MENU }, 2, null);
    expect(r.totalUnits).toBeCloseTo(2.6, 5);
    expect(r.sufficient).toBe(true);
    expect(r.drinkCount).toBe(2);
  });

  it("分类无法识别的商品不计入份量，并如实登记", () => {
    const menu = new Map(MENU);
    menu.set("XX", item("XX", "神秘商品", "未知分类", 1000));
    const r = computeSatiety({ lines: [{ code: "BG", quantity: 1 }, { code: "XX", quantity: 1 }], menu }, 1, null);
    expect(r.totalUnits).toBe(1);
    expect(r.unclassifiedNames).toEqual(["神秘商品"]);
  });

  it("热量参考仅在营养数据完整时给出，缺失时为 null", () => {
    const lines = [{ code: "BG", quantity: 2 }];
    expect(computeSatiety({ lines, menu: MENU }, 2, null).kcalPerPerson).toBeNull();
    expect(computeSatiety({ lines, menu: MENU }, 2, 1400).kcalPerPerson).toBe(700);
  });
});

describe("需求解析：按人数配齐", () => {
  it("2 个人要汉堡和饮料 → 各至少 2 件，而不是各 1 件", () => {
    const { requirement } = parseRequirement("2个人，预算60元，要汉堡和饮料");
    expect(requirement.people).toBe(2);
    const burger = requirement.requiredCategories.find((c) => c.category === "burger");
    const drink = requirement.requiredCategories.find((c) => c.category === "drink");
    expect(burger?.minCount).toBe(2);
    expect(drink?.minCount).toBe(2);
  });

  it("用户显式指定数量时以用户为准", () => {
    const { requirement } = parseRequirement("2个人，要1个汉堡");
    expect(requirement.requiredCategories.find((c) => c.category === "burger")?.minCount).toBe(1);
  });

  it("忌口里的字不会被误当口味词（不要香菜 ≠ 喜欢「香」）", () => {
    const { requirement } = parseRequirement("不要香菜");
    expect(requirement.avoidKeywords).toContain("香菜");
    expect(requirement.tasteKeywords).not.toContain("香");
  });
});

describe("份量硬约束", () => {
  const lines2 = [{ code: "BG", quantity: 1 }, { code: "DR", quantity: 1 }];
  const lines4 = [{ code: "BG", quantity: 2 }, { code: "DR", quantity: 2 }];

  const evalFor = (lines: Array<{ code: string; quantity: number }>, people: number) =>
    evaluateConstraints({
      lines,
      requirement: req({ people }),
      menu: MENU,
      effectiveCents: lines.reduce((s, l) => s + 1000 * l.quantity, 0),
      effectiveSource: "estimated",
      nutrition: EMPTY_NUTRITION,
      couponState: "not-applied",
      couponAvailable: false,
    });

  it("2 人点 2 件：份量硬约束不满足，直接淘汰", () => {
    const rep = evalFor(lines2, 2);
    expect(rep.hardAllSatisfied).toBe(false);
    const sat = rep.hardViolations.find((v) => v.kind === "satiety");
    expect(sat).toBeDefined();
    expect(sat?.label).toContain("份量");
  });

  it("2 人点 4 件：份量满足", () => {
    expect(evalFor(lines4, 2).hardAllSatisfied).toBe(true);
  });

  it("1 人点 2 件：份量满足（不要求单人点双人份）", () => {
    expect(evalFor(lines2, 1).hardAllSatisfied).toBe(true);
  });

  it("份量作为软约束时不否决方案，但仍出现在未满足项里", () => {
    const rep = evaluateConstraints({
      lines: lines2,
      requirement: req({ people: 2, satietyHard: false }),
      menu: MENU,
      effectiveCents: 2000,
      effectiveSource: "estimated",
      nutrition: EMPTY_NUTRITION,
      couponState: "not-applied",
      couponAvailable: false,
    });
    expect(rep.hardAllSatisfied).toBe(true);
    expect(rep.softViolations.some((v) => v.kind === "satiety")).toBe(true);
  });
});

describe("评分：份量优先于省钱", () => {
  const scoreOf = (lines: Array<{ code: string; quantity: number }>, people: number, budget = 6000) => {
    const r = req({ people, budgetCents: budget });
    const nutri = aggregateNutrition(
      lines.map((l) => ({ ...l, name: MENU.get(l.code)?.name ?? l.code })),
      MENU,
    );
    return scoreCandidate({
      lines,
      requirement: r,
      menu: MENU,
      nutrition: nutri,
      estimateCents: lines.reduce((s, l) => s + 1000 * l.quantity, 0),
      satiety: computeSatiety({ lines, menu: MENU }, people, null),
    });
  };

  it("吃饱的方案评分高于吃不饱但更便宜的方案", () => {
    const cheapButHungry = scoreOf([{ code: "BG", quantity: 1 }, { code: "DR", quantity: 1 }], 2);
    const enoughFor2 = scoreOf([{ code: "BG", quantity: 2 }, { code: "DR", quantity: 2 }], 2);
    expect(enoughFor2.total).toBeGreaterThan(cheapButHungry.total);
  });

  it("预算内不再奖励更便宜：花得充分的方案预算分不低", () => {
    const a = scoreOf([{ code: "BG", quantity: 2 }, { code: "DR", quantity: 2 }], 2, 6000);
    expect(a.budgetFit).toBe(100);
  });

  it("分数解释里包含份量依据", () => {
    const s = scoreOf([{ code: "BG", quantity: 2 }, { code: "DR", quantity: 2 }], 2);
    expect(s.explanation.some((e) => e.startsWith("份量"))).toBe(true);
    expect(s.satiety).toBeGreaterThan(0);
  });
});

describe("用餐结构：不再把「2 个人」机械乘成「2 杯饮料」", () => {
  const ms = (t: string) => parseRequirement(t).requirement.mealStructure!;

  it("只说人数与类别时，按人数推默认值并标记 derived", () => {
    const s = ms("2个人，预算60元，要汉堡和饮料");
    expect(s).toMatchObject({ main: 2, drink: 2, side: 0, dessert: 0, derived: true });
  });

  it("用户明说「喝一杯就行」时听用户的", () => {
    expect(ms("2个人，要汉堡和饮料，我们俩喝一杯就行")).toMatchObject({ main: 2, drink: 1 });
  });

  it("「汉堡和一杯饮料」不会把饮料的「一杯」算到汉堡头上", () => {
    expect(ms("2个人，要汉堡和一杯饮料")).toMatchObject({ main: 2, drink: 1 });
  });

  it("并列需求不会丢：「两杯可乐和汉堡」两个都要", () => {
    expect(ms("2个人，要两杯可乐和汉堡")).toMatchObject({ main: 2, drink: 2 });
  });

  it("支持非对称结构：1 个主食 + 2 杯饮品 + 小食", () => {
    expect(ms("2个人，一个汉堡两杯饮品其他是小吃")).toMatchObject({ main: 1, drink: 2, side: 2 });
  });

  it("全部数量都由用户指定时 derived 为 false", () => {
    expect(ms("2个人，要两个汉堡和两杯可乐").derived).toBe(false);
  });

  it("结构折算份量少于人数时，份量下限跟着结构走（尊重主动少吃）", () => {
    const r = req({
      people: 2,
      mealStructure: { main: 1, drink: 2, side: 1, dessert: 0, derived: false },
    });
    // 1x1.0 + 2x0.3 + 1x0.35 = 1.95 < 2 人
    const rep = evaluateConstraints({
      lines: [{ code: "BG", quantity: 1 }, { code: "DR", quantity: 2 }, { code: "SN", quantity: 1 }],
      requirement: r,
      menu: MENU,
      effectiveCents: 4000,
      effectiveSource: "estimated",
      nutrition: EMPTY_NUTRITION,
      couponState: "not-applied",
      couponAvailable: false,
    });
    const sat = rep.results.find((x) => x.kind === "satiety");
    expect(sat?.label).toContain("1.95");
    expect(sat?.satisfied).toBe(true);
  });
});

describe("槽位等价扩展", () => {
  it("「要汉堡」可由含汉堡的套餐类分类等价满足", () => {
    const cats = ["巨无霸\n牛鱼肉堡", "随心配\n1+1", "饮品"];
    const bound = bindSlotWithEquivalents("burger", cats);
    expect(bound).toContain("巨无霸\n牛鱼肉堡");
    expect(bound).toContain("随心配\n1+1");
    expect(bound).not.toContain("饮品");
  });

  it("等价扩展不会把饮料算成主食", () => {
    expect(slotSatietyOf("饮料")?.slot).toBe("drink");
    expect(MAIN_SLOTS).not.toContain("drink");
  });
});
