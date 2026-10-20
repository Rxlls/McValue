/**
 * 真实数据源：调用麦当劳官方 MCP Server。
 *
 * 所有工具名、字段名、枚举值均取自 reference/mcp-tools.json（官方 Schema）
 * 与 reference/live/*.txt（真实响应），未做任何猜测。
 */

import type { Cents } from "../domain/money";
import { yuanToCents } from "../domain/money";
import type {
  Coupon,
  MenuItem,
  NutritionFact,
  PriceContext,
  PriceResult,
  Store,
} from "../domain/types";
import { McpCallError, type McpRawClient } from "./client";
import { parseEnvelope, toolText } from "./parse";
import type { RawCoupon, RawMealDetail, RawMenu, RawStore } from "./schema";
import {
  NutritionIndex,
  failedPriceResult,
  parseNutritionPayload,
  type McDataSource,
  type MealDetailFact,
  type PriceInput,
} from "./source";

const COMBO_NAME_RE = /(套餐|三件套|四件套|五件套|双人餐|多人餐|分享餐|随心配|随心拼|拼盘|全家桶|开心乐园餐|组合)/;

export class LiveDataSource implements McDataSource {
  readonly kind = "live" as const;
  readonly sourceLabel = "麦当劳官方 MCP（真实数据）";

  private nutritionIndex: NutritionIndex | null = null;
  private nutritionLoad: Promise<NutritionIndex> | null = null;
  private readonly storeCache = new Map<string, Store[]>();
  private readonly menuCache = new Map<string, MenuItem[]>();
  private readonly detailCache = new Map<string, MealDetailFact | null>();
  private readonly couponCache = new Map<string, Coupon[]>();

  constructor(private readonly client: McpRawClient) {}

  private ctxArgs(ctx: PriceContext): Record<string, unknown> {
    const args: Record<string, unknown> = {
      storeCode: ctx.storeCode,
      orderType: ctx.orderType,
      beType: ctx.beType,
    };
    // 到店自取场景官方明确要求不传 beCode，传了会报错
    if (ctx.beCode) args.beCode = ctx.beCode;
    if (ctx.reservationDate) args.reservationDate = ctx.reservationDate;
    return args;
  }

  async findStores(input: { city: string; keyword: string; beType: 1 | 5 }): Promise<Store[]> {
    const key = `${input.beType}|${input.city}|${input.keyword}`;
    const hit = this.storeCache.get(key);
    if (hit) return hit;
    const res = await this.client.callTool("query-nearby-stores", {
      beType: input.beType,
      searchType: 2, // 2=按位置搜索（1=收藏，官方默认）
      city: input.city,
      keyword: input.keyword,
    });
    const env = parseEnvelope<RawStore[]>(res.text);
    if (!env.success) {
      throw new McpCallError("business", `query-nearby-stores 业务失败: ${env.message}`, env);
    }
    const stores: Store[] = (env.data ?? []).map((s) => ({
      storeCode: s.storeCode,
      storeName: s.storeName,
      address: s.address ?? null,
      distance: typeof s.distance === "number" ? s.distance : null,
      businessStatus: typeof s.businessStatus === "boolean" ? s.businessStatus : null,
      businessStartTime: s.businessStartTime ?? null,
      businessEndTime: s.businessEndTime ?? null,
    }));
    this.storeCache.set(key, stores);
    return stores;
  }

  private async nutrition(): Promise<NutritionIndex> {
    if (this.nutritionIndex) return this.nutritionIndex;
    if (this.nutritionLoad) return this.nutritionLoad;
    this.nutritionLoad = (async () => {
      try {
        const res = await this.client.callTool("list-nutrition-foods", {});
        const env = parseEnvelope<string>(res.text);
        const facts: NutritionFact[] = [];
        if (env.success && typeof env.data === "string") {
          facts.push(...parseNutritionPayload(env.data));
        }
        this.nutritionIndex = new NutritionIndex(facts, facts.length > 0);
      } catch {
        // 营养数据拿不到时降级为"未知"，绝不伪造
        this.nutritionIndex = new NutritionIndex([], false);
      }
      return this.nutritionIndex;
    })();
    return this.nutritionLoad;
  }

