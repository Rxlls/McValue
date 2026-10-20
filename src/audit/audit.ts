/**
 * 点餐审计。
 *
 * 职责：给定一份已有点餐清单，用官方 calculate-price 核验其真实价格，
 * 并在「完全相同的定价上下文」下生成替代方案，逐字段比较差异。
 *
 * 铁律：
 * - 门店、orderType、beType、beCode、预约时间任一不同 => 不可比，不做差价结论。
 * - 只展示官方接口实际返回的字段；接口没返回的字段一律显示为"未提供"。
 * - 核价失败的方案不参与差价计算。
 */

import { createHash } from "node:crypto";
import { centsDiff, formatCents } from "../domain/money";
import { evaluateConstraints } from "../domain/constraints";
import { aggregateNutrition, estimateLines } from "../domain/pricing";
import { computeSatiety } from "../domain/satiety";
import { fingerprintOf, itemCountOf } from "../domain/lines";
import { buildPool, searchCombinations, DEFAULT_SEARCH_CONFIG, type SearchConfig } from "../optimizer/search";
import { scoreCandidate } from "../optimizer/scoring";
import type {
  AuditInputLine,
  AuditReport,
  AuditedPlan,
  CandidateLine,
  DataProvenance,
  MenuItem,
  PlanDifference,
  PriceContext,
  Requirement,
} from "../domain/types";
import type { McDataSource } from "../mcp/source";

export interface AuditInput {
  source: McDataSource;
  context: PriceContext;
  /** 原方案清单 */
  lines: AuditInputLine[];
  /** 可选的需求约束；不传则从原方案反推（件数与类别覆盖） */
  requirement?: Requirement | null;
  /**
   * 用餐人数。不传 requirement 时用它判断「这份订单够不够吃」。
   * 审计的默认口径是「核验与解释」——份量只作提示，不否决用户方案。
   */
  people?: number;
  /** 生成多少个替代方案并核价 */
  alternativeLimit?: number;
  searchConfig?: Partial<SearchConfig>;
}

function toCandidateLines(lines: AuditInputLine[], menu: Map<string, MenuItem>): CandidateLine[] {
  return lines.map((l) => {
    const item = menu.get(l.productCode);
    return {
      code: l.productCode,
      name: item?.name ?? "（菜单中未找到该编码）",
      quantity: l.quantity,
      menuPriceCents: item?.currentPriceCents ?? null,
      isCombo: item?.isCombo ?? null,
    };
  });
}

async function buildPlan(
  planId: string,
  label: string,
  lines: AuditInputLine[],
  menu: Map<string, MenuItem>,
  source: McDataSource,
  context: PriceContext,
  requirement: Requirement | null,
  couponAvailable: boolean,
): Promise<AuditedPlan> {
  const cl = toCandidateLines(lines, menu);
  const est = estimateLines(lines.map((l) => ({ code: l.productCode, quantity: l.quantity })), menu);
  const nutri = aggregateNutrition(
    lines.map((l) => ({ code: l.productCode, quantity: l.quantity, name: menu.get(l.productCode)?.name ?? l.productCode })),
    menu,
  );
  const pricing = await source.calculatePrice({ context, items: lines });

  const constraintInput = {
    lines: lines.map((l) => ({ code: l.productCode, quantity: l.quantity })),
    requirement:
      requirement ??
      ({
        rawText: "",
        budgetCents: null,
        people: 1,
        requiredCategories: [],
        maxItems: null,
        minItems: null,
        maxQtyPerItem: 99,
        mustIncludeCodes: [],
        excludeCodes: [],
        tasteKeywords: [],
        avoidKeywords: [],
        couponPreference: "auto",
        nutritionPreference: null,
        preferCombo: false,
        // 审计是「核验与解释」，不是筛选：份量只作软提示，不擅自否决用户已有方案
        mealStructure: null,
        minSatietyPerPerson: 1,
        satietyHard: false,
      } as Requirement),
    menu,
    effectiveCents: pricing.breakdown.payableCents ?? est.totalCents,
    effectiveSource: (pricing.status === "verified" ? "verified" : "estimated") as "verified" | "estimated",
    nutrition: nutri,
    couponState: pricing.couponState,
    couponAvailable,
  };
  const constraints = evaluateConstraints(constraintInput);

  const verified = pricing.breakdown.payableCents;
  const comparable = pricing.status === "verified" && verified !== null && est.totalCents !== null;
  const delta = comparable ? centsDiff(verified, est.totalCents) : null;

  return {
    planId,
    label,
    lines: cl,
    itemCount: itemCountOf(lines.map((l) => ({ code: l.productCode, quantity: l.quantity }))),
    estimate: est,
    pricing,
    constraints,
    nutrition: nutri,
    satiety: computeSatiety(
      { lines: lines.map((l) => ({ code: l.productCode, quantity: l.quantity })), menu },
      requirement?.people ?? 1,
      nutri.status === "available" ? nutri.energyKcal : null,
    ),
    consistency: {
      comparable,
      estimateCents: est.totalCents,
      verifiedCents: verified,
      deltaCents: delta,
      note: !comparable
        ? pricing.status === "failed"
          ? `核价失败（${pricing.failureReason ?? "未知原因"}），无法与估算比对`
          : "缺少可比数据"
        : delta === 0
          ? "官方核价与本地估算一致（本单无配送费/包装费/优惠）"
          : `差额 ${formatCents(delta)}：估算仅含商品菜单价，不含配送费、包装费与优惠`,
    },
  };
}

