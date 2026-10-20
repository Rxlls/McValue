import { describe, expect, it } from "vitest";
import { aggregateNutrition, describeNutrition, estimateLines, unitPriceForEstimate } from "../src/domain/pricing";
import { parseNutritionPayload } from "../src/mcp/source";
import type { MenuItem } from "../src/domain/types";

function item(over: Partial<MenuItem> & { code: string }): MenuItem {
  return {
    name: over.code,
    category: "测试",
    tags: [],
    image: null,
    currentPriceCents: 1000,
    originalPriceCents: 1000,
    discountType: null,
    priceConditional: false,
    canWithOrder: false,
    availability: "available",
    isCombo: false,
    comboDetection: "heuristic",
    comboComponentCodes: null,
    nutrition: { status: "missing", fact: null, matchKind: "none" },
    ...over,
  };
}

describe("本地估算", () => {
  it("普通商品按菜单现价求和", () => {
    const menu = new Map([["A", item({ code: "A", currentPriceCents: 1200 })]]);
    const est = estimateLines([{ code: "A", quantity: 2 }], menu);
    expect(est.totalCents).toBe(2400);
    expect(est.status).toBe("estimated");
  });

  it("随单购条件价商品按原价估算，避免系统性低估", () => {
    // 真实观察：菜单价 4990（随单购麦金卡优惠），未购卡时官方核价为 11450（原价）
    const menu = new Map([
      ["A", item({ code: "A", currentPriceCents: 4990, originalPriceCents: 11450, priceConditional: true, discountType: "随单购麦金卡优惠" })],
    ]);
    expect(unitPriceForEstimate(menu.get("A")!)).toBe(11450);
    const est = estimateLines([{ code: "A", quantity: 1 }], menu);
    expect(est.totalCents).toBe(11450);
  });

  it("缺价时整体为 unknown，不用 0 兜底", () => {
    const menu = new Map([["A", item({ code: "A", currentPriceCents: null, originalPriceCents: null })]]);
    const est = estimateLines([{ code: "A", quantity: 1 }], menu);
    expect(est.status).toBe("unknown");
    expect(est.totalCents).toBeNull();
    expect(est.missingPriceCount).toBe(1);
  });
});

describe("营养聚合", () => {
  it("全部缺失时合计为 null 而不是 0", () => {
    const menu = new Map([["A", item({ code: "A" })]]);
    const agg = aggregateNutrition([{ code: "A", quantity: 2, name: "A" }], menu);
    expect(agg.status).toBe("missing");
    expect(agg.energyKcal).toBeNull();
    expect(agg.isLowerBound).toBe(true);
    expect(describeNutrition(agg)).toContain("缺失");
  });

  it("部分缺失时合计为下界并列出未匹配项", () => {
    const withData = item({
      code: "A",
      nutrition: {
        status: "available",
        matchKind: "exact",
        fact: { productName: "A", energyKj: null, energyKcal: 300, protein: 10, fat: 5, carbohydrate: 20, sodium: 100, calcium: null },
      },
    });
    const menu = new Map([["A", withData], ["B", item({ code: "B" })]]);
    const agg = aggregateNutrition(
      [
        { code: "A", quantity: 1, name: "A" },
        { code: "B", quantity: 1, name: "B" },
      ],
      menu,
    );
    expect(agg.status).toBe("partial");
    expect(agg.energyKcal).toBe(300);
    expect(agg.isLowerBound).toBe(true);
    expect(agg.unmatchedNames).toEqual(["B"]);
    expect(describeNutrition(agg)).toContain("下界");
  });
});

describe("官方营养文本解析", () => {
  it("解析 list-nutrition-foods 的自描述文本", () => {
    const payload = [
      '[160]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:',
      '  猪柳麦满分,null,1288,308,16,16,24,781,213',
      '  中薯条,null,1210,289,4,12,38,165,18',
    ].join("\n");
    const facts = parseNutritionPayload(payload);
    expect(facts).toHaveLength(2);
    expect(facts[1].productName).toBe("中薯条");
    expect(facts[1].energyKcal).toBe(289);
    expect(facts[1].sodium).toBe(165);
  });
});