  async fetchMenu(ctx: PriceContext): Promise<MenuItem[]> {
    const key = [
      ctx.storeCode,
      ctx.orderType,
      ctx.beType,
      ctx.beCode ?? "-",
      ctx.reservationDate ?? "-",
    ].join("|");
    const cached = this.menuCache.get(key);
    if (cached) return cached;

    const res = await this.client.callTool("query-meals", this.ctxArgs(ctx));
    const env = parseEnvelope<RawMenu>(res.text);
    if (!env.success) {
      throw new McpCallError("business", `query-meals 业务失败: ${env.message}`, env);
    }
    const raw = env.data;
    if (!raw) throw new McpCallError("business", "query-meals 返回 data 为空", env);

    const categoryOf = new Map<string, { name: string; tags: string[] }>();
    for (const cat of raw.categories ?? []) {
      for (const m of cat.meals ?? []) {
        const prev = categoryOf.get(m.code);
        if (prev) {
          prev.tags = Array.from(new Set([...prev.tags, ...(m.tags ?? [])]));
        } else {
          categoryOf.set(m.code, { name: cat.name, tags: [...(m.tags ?? [])] });
        }
      }
    }

    const nutri = await this.nutrition();
    const items: MenuItem[] = [];
    for (const [code, detail] of Object.entries(raw.meals ?? {})) {
      const meta = categoryOf.get(code);
      const name = detail?.name ?? null;
      const price = yuanToCents(detail?.currentPrice ?? null);
      // 菜单映射里拿不到名称或价格 —— 该商品无法参与预算计算，如实标记为未知
      if (!name || price === null) {
        items.push({
          code,
          name: name ?? `（编码 ${code}：菜单未返回名称）`,
          category: meta?.name ?? "未分类",
          tags: meta?.tags ?? [],
          image: detail?.image ?? null,
          currentPriceCents: price,
          originalPriceCents: yuanToCents(detail?.originalPrice ?? null),
          discountType: detail?.discountType ?? null,
          priceConditional: (detail?.discountType ?? "").startsWith("随单购"),
          canWithOrder: detail?.canWithOrder === true,
          availability: "unknown",
          isCombo: null,
          comboDetection: "unknown",
          comboComponentCodes: null,
          nutrition: nutri.match(name ?? ""),
        });
        continue;
      }
      const tags = meta?.tags ?? [];
      const heuristicCombo = tags.includes("套餐") || COMBO_NAME_RE.test(name);
      items.push({
        code,
        name,
        category: meta?.name ?? "未分类",
        tags,
        image: detail?.image ?? null,
        currentPriceCents: price,
        originalPriceCents: yuanToCents(detail?.originalPrice ?? null),
        discountType: detail?.discountType ?? null,
        priceConditional: (detail?.discountType ?? "").startsWith("随单购"),
        canWithOrder: detail?.canWithOrder === true,
        availability: "available",
        isCombo: heuristicCombo,
        comboDetection: "heuristic",
        comboComponentCodes: null,
        nutrition: nutri.match(name),
      });
    }

    this.menuCache.set(key, items);
    return items;
  }

  async fetchMealDetail(ctx: PriceContext, code: string): Promise<MealDetailFact | null> {
    const key = `${ctx.storeCode}|${ctx.orderType}|${ctx.beType}|${ctx.beCode ?? "-"}|${code}`;
    if (this.detailCache.has(key)) return this.detailCache.get(key) ?? null;
    try {
      const res = await this.client.callTool("query-meal-detail", {
        ...this.ctxArgs(ctx),
        code,
      });
      const env = parseEnvelope<RawMealDetail>(res.text);
      if (!env.success || !env.data) {
        this.detailCache.set(key, null);
        return null;
      }
      const rounds = env.data.rounds ?? [];
      const isCombo = rounds.length > 0;
      const components = rounds
        .flatMap((r) => r.choices ?? [])
        .filter((c) => c.isDefault === 1 && typeof c.code === "string")
        .map((c) => c.code as string);
      const fact: MealDetailFact = {
        isCombo,
        componentCodes: isCombo ? components : null,
      };
      this.detailCache.set(key, fact);
      return fact;
    } catch {
      this.detailCache.set(key, null);
      return null;
    }
  }

  async fetchCoupons(ctx: PriceContext): Promise<Coupon[]> {
    const key = [
      ctx.storeCode,
      ctx.orderType,
      ctx.beType,
      ctx.beCode ?? "-",
      ctx.reservationDate ?? "-",
    ].join("|");
    const cached = this.couponCache.get(key);
    if (cached) return cached;
    try {
      const res = await this.client.callTool("query-store-coupons", this.ctxArgs(ctx));
      const env = parseEnvelope<RawCoupon[]>(res.text);
      if (!env.success) {
        this.couponCache.set(key, []);
        return [];
      }
      const coupons: Coupon[] = (env.data ?? [])
        .filter((c): c is RawCoupon & { couponId: string } => typeof c.couponId === "string")
        .map((c) => ({
          couponId: c.couponId,
          couponCode: c.couponCode ?? null,
          title: c.title ?? null,
          tradeDateTime: c.tradeDateTime ?? null,
          applicableProductCodes: (c.products ?? [])
            .map((p) => p.productCode)
            .filter((x): x is string => typeof x === "string"),
        }));
      this.couponCache.set(key, coupons);
      return coupons;
    } catch {
      this.couponCache.set(key, []);
      return [];
    }
  }

