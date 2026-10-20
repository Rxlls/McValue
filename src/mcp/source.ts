/**
 * 数据源抽象：live（官方 MCP）与 mock（模拟数据）实现同一接口。
 * 上层（优化器 / 审计 / UI）只依赖本接口，便于无 Token 时跑测试与演示。
 */

import type {
  Coupon,
  MenuItem,
  NutritionFact,
  NutritionMatch,
  PriceContext,
  PriceResult,
  Store,
} from "../domain/types";
import type { PriceFailureKind } from "../domain/types";

export interface PriceInputLine {
  productCode: string;
  quantity: number;
  couponId?: string | null;
  couponCode?: string | null;
}

export interface PriceInput {
  context: PriceContext;
  items: PriceInputLine[];
}

export interface MealDetailFact {
  isCombo: boolean | null;
  componentCodes: string[] | null;
}

export interface McDataSource {
  readonly kind: "live" | "mock";
  /** 人类可读的数据来源说明，会展示在 UI 与审计报告里 */
  readonly sourceLabel: string;
  findStores(input: { city: string; keyword: string; beType: 1 | 5 }): Promise<Store[]>;
  fetchMenu(ctx: PriceContext): Promise<MenuItem[]>;
  fetchMealDetail(ctx: PriceContext, code: string): Promise<MealDetailFact | null>;
  fetchCoupons(ctx: PriceContext): Promise<Coupon[]>;
  calculatePrice(input: PriceInput): Promise<PriceResult>;
  close(): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* 营养数据解析与匹配                                                  */
/* ------------------------------------------------------------------ */

/** 官方 list-nutrition-foods 返回的 data 是自描述文本。 */
export function parseNutritionPayload(payload: string): NutritionFact[] {
  const lines = payload.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  const head = lines[0];
  const fieldNames = (head.match(/\{([^}]*)\}/)?.[1] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const idx = (name: string) => fieldNames.indexOf(name);
  const iName = idx("productName");
  const iKj = idx("energyKj");
  const iKcal = idx("energyKcal");
  const iProtein = idx("protein");
  const iFat = idx("fat");
  const iCarb = idx("carbohydrate");
  const iSodium = idx("sodium");
  const iCalcium = idx("calcium");

  const num = (v: string | undefined): number | null => {
    if (v === undefined) return null;
    const s = v.trim();
    if (!s || s === "null" || s === "-" || s === "—") return null;
    const n = Number.parseFloat(s);
    return Number.isFinite(n) ? n : null;
  };

  const facts: NutritionFact[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(",").map((c) => c.trim());
    const name = iName >= 0 ? cells[iName] : undefined;
    if (!name) continue;
    facts.push({
      productName: name,
      energyKj: num(iKj >= 0 ? cells[iKj] : undefined),
      energyKcal: num(iKcal >= 0 ? cells[iKcal] : undefined),
      protein: num(iProtein >= 0 ? cells[iProtein] : undefined),
      fat: num(iFat >= 0 ? cells[iFat] : undefined),
      carbohydrate: num(iCarb >= 0 ? cells[iCarb] : undefined),
      sodium: num(iSodium >= 0 ? cells[iSodium] : undefined),
      calcium: num(iCalcium >= 0 ? cells[iCalcium] : undefined),
    });
  }
  return facts;
}

function normalizeName(name: string): string {
  return name
    .replace(/\s+/g, "")
    .replace(/[（）()]/g, "")
    .replace(/[“”"'’]/g, "")
    .replace(/麦咖啡™/g, "")
    .toLowerCase();
}

/**
 * 营养匹配。官方营养库的命名与菜单命名并不完全一致
 * （例：菜单名「薯条」，营养库名「中薯条」），因此支持两级匹配：
 *   exact    —— 归一化后完全相等
 *   contains —— 一方包含另一方
 * 匹配方式会如实回传，contains 视为"近似匹配"，UI 需标注。
 */
export class NutritionIndex {
  private readonly byExact = new Map<string, NutritionFact>();
  constructor(private readonly facts: NutritionFact[], readonly available: boolean) {
    for (const f of facts) {
      const k = normalizeName(f.productName);
      if (k && !this.byExact.has(k)) this.byExact.set(k, f);
    }
  }

  get size(): number {
    return this.facts.length;
  }

  match(menuName: string, aliasNames: string[] = []): NutritionMatch {
    if (!this.available) {
      return { status: "unknown", fact: null, matchKind: "none" };
    }
    const candidates = [menuName, ...aliasNames].map(normalizeName).filter(Boolean);
    for (const c of candidates) {
      const hit = this.byExact.get(c);
      if (hit) return { status: "available", fact: hit, matchKind: "exact" };
    }
    for (const c of candidates) {
      for (const [k, f] of this.byExact) {
        if (k.length === 0 || c.length === 0) continue;
        if (k.includes(c) || c.includes(k)) {
          return { status: "available", fact: f, matchKind: "contains" };
        }
      }
    }
    return { status: "missing", fact: null, matchKind: "none" };
  }
}

/* ------------------------------------------------------------------ */
/* 失败结果构造                                                         */
/* ------------------------------------------------------------------ */

export function failedPriceResult(
  ctx: PriceContext,
  kind: PriceFailureKind,
  reason: string,
  lines: PriceInputLine[] = [],
): PriceResult {
  return {
    status: "failed",
    context: ctx,
    lines: lines.map((l) => ({
      productCode: l.productCode,
      productName: "（核价失败，名称未知）",
      quantity: l.quantity,
      originalSubtotalCents: null,
      subtotalCents: null,
    })),
    breakdown: {
      productOriginalCents: null,
      productCents: null,
      deliveryOriginalCents: null,
      deliveryCents: null,
      packingOriginalCents: null,
      packingCents: null,
      tablewareCents: null,
      originalCents: null,
      discountCents: null,
      payableCents: null,
    },
    takeWayList: [],
    enjoyed: null,
    enjoyable: null,
    couponState: "not-applied",
    couponId: null,
    couponNote: null,
    failureReason: reason,
    failureKind: kind,
    traceId: null,
    fetchedAt: new Date().toISOString(),
    rawSummary: null,
  };
}