/** 从原方案反推约束，保证替代方案与原方案在同一需求口径下比较。 */
function deriveRequirement(
  lines: AuditInputLine[],
  menu: Map<string, MenuItem>,
  people = 1,
): Requirement {
  const cats = new Set<string>();
  for (const l of lines) {
    const c = menu.get(l.productCode)?.category;
    if (c) cats.add(c);
  }
  return {
    rawText: "（由原方案反推）",
    budgetCents: null,
    people: Math.max(1, people),
    requiredCategories: [...cats].map((c) => ({ category: c, minCount: 1 })),
    // 上限放宽到「原方案件数 + (人数-1)」：原方案若本就吃不饱，
    // 替代方案需要有余量补到能吃饱，否则替代方案会跟原方案一样不够吃
    maxItems:
      itemCountOf(lines.map((l) => ({ code: l.productCode, quantity: l.quantity }))) +
      Math.max(0, Math.max(1, people) - 1),
    minItems: itemCountOf(lines.map((l) => ({ code: l.productCode, quantity: l.quantity }))),
    maxQtyPerItem: 3,
    mustIncludeCodes: [],
    excludeCodes: [],
    tasteKeywords: [],
    avoidKeywords: [],
    couponPreference: "auto",
    nutritionPreference: null,
    preferCombo: false,
    // 替代方案需与原方案同口径比较；若原方案本身就吃不饱，
    // 不该用份量硬约束把「同样吃不饱但更便宜」的替代方案全部淘汰
    mealStructure: null,
    minSatietyPerPerson: 1,
    satietyHard: false,
  };
}