  async calculatePrice(input: PriceInput): Promise<PriceResult> {
    const { context: ctx, items } = input;
    const payloadItems = items.map((i) => {
      const o: Record<string, unknown> = { productCode: i.productCode, quantity: i.quantity };
      if (i.couponId) o.couponId = i.couponId;
      if (i.couponCode) o.couponCode = i.couponCode;
      return o;
    });
    const couponId = items.find((i) => i.couponId)?.couponId ?? null;

    try {
      const res = await this.client.callTool("calculate-price", {
        ...this.ctxArgs(ctx),
        items: payloadItems,
      });
      const env = parseEnvelope<Record<string, unknown>>(res.text);
      if (!env.success) {
        return {
          ...failedPriceResult(ctx, "business", `核价业务失败：${env.message ?? "未知原因"}`, items),
          traceId: env.traceId,
          couponId,
          couponState: couponId ? "rejected" : "not-applied",
          couponNote: couponId ? "核价未返回成功结果，无法确认该券是否生效" : null,
        };
      }
      const d = (env.data ?? {}) as Record<string, unknown>;

      const num = (k: string): Cents | null => {
        const v = d[k];
        return typeof v === "number" && Number.isFinite(v) ? v : null;
      };
      const rawList = Array.isArray(d["productList"]) ? (d["productList"] as Array<Record<string, unknown>>) : [];
      const lines = rawList.map((p) => ({
        productCode: String(p["productCode"] ?? ""),
        productName: String(p["productName"] ?? "（官方未返回名称）"),
        quantity: typeof p["quantity"] === "number" ? p["quantity"] : 0,
        originalSubtotalCents: typeof p["originalSubtotal"] === "number" ? p["originalSubtotal"] : null,
        subtotalCents: typeof p["subtotal"] === "number" ? p["subtotal"] : null,
      }));
      const takeWayList = Array.isArray(d["takeWayList"])
        ? (d["takeWayList"] as Array<Record<string, unknown>>).map((t) => ({
            code: String(t["code"] ?? ""),
            title: typeof t["title"] === "string" ? t["title"] : null,
            subtitle: typeof t["subtitle"] === "string" ? t["subtitle"] : null,
          }))
        : [];

      const readEnjoy = (k: string) => {
        const o = d[k];
        if (!o || typeof o !== "object") return null;
        const e = o as Record<string, unknown>;
        return {
          amountType: typeof e["amountType"] === "string" ? e["amountType"] : null,
          realDiscount: typeof e["realDiscount"] === "number" ? e["realDiscount"] : null,
          balance: typeof e["balance"] === "number" ? e["balance"] : null,
        };
      };

      const discountCents = num("discount");
      let couponState: PriceResult["couponState"] = "not-applied";
      let couponNote: string | null = null;
      if (couponId) {
        if (discountCents !== null && discountCents > 0) {
          couponState = "applied";
          couponNote = `券 ${couponId} 已计入，本次核价优惠金额 ${(discountCents / 100).toFixed(2)} 元`;
        } else {
          couponState = "rejected";
          couponNote = "券已传入核价，但官方返回优惠金额为 0，无法确认该券对本组合生效（可能不适用或门槛未达）";
        }
      }

      return {
        status: "verified",
        context: ctx,
        lines,
        breakdown: {
          productOriginalCents: num("productOriginalPrice"),
          productCents: num("productPrice"),
          deliveryOriginalCents: num("deliveryOriginalPrice"),
          deliveryCents: num("deliveryPrice"),
          packingOriginalCents: num("packingOriginalPrice"),
          packingCents: num("packingPrice"),
          tablewareCents: num("tablewarePrice"),
          originalCents: num("originalPrice"),
          discountCents,
          payableCents: num("price"),
        },
        takeWayList,
        enjoyed: readEnjoy("enjoyed"),
        enjoyable: readEnjoy("enjoyable"),
        couponState,
        couponId,
        couponNote,
        failureReason: null,
        failureKind: null,
        traceId: env.traceId,
        fetchedAt: new Date().toISOString(),
        rawSummary: null,
      };
    } catch (e) {
      const err = e as McpCallError;
      const kind = err?.kind === "timeout" ? "timeout" : err?.kind === "unauthorized" ? "business" : "transport";
      return {
        ...failedPriceResult(ctx, kind, err?.message ?? "核价调用失败", items),
        couponId,
        couponState: couponId ? "rejected" : "not-applied",
        couponNote: couponId ? "核价未成功，无法确认该券是否生效" : null,
      };
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
