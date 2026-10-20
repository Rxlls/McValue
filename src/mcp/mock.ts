/**
 * 模拟数据源。
 *
 * 重要：本文件里的门店、价格、优惠、营养数字全部是「为演示与单元测试构造的假数据」，
 * 一律带 SIM- 前缀与「模拟」字样，绝不冒充麦当劳真实业务数据。
 * 任何 UI / 报告在 mock 模式下都必须标注「模拟数据」。
 */

import type { Cents } from "../domain/money";
import type {
  Coupon,
  MenuItem,
  NutritionFact,
  PriceContext,
  PriceResult,
  Store,
} from "../domain/types";
import {
  NutritionIndex,
  failedPriceResult,
  type McDataSource,
  type MealDetailFact,
  type PriceInput,
} from "./source";

export interface MockCatalogItem {
  code: string;
  name: string;
  category: string;
  priceCents: Cents;
  tags?: string[];
  isCombo?: boolean;
  components?: string[];
  nutrition?: Partial<NutritionFact>;
}

/** 模拟菜单：价格与营养仅用于验证算法行为，不代表真实商品。 */
export const MOCK_CATALOG: MockCatalogItem[] = [
  { code: "SIM-BG-01", name: "模拟吉士汉堡", category: "汉堡", priceCents: 1200, nutrition: { energyKcal: 294, protein: 16, fat: 12, carbohydrate: 30, sodium: 673 } },
  { code: "SIM-BG-02", name: "模拟双层牛肉堡", category: "汉堡", priceCents: 1800, nutrition: { energyKcal: 429, protein: 27, fat: 22, carbohydrate: 31, sodium: 1017 } },
  { code: "SIM-BG-03", name: "模拟香辣鸡腿堡", category: "汉堡", priceCents: 1500, nutrition: { energyKcal: 485, protein: 24, fat: 24, carbohydrate: 42, sodium: 1208 } },
  { code: "SIM-SN-01", name: "模拟中薯条", category: "小食", priceCents: 800, nutrition: { energyKcal: 289, protein: 4, fat: 12, carbohydrate: 38, sodium: 165 } },
  { code: "SIM-SN-02", name: "模拟麦乐鸡5块", category: "小食", priceCents: 1100, nutrition: { energyKcal: 213, protein: 12, fat: 12, carbohydrate: 13, sodium: 422 } },
  { code: "SIM-SN-03", name: "模拟玉米杯", category: "小食", priceCents: 600, nutrition: { energyKcal: 53, protein: 2, fat: 1, carbohydrate: 7, sodium: 1 } },
  { code: "SIM-DR-01", name: "模拟中杯可乐", category: "饮料", priceCents: 600, nutrition: { energyKcal: 147, protein: 0, fat: 0, carbohydrate: 36, sodium: 0 } },
  // 刻意不提供营养数据：用于测试"营养数据缺失"分支
  { code: "SIM-DR-02", name: "模拟无糖可乐", category: "饮料", priceCents: 600 },
  { code: "SIM-DR-03", name: "模拟纯牛奶", category: "饮料", priceCents: 1050, nutrition: { energyKcal: 130, protein: 8, fat: 5, carbohydrate: 12, sodium: 100 } },
  { code: "SIM-DS-01", name: "模拟圆筒冰淇淋", category: "甜品", priceCents: 500, nutrition: { energyKcal: 93, protein: 2, fat: 3, carbohydrate: 14, sodium: 36 } },
  // 刻意不提供营养数据
  { code: "SIM-DS-02", name: "模拟香芋派", category: "甜品", priceCents: 800 },
  { code: "SIM-CB-01", name: "模拟单人套餐", category: "套餐", priceCents: 2400, isCombo: true, components: ["SIM-BG-01", "SIM-SN-01", "SIM-DR-01"], tags: ["套餐"] },
  { code: "SIM-CB-02", name: "模拟双人分享餐", category: "套餐", priceCents: 4500, isCombo: true, components: ["SIM-BG-02", "SIM-BG-03", "SIM-SN-01", "SIM-SN-02", "SIM-DR-01"], tags: ["套餐"] },
];

export const MOCK_STORE: Store = {
  storeCode: "SIM-STORE-0001",
  storeName: "模拟门店（非真实门店）",
  address: "模拟地址 1 号",
  distance: 0,
  businessStatus: true,
  businessStartTime: "00:00",
  businessEndTime: "23:59",
};

/** 模拟券：仅对双人分享餐生效，用于测试"优惠不适用"分支。 */
export const MOCK_COUPON: Coupon = {
  couponId: "SIM-CP-01",
  couponCode: "SIMCODE001",
  title: "模拟满45减6券",
  tradeDateTime: "模拟有效期",
  applicableProductCodes: ["SIM-CB-02"],
};

export interface MockOptions {
  /** 核价失败注入 */
  priceFailure: "none" | "always" | "timeout";
  /** 券实际生效需要的商品编码 */
  couponApplicableCodes: string[];
}