export async function auditOrder(input: AuditInput): Promise<AuditReport> {
  const { source, context, lines, alternativeLimit = 3 } = input;
  const cfg: SearchConfig = { ...DEFAULT_SEARCH_CONFIG, ...(input.searchConfig ?? {}) };
  const provenance: DataProvenance[] = [];

  const menuItems = await source.fetchMenu(context);
  const menu = new Map(menuItems.map((m) => [m.code, m]));
  provenance.push({
    tool: "query-meals",
    purpose: "校验原方案商品是否在该门店可售，并取菜单价用于估算比对",
    status: "success",
    note: `菜单 ${menuItems.length} 项`,
    traceId: null,
  });

  const coupons = await source.fetchCoupons(context);
  const couponAvailable = coupons.length > 0;

  const requirement = input.requirement ?? deriveRequirement(lines, menu, input.people ?? 1);

  /* 原方案核验 */
  const original = await buildPlan("original", "原方案", lines, menu, source, context, requirement, couponAvailable);
  provenance.push({
    tool: "calculate-price",
    purpose: "核验原方案真实价格",
    status: original.pricing.status === "verified" ? "success" : "failed",
    note: original.pricing.status === "verified"
      ? `应付 ${formatCents(original.pricing.breakdown.payableCents)}`
      : original.pricing.failureReason,
    traceId: original.pricing.traceId,
  });

  /* 生成替代方案 */
  const pool = buildPool(menuItems, requirement, cfg);
  const originalFp = fingerprintOf(lines.map((l) => ({ code: l.productCode, quantity: l.quantity })));
  const accepted: Array<Array<{ code: string; quantity: number }>> = [];
  searchCombinations(pool, requirement, cfg, (cand) => {
    if (fingerprintOf(cand) === originalFp) return false;
    const est = estimateLines(cand, menu);
    const nutri = aggregateNutrition(
      cand.map((c) => ({ ...c, name: menu.get(c.code)?.name ?? c.code })),
      menu,
    );
    const rep = evaluateConstraints({
      lines: cand,
      requirement,
      menu,
      effectiveCents: est.totalCents,
      effectiveSource: "estimated",
      nutrition: nutri,
      couponState: "not-applied",
      couponAvailable,
    });
    if (!rep.hardAllSatisfied) return false;
    accepted.push(cand);
    return true;
  });

  // 按评分挑最靠前的若干替代方案送去核价
  const scored = accepted.map((cand) => {
    const est = estimateLines(cand, menu);
    const nutri = aggregateNutrition(
      cand.map((c) => ({ ...c, name: menu.get(c.code)?.name ?? c.code })),
      menu,
    );
    const satiety = computeSatiety(
      { lines: cand, menu },
      requirement.people,
      nutri.status === "available" ? nutri.energyKcal : null,
    );
    return {
      cand,
      score: scoreCandidate({ lines: cand, requirement, menu, nutrition: nutri, estimateCents: est.totalCents, satiety }),
    };
  });
  scored.sort((a, b) => b.score.total - a.score.total);

  const alternatives: AuditedPlan[] = [];
  for (const s of scored.slice(0, alternativeLimit)) {
    const plan = await buildPlan(
      `alternative-${alternatives.length + 1}`,
      `替代方案 ${alternatives.length + 1}`,
      s.cand.map((c) => ({ productCode: c.code, quantity: c.quantity })),
      menu,
      source,
      context,
      requirement,
      couponAvailable,
    );
    alternatives.push(plan);
  }
  provenance.push({
    tool: "calculate-price",
    purpose: "核价替代方案（与原方案同门店、同用餐方式）",
    status: alternatives.some((a) => a.pricing.status === "verified") ? "success" : "failed",
    note: `${alternatives.length} 个替代方案已送核价`,
    traceId: null,
  });

  /* 差异比较：只在可比的前提下计算差额 */
  const differences: PlanDifference[] = [];
  const best = alternatives.find((a) => a.pricing.status === "verified");
  const comparable =
    original.pricing.status === "verified" &&
    best !== undefined &&
    original.pricing.breakdown.payableCents !== null &&
    best.pricing.breakdown.payableCents !== null;

  if (best) {
    differences.push(diffRow("商品明细", original, best, (p) => p.lines.map((l) => `${l.name} x${l.quantity}`).join(" + "), false));
    differences.push(diffRow("商品件数", original, best, (p) => String(p.itemCount), true));
    differences.push(diffRow("商品原价合计", original, best, (p) => money(p.pricing.breakdown.productOriginalCents), true));
    differences.push(diffRow("商品现价合计", original, best, (p) => money(p.pricing.breakdown.productCents), true));
    differences.push(diffRow("配送费", original, best, (p) => money(p.pricing.breakdown.deliveryCents), true));
    differences.push(diffRow("包装费", original, best, (p) => money(p.pricing.breakdown.packingCents), true));
    differences.push(diffRow("优惠金额", original, best, (p) => money(p.pricing.breakdown.discountCents), true));
    differences.push(diffRow("应付金额", original, best, (p) => money(p.pricing.breakdown.payableCents), true));
    differences.push(
      diffRow(
        "硬约束满足情况",
        original,
        best,
        (p) => (p.constraints.hardAllSatisfied ? "全部满足" : `${p.constraints.hardViolations.length} 项不满足`),
        false,
      ),
    );
  }

  const missingFields = collectMissingFields(original);
  if (missingFields.length > 0) {
    differences.push({
      field: "数据缺失",
      originalValue: missingFields.join("、"),
      alternativeValue: best ? collectMissingFields(best).join("、") || "无" : "—",
      delta: null,
      note: "官方接口未返回这些字段，未做任何推测填充",
    });
  }

  const conclusion = buildAuditConclusion(original, alternatives, comparable);

  return {
    context,
    comparability: {
      comparable,
      reason: comparable
        ? "原方案与替代方案在同一门店、同一用餐方式、同一业务编码下核价，金额可直接比较"
        : "原方案或替代方案核价失败，或两者不在同一价格上下文 —— 两者金额不可比，不做差价结论",
    },
    original,
    alternatives,
    differences,
    constraints: original.constraints,
    provenance,
    conclusion,
    generatedAt: new Date().toISOString(),
  };
}

