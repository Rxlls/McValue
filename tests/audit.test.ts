import { describe, expect, it } from "vitest";
import { auditOrder } from "../src/audit/audit";
import { MockDataSource } from "../src/mcp/mock";
import type { PriceContext, Requirement } from "../src/domain/types";
import { fingerprintOf } from "../src/domain/lines";

const CTX: PriceContext = {
  storeCode: "SIM-STORE-0001",
  orderType: 1,
  beType: 1,
  beCode: null,
  reservationDate: null,
};

const REQ: Requirement = {
  rawText: "",
  budgetCents: 6000,
  people: 1,
  requiredCategories: [{ category: "汉堡", minCount: 1 }, { category: "饮料", minCount: 1 }],
  maxItems: 4,
  minItems: 2,
  maxQtyPerItem: 2,
  mustIncludeCodes: [],
  excludeCodes: [],
  tasteKeywords: [],
  avoidKeywords: [],
  couponPreference: "auto",
  nutritionPreference: null,
  preferCombo: false,
  mealStructure: null,
  minSatietyPerPerson: 1,
  satietyHard: false,
};

describe("点餐审计", () => {
  it("核验原方案并生成替代方案，两者都经官方核价", async () => {
    const ds = new MockDataSource();
    const report = await auditOrder({
      source: ds,
      context: CTX,
      lines: [{ productCode: "SIM-BG-02", quantity: 1 }, { productCode: "SIM-DR-01", quantity: 1 }],
      requirement: REQ,
      alternativeLimit: 2,
    });
    expect(report.original.pricing.status).toBe("verified");
    expect(report.original.pricing.breakdown.payableCents).toBe(2400);
    expect(report.alternatives.length).toBeGreaterThan(0);
    for (const a of report.alternatives) {
      expect(a.pricing.status).toBe("verified");
    }
    await ds.close();
  });

  it("替代方案不包含与原方案完全相同的组合", async () => {
    const ds = new MockDataSource();
    const lines = [{ productCode: "SIM-BG-01", quantity: 1 }, { productCode: "SIM-DR-01", quantity: 1 }];
    const report = await auditOrder({ source: ds, context: CTX, lines, requirement: REQ, alternativeLimit: 3 });
    const originalFp = fingerprintOf(lines.map((l) => ({ code: l.productCode, quantity: l.quantity })));
    for (const a of report.alternatives) {
      const fp = fingerprintOf(a.lines.map((l) => ({ code: l.code, quantity: l.quantity })));
      expect(fp).not.toBe(originalFp);
    }
    await ds.close();
  });

  it("差异表逐字段展示官方返回值，缺字段标为未提供", async () => {
    const ds = new MockDataSource();
    const report = await auditOrder({
      source: ds,
      context: CTX,
      lines: [{ productCode: "SIM-BG-02", quantity: 1 }, { productCode: "SIM-DR-01", quantity: 1 }],
      requirement: REQ,
      alternativeLimit: 1,
    });
    const fields = report.differences.map((d) => d.field);
    expect(fields).toContain("应付金额");
    expect(fields).toContain("配送费");
    expect(fields).toContain("优惠金额");
    const payable = report.differences.find((d) => d.field === "应付金额");
    expect(payable?.originalValue).toBe("¥24.00");
    // 到店场景无配送费/包装费：官方未返回即显示"未提供"，而不是填 0
    const delivery = report.differences.find((d) => d.field === "配送费");
    expect(delivery?.originalValue).toBe("未提供");
    await ds.close();
  });

  it("外送场景下估算与核价不一致时如实记录差额", async () => {
    const ds = new MockDataSource();
    const ctx: PriceContext = { ...CTX, orderType: 2, beType: 2, beCode: "SIM-BE" };
    const report = await auditOrder({
      source: ds,
      context: ctx,
      lines: [{ productCode: "SIM-BG-02", quantity: 1 }],
      requirement: { ...REQ, requiredCategories: [{ category: "汉堡", minCount: 1 }], minItems: 1 },
      alternativeLimit: 1,
    });
    expect(report.original.consistency.comparable).toBe(true);
    // 商品 18.00 + 配送 6.00 + 包装 1.90 = 25.90，估算只有 18.00
    expect(report.original.consistency.deltaCents).toBe(790);
    expect(report.original.consistency.note).toContain("不含配送费");
    await ds.close();
  });

  it("核价失败时不可比，且结论写明失败原因", async () => {
    const ds = new MockDataSource({ priceFailure: "always", couponApplicableCodes: [] });
    const report = await auditOrder({
      source: ds,
      context: CTX,
      lines: [{ productCode: "SIM-BG-01", quantity: 1 }],
      requirement: { ...REQ, requiredCategories: [{ category: "汉堡", minCount: 1 }], minItems: 1 },
      alternativeLimit: 1,
    });
    expect(report.original.pricing.status).toBe("failed");
    expect(report.comparability.comparable).toBe(false);
    expect(report.comparability.reason).toContain("不可比");
    expect(report.conclusion).toContain("核价失败");
    expect(report.provenance.some((p) => p.status === "failed")).toBe(true);
    await ds.close();
  });

  it("审计报告的上下文被完整记录，便于判断是否同条件比较", async () => {
    const ds = new MockDataSource();
    const report = await auditOrder({
      source: ds,
      context: CTX,
      lines: [{ productCode: "SIM-BG-01", quantity: 1 }],
      requirement: { ...REQ, requiredCategories: [{ category: "汉堡", minCount: 1 }], minItems: 1 },
      alternativeLimit: 1,
    });
    expect(report.context.storeCode).toBe("SIM-STORE-0001");
    for (const a of report.alternatives) {
      expect(a.pricing.context.storeCode).toBe(report.context.storeCode);
      expect(a.pricing.context.orderType).toBe(report.context.orderType);
      expect(a.pricing.context.beType).toBe(report.context.beType);
    }
    await ds.close();
  });
});
