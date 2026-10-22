import { describe, expect, it } from "vitest";
import { optimize } from "../src/optimizer/optimizer";
import { buildPool, searchCombinations, DEFAULT_SEARCH_CONFIG } from "../src/optimizer/search";
import { scoreCandidate } from "../src/optimizer/scoring";
import { MockDataSource } from "../src/mcp/mock";
import { aggregateNutrition, estimateLines } from "../src/domain/pricing";
import { evaluateConstraints } from "../src/domain/constraints";
import { fingerprintOf } from "../src/domain/lines";
import { computeSatiety, slotSatietyOf } from "../src/domain/satiety";
import { bindSlotWithEquivalents } from "../src/domain/requirement";
import type { MenuItem, PriceContext, Requirement } from "../src/domain/types";

const CTX: PriceContext = {
  storeCode: "SIM-STORE-0001",
  orderType: 1,
  beType: 1,
  beCode: null,
  reservationDate: null,
};

function req(over: Partial<Requirement> = {}): Requirement {
  const defaults: Requirement = {
    rawText: "",
    budgetCents: null,
    people: 1,
    requiredCategories: [],
    maxItems: null,
    minItems: null,
    maxQtyPerItem: 2,
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

async function menuMap(ds: MockDataSource): Promise<Map<string, MenuItem>> {
  const items = await ds.fetchMenu(CTX);
  return new Map(items.map((i) => [i.code, i]));
}

describe("有界组合搜索", () => {
  it("去重：同一组合只出现一次", async () => {
    const ds = new MockDataSource();
    const menu = await menuMap(ds);
    const pool = buildPool([...menu.values()], req({ requiredCategories: [{ category: "burger", minCount: 1 }] }));
    const seen = new Set<string>();
    const combos: Array<Array<{ code: string; quantity: number }>> = [];
    searchCombinations(pool, req({ maxQtyPerItem: 2 }), { ...DEFAULT_SEARCH_CONFIG, maxItems: 3, maxNodes: 200000, maxAccepted: 5000 }, (lines) => {
      const fp = fingerprintOf(lines);
      expect(seen.has(fp)).toBe(false);
      seen.add(fp);
      combos.push(lines);
      return true;
    });
    expect(combos.length).toBeGreaterThan(10);
    await ds.close();
  });

  it("预算剪枝：不会产生超预算组合", async () => {
    const ds = new MockDataSource();
    const menu = await menuMap(ds);
    const requirement = req({ budgetCents: 2000, maxQtyPerItem: 2 });
    const pool = buildPool([...menu.values()], requirement);
    searchCombinations(pool, requirement, { ...DEFAULT_SEARCH_CONFIG, maxItems: 4 }, (lines) => {
      const est = estimateLines(lines, menu);
      expect(est.totalCents).not.toBeNull();
      expect(est.totalCents!).toBeLessThanOrEqual(2000);
      return true;
    });
    await ds.close();
  });

  it("触发上限时 completeness 为 bounded 并给出原因", async () => {
    const ds = new MockDataSource();
    const menu = await menuMap(ds);
    const pool = buildPool([...menu.values()], req());
    const out = searchCombinations(pool, req(), { ...DEFAULT_SEARCH_CONFIG, maxNodes: 5 }, () => true);
    expect(out.completeness).toBe("bounded");
    expect(out.boundedReason).toContain("搜索节点数达到上限");
    await ds.close();
  });
});

describe("评分", () => {
  it("营养数据缺失时营养分为 null 且被剔除", async () => {
    const ds = new MockDataSource();
    const menu = await menuMap(ds);
    const lines = [{ code: "SIM-DR-02", quantity: 1 }]; // 无营养数据
    const nutri = aggregateNutrition([{ ...lines[0], name: "模拟无糖可乐" }], menu);
    const r = req({ nutritionPreference: { maxKcalPerPerson: 500, minProteinTotal: null, maxSodiumTotal: null, enforceAsHard: false } });
    const score = scoreCandidate({
      lines,
      requirement: r,
      menu,
      nutrition: nutri,
      estimateCents: 600,
      satiety: computeSatiety({ lines, menu }, r.people, null),
    });
    expect(score.nutrition).toBeNull();
    expect(Object.keys(score.weights)).not.toContain("nutrition");
    await ds.close();
  });

  it("权重归一化后总和为 1", async () => {
    const ds = new MockDataSource();
    const menu = await menuMap(ds);
    const lines = [{ code: "SIM-BG-01", quantity: 1 }];
    const nutri = aggregateNutrition([{ ...lines[0], name: "模拟吉士汉堡" }], menu);
    const r = req();
    const score = scoreCandidate({
      lines,
      requirement: r,
      menu,
      nutrition: nutri,
      estimateCents: 1200,
      satiety: computeSatiety({ lines, menu }, r.people, null),
    });
    const sum = Object.values(score.weights).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 2);
    await ds.close();
  });
});

describe("优化编排（模拟数据源）", () => {
  it("输出多风格候选，且每个候选的核心结构不同（不允许只换饮料凑数）", async () => {
    const ds = new MockDataSource();
    const report = await optimize({
      source: ds,
      context: CTX,
      requirement: req({ requiredCategories: [{ category: "burger", minCount: 1 }, { category: "drink", minCount: 1 }], budgetCents: 6000 }),
      verifyLimit: 6,
    });
    expect(report.candidates.length).toBeGreaterThan(0);
    for (const c of report.candidates) {
      expect(c.pricing.status).toBe("verified");
      expect(c.constraints.hardAllSatisfied).toBe(true);
      // 每个候选都带风格标签，告诉用户"为什么给你这几个"
      expect(typeof c.styleLabel).toBe("string");
      expect(c.styleLabel!.length).toBeGreaterThan(0);
    }

    // 核心结构（忽略饮料）必须互不相同 —— 这是"5 个方案其实是 1 个方案"的防线
    const menu = await menuMap(ds);
    const coreKeys = report.candidates.map((c) =>
      c.lines
        .filter((l) => {
          const s = slotSatietyOf(menu.get(l.code)?.category ?? "");
          return !(s && s.slot === "drink");
        })
        .map((l) => `${l.code}x${l.quantity}`)
        .sort()
        .join("|"),
    );
    expect(new Set(coreKeys).size).toBe(coreKeys.length);
    await ds.close();
  });

  it("必选类别未满足的组合不会进入结果", async () => {
    const ds = new MockDataSource();
    const report = await optimize({
      source: ds,
      context: CTX,
      requirement: req({ requiredCategories: [{ category: "burger", minCount: 2 }], budgetCents: 10000 }),
      verifyLimit: 3,
    });
    // 所有候选都必须至少 2 件「汉堡类」。
    // 计数口径与产品一致：套餐可顶替汉堡（bindSlotWithEquivalents），
    // 因此不能只数字面分类为「汉堡」的商品，否则会把合法的「1 汉堡 + 1 套餐」误判为违规。
    const menu = await menuMap(ds);
    const allCats = [...new Set([...menu.values()].map((m) => m.category))];
    const bound = bindSlotWithEquivalents("burger", allCats);
    for (const c of report.candidates) {
      const burgerCount = c.lines.reduce(
        (s, l) => s + (bound.includes(menu.get(l.code)?.category ?? "") ? l.quantity : 0),
        0,
      );
      expect(burgerCount).toBeGreaterThanOrEqual(2);
    }
    await ds.close();
  });

  it("核价全部失败时，候选状态为 failed 且不会伪装成已核价", async () => {
    const ds = new MockDataSource({ priceFailure: "always", couponApplicableCodes: ["SIM-CB-02"] });
    const report = await optimize({
      source: ds,
      context: CTX,
      requirement: req({ budgetCents: 6000 }),
      verifyLimit: 3,
    });
    expect(report.candidates.length).toBeGreaterThan(0);
    for (const c of report.candidates) {
      expect(c.pricing.status).toBe("failed");
      expect(c.pricing.breakdown.payableCents).toBeNull();
      expect(c.pricing.failureReason).toBeTruthy();
    }
    expect(report.conclusion).toContain("没有候选通过官方核价");
    await ds.close();
  });

  it("核价超时时 failureKind 为 timeout", async () => {
    const ds = new MockDataSource({ priceFailure: "timeout", couponApplicableCodes: [] });
    const report = await optimize({
      source: ds,
      context: CTX,
      requirement: req({ budgetCents: 6000 }),
      verifyLimit: 2,
    });
    expect(report.candidates[0].pricing.failureKind).toBe("timeout");
    await ds.close();
  });

  it("券不适用时如实标记 rejected，不谎报优惠", async () => {
    const ds = new MockDataSource({ priceFailure: "none", couponApplicableCodes: ["SIM-CB-02"] });
    const report = await optimize({
      source: ds,
      context: CTX,
      requirement: req({ mustIncludeCodes: ["SIM-BG-01"], budgetCents: 6000, couponPreference: "require" }),
      verifyLimit: 2,
    });
    // 必含吉士汉堡的组合不含双人分享餐，券理应不生效
    const withCoupon = report.candidates.filter((c) => c.pricing.couponId);
    if (withCoupon.length > 0) {
      expect(withCoupon[0].pricing.couponState).toBe("rejected");
      expect(withCoupon[0].pricing.couponNote).toContain("无法确认");
    }
    await ds.close();
  });

  it("估算与核价不一致时保留两者并给出差额", async () => {
    const ds = new MockDataSource();
    const report = await optimize({
      source: ds,
      context: { ...CTX, orderType: 2, beType: 2, beCode: "SIM-BE" },
      requirement: req({ budgetCents: 8000 }),
      verifyLimit: 2,
    });
    const c = report.candidates[0];
    expect(c.pricing.status).toBe("verified");
    // 外送场景有配送费+包装费，核价金额必然高于纯商品估算
    expect(c.pricing.breakdown.payableCents!).toBeGreaterThan(c.estimate.totalCents!);
    await ds.close();
  });

  it("硬约束在核价后被复核，超预算者被淘汰并说明原因", async () => {
    const ds = new MockDataSource();
    const report = await optimize({
      source: ds,
      context: { ...CTX, orderType: 2, beType: 2, beCode: "SIM-BE" },
      // 预算刚好卡在商品价上，加上配送费/包装费后必然超预算
      requirement: req({ mustIncludeCodes: ["SIM-SN-01"], budgetCents: 800, maxItems: 1 }),
      verifyLimit: 2,
    });
    expect(report.postVerificationRejected.length + report.candidates.length).toBeGreaterThan(0);
    for (const r of report.postVerificationRejected) {
      expect(r.reasons.join()).toContain("预算");
    }
    await ds.close();
  });
});