export class MockDataSource implements McDataSource {
  readonly kind = "mock" as const;
  readonly sourceLabel = "模拟数据（非真实价格，仅用于演示与测试）";

  constructor(public options: MockOptions = { priceFailure: "none", couponApplicableCodes: MOCK_COUPON.applicableProductCodes }) {}

  private nutritionIndex(): NutritionIndex {
    const facts: NutritionFact[] = MOCK_CATALOG.filter((i) => i.nutrition).map((i) => ({
      productName: i.name,
      energyKj: i.nutrition?.energyKj ?? null,
      energyKcal: i.nutrition?.energyKcal ?? null,
      protein: i.nutrition?.protein ?? null,
      fat: i.nutrition?.fat ?? null,
      carbohydrate: i.nutrition?.carbohydrate ?? null,
      sodium: i.nutrition?.sodium ?? null,
      calcium: i.nutrition?.calcium ?? null,
    }));
    return new NutritionIndex(facts, true);
  }

  async findStores(_input?: { city: string; keyword: string; beType: 1 | 5 }): Promise<Store[]> {
    return [MOCK_STORE];
  }

  async fetchMenu(_ctx?: PriceContext): Promise<MenuItem[]> {
    const nutri = this.nutritionIndex();
    return MOCK_CATALOG.map((i) => ({
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
      nutrition: nutri.match(i.name),
    }));
  }

  async fetchMealDetail(_ctx: PriceContext, code: string): Promise<MealDetailFact | null> {
    const item = MOCK_CATALOG.find((i) => i.code === code);
    if (!item) return null;
    return {
      isCombo: item.isCombo ?? false,
      componentCodes: item.components ?? null,
    };
  }

  async fetchCoupons(_ctx?: PriceContext): Promise<Coupon[]> {
    return [MOCK_COUPON];
  }

  async calculatePrice(input: PriceInput): Promise<PriceResult> {
    const { context: ctx, items } = input;
    const couponId = items.find((i) => i.couponId)?.couponId ?? null;

    if (this.options.priceFailure === "timeout") {
      return failedPriceResult(ctx, "timeout", "模拟核价超时", items);
    }
    if (this.options.priceFailure === "always") {
      return failedPriceResult(ctx, "business", "模拟核价业务失败", items);
    }

    const catalog = new Map(MOCK_CATALOG.map((i) => [i.code, i]));
    const lines = items.map((i) => {
      const c = catalog.get(i.productCode);
      const subtotal = c ? c.priceCents * i.quantity : null;
      return {
        productCode: i.productCode,
        productName: c?.name ?? "（模拟目录无此商品）",
        quantity: i.quantity,
        originalSubtotalCents: subtotal,
        subtotalCents: subtotal,
      };
    });

    const unknown = lines.some((l) => l.subtotalCents === null);
    const productCents = unknown ? null : lines.reduce((s, l) => s + (l.subtotalCents ?? 0), 0);

    // 外送场景才产生配送费与包装费；到店场景官方不返回这两个字段，因此如实为 null（不是 0）
    const deliveryCents: Cents | null = ctx.orderType === 2 ? 600 : null;
    const packingCents: Cents | null = ctx.orderType === 2 ? 190 : null;

    let discountCents = 0 as Cents;
    let couponState: PriceResult["couponState"] = "not-applied";
    let couponNote: string | null = null;
    if (couponId) {
      const applicable = items.some((i) => this.options.couponApplicableCodes.includes(i.productCode));
      if (applicable) {
        discountCents = 600;
        couponState = "applied";
        couponNote = "券 SIM-CP-01 已计入，模拟优惠 6.00 元";
      } else {
        couponState = "rejected";
        couponNote = "券已传入核价，但官方返回优惠金额为 0，无法确认该券对本组合生效（可能不适用或门槛未达）";
      }
    }

    const extra = (deliveryCents ?? 0) + (packingCents ?? 0);
    const payable = productCents === null ? null : productCents + extra - discountCents;

    return {
      status: "verified",
      context: ctx,
      lines,
      breakdown: {
        productOriginalCents: productCents,
        productCents,
        deliveryOriginalCents: deliveryCents,
        deliveryCents,
        packingOriginalCents: packingCents,
        packingCents,
        tablewareCents: 0,
        originalCents: productCents === null ? null : productCents + extra,
        discountCents,
        payableCents: payable,
      },
      takeWayList: ctx.orderType === 1 ? [{ code: "eat-in", title: "堂食", subtitle: "店内用餐" }] : [],
      enjoyed: null,
      enjoyable: null,
      couponState,
      couponId,
      couponNote,
      failureReason: null,
      failureKind: null,
      traceId: "SIM-TRACE",
      fetchedAt: new Date().toISOString(),
      rawSummary: null,
    };
  }

  async close(): Promise<void> {
    /* 模拟数据源无需释放 */
  }
}