function money(v: number | null): string {
  return v === null ? "未提供" : formatCents(v);
}

function diffRow(
  field: string,
  original: AuditedPlan,
  alt: AuditedPlan,
  pick: (p: AuditedPlan) => string,
  numeric: boolean,
): PlanDifference {
  const o = pick(original);
  const a = pick(alt);
  let delta: string | null = null;
  const ov = numericValue(original, field);
  const av = numericValue(alt, field);
  if (ov !== null && av !== null) delta = formatCents(av - ov);
  return { field, originalValue: o, alternativeValue: a, delta, note: null };
}

function numericValue(plan: AuditedPlan, field: string): number | null {
  const b = plan.pricing.breakdown;
  switch (field) {
    case "商品件数": return plan.itemCount;
    case "商品原价合计": return b.productOriginalCents;
    case "商品现价合计": return b.productCents;
    case "配送费": return b.deliveryCents;
    case "包装费": return b.packingCents;
    case "优惠金额": return b.discountCents;
    case "应付金额": return b.payableCents;
    default: return null;
  }
}

function collectMissingFields(plan: AuditedPlan): string[] {
  const b = plan.pricing.breakdown;
  const missing: string[] = [];
  if (b.deliveryCents === null) missing.push("配送费");
  if (b.packingCents === null) missing.push("包装费");
  if (b.discountCents === null) missing.push("优惠金额");
  if (plan.nutrition.status !== "available") missing.push("完整营养数据");
  return missing;
}

function buildAuditConclusion(
  original: AuditedPlan,
  alternatives: AuditedPlan[],
  comparable: boolean,
): string {
  const parts: string[] = [];
  if (original.pricing.status !== "verified") {
    parts.push(`原方案核价失败（${original.pricing.failureReason ?? "未知原因"}），无法给出可信价格`);
  } else {
    parts.push(`原方案官方核价应付 ${formatCents(original.pricing.breakdown.payableCents)}`);
    if (original.consistency.deltaCents !== null && original.consistency.deltaCents !== 0) {
      parts.push(`与本地估算相差 ${formatCents(original.consistency.deltaCents)}（${original.consistency.note}）`);
    }
  }
  const verifiedAlts = alternatives.filter((a) => a.pricing.status === "verified");
  if (verifiedAlts.length === 0) {
    parts.push("没有替代方案通过官方核价");
    return parts.join("；");
  }
  if (!comparable) {
    parts.push("已核价的替代方案与原方案不具备可比条件，暂不给差价结论");
    return parts.join("；");
  }
  const cheapest = verifiedAlts.reduce((a, b) =>
    (a.pricing.breakdown.payableCents ?? Infinity) <= (b.pricing.breakdown.payableCents ?? Infinity) ? a : b,
  );
  const orig = original.pricing.breakdown.payableCents;
  const alt = cheapest.pricing.breakdown.payableCents;
  // 明确说清「更贵还是更省」——只给带符号的差值容易被读反
  const diff = (alt ?? 0) - (orig ?? 0);
  const rel =
    diff === 0 ? "与原方案价格持平" : diff > 0 ? `比原方案贵 ${formatCents(diff)}` : `比原方案省 ${formatCents(-diff)}`;
  parts.push(
    `在已检查的 ${verifiedAlts.length} 个替代方案中，${cheapest.label} 应付 ${formatCents(alt)}，${rel}`,
  );
  return parts.join("；");
}

/** 供 UI 展示的稳定摘要 ID。 */
export function auditIdOf(report: AuditReport): string {
  return createHash("sha256")
    .update(`${JSON.stringify(report.context)}|${report.generatedAt}`)
    .digest("hex")
    .slice(0, 12);
}
