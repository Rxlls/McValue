/**
 * 套餐优化编排。
 *
 * 流水线：
 *   菜单(MCP) -> 候选池 -> 有界回溯搜索(硬约束基于本地估算) -> 评分排序
 *   -> Top-N 送官方 calculate-price 核价 -> 按官方返回金额重排 -> 复核硬约束
 *
 * 铁律：
 * - 本地估算只用于剪枝与挑选送核价的候选，绝不充当最终价格。
 * - 最终排序键是官方核价返回的 payableCents。
 * - 未穷举时结论只能写「已检查候选中的最优方案」。
 */

import { formatCents } from "../domain/money";
import { evaluateConstraints } from "../domain/constraints";
import { aggregateNutrition, estimateLines } from "../domain/pricing";
import { computeSatiety, describeSatiety, slotSatietyOf, MAIN_SLOTS } from "../domain/satiety";
import type { CategorySlot } from "../domain/requirement";
import { fingerprintOf, itemCountOf } from "../domain/lines";
import type {
  Candidate,
  CandidateLine,
  Coupon,
  DataProvenance,
  MenuItem,
  OptimizationReport,
  PriceContext,
  Requirement,
  Store,
} from "../domain/types";
import type { McDataSource } from "../mcp/source";
import { scoreCandidate } from "./scoring";
import { DEFAULT_SEARCH_CONFIG, buildPool, searchCombinations, type SearchConfig } from "./search";

export interface OptimizeInput {
  source: McDataSource;
  context: PriceContext;
  requirement: Requirement;
  store?: Store | null;
  parseNotes?: string[];
  searchConfig?: Partial<SearchConfig>;
  /** 送官方核价的候选数上限 */
  verifyLimit?: number;
  /** 最多对多少个候选尝试用券核价 */
  couponTryLimit?: number;
  /** 最多对多少个套餐商品调用 query-meal-detail 确认组成 */
  detailConfirmLimit?: number;
}

function toLines(
  lines: Array<{ code: string; quantity: number }>,
  menu: Map<string, MenuItem>,
): CandidateLine[] {
  return lines.map((l) => {
    const item = menu.get(l.code);
    return {
      code: l.code,
      name: item?.name ?? "（菜单未返回名称）",
      quantity: l.quantity,
      menuPriceCents: item?.currentPriceCents ?? null,
      isCombo: item?.isCombo ?? null,
    };
  });
}

export async function optimize(input: OptimizeInput): Promise<OptimizationReport> {
  const {
    source,
    context,
    requirement: inputRequirement,
    store = null,
    // 需要足够的核价样本才能挑出「风格不同」的候选，只核 5 个会全是换饮料的变体
    verifyLimit = 8,
    couponTryLimit = 3,
    detailConfirmLimit = 3,
  } = input;
  // 可被「冲突自动放宽」改写；accept 闭包读的就是这个变量
  let requirement: Requirement = inputRequirement;
  const cfg: SearchConfig = { ...DEFAULT_SEARCH_CONFIG, ...(input.searchConfig ?? {}) };
  const provenance: DataProvenance[] = [];

  /* 1. 菜单 */
  const menuItems = await source.fetchMenu(context);
  const menu = new Map(menuItems.map((m) => [m.code, m]));
  provenance.push({
    tool: "query-meals",
    purpose: "获取门店当前可售菜单与菜单现价",
    status: "success",
    note: `${menuItems.length} 项，其中 ${menuItems.filter((m) => m.availability === "available" && m.currentPriceCents !== null).length} 项可参与计算`,
    traceId: null,
  });

  /* 2. 门店券（唯一带 couponId 的结构化券源） */
  let coupons: Coupon[] = [];
  try {
    coupons = await source.fetchCoupons(context);
    provenance.push({
      tool: "query-store-coupons",
      purpose: "获取门店可用优惠券（唯一提供 couponId 的券源）",
      status: "success",
      note: coupons.length === 0 ? "该门店当前无可用结构化券" : `${coupons.length} 张可用`,
      traceId: null,
    });
  } catch (e) {
    provenance.push({
      tool: "query-store-coupons",
      purpose: "获取门店可用优惠券",
      status: "failed",
      note: (e as Error).message,
      traceId: null,
    });
  }
  const couponAvailable = coupons.length > 0;

  /* 2.5 点名商品：用户明确说出的商品名（"要两杯可乐"里的可乐）
   *   作为强偏好而非硬约束 —— 门店没货时不该直接无解 */
  const namedProducts = (() => {
    const raw = requirement.rawText ?? "";
    if (!raw.trim()) return [] as MenuItem[];
    return menuItems.filter(
      (m) => m.name.length >= 2 && m.availability === "available" && raw.includes(m.name),
    );
  })();
  const preferredCodes = new Set(namedProducts.map((m) => m.code));
  if (namedProducts.length > 0) {
    provenance.push({
      tool: "(本地)点名商品匹配",
      purpose: "识别用户点名的商品，作为强偏好参与候选池排序（不是硬约束）",
      status: "success",
      note: namedProducts.map((m) => m.name).join("、"),
      traceId: null,
    });
  }

  /* 3. 候选池 + 搜索（硬约束基于本地估算） */
  const pool = buildPool(menuItems, requirement, cfg, preferredCodes);
  const accept = (lines: Array<{ code: string; quantity: number }>): boolean => {
    const est = estimateLines(lines, menu);
    const nutri = aggregateNutrition(
      lines.map((l) => ({ ...l, name: menu.get(l.code)?.name ?? l.code })),
      menu,
    );
    const rep = evaluateConstraints({
      lines,
      requirement,
      menu,
      effectiveCents: est.totalCents,
      effectiveSource: "estimated",
      nutrition: nutri,
      couponState: "not-applied",
      couponAvailable,
    });
    return rep.hardAllSatisfied;
  };

  let search = searchCombinations(pool, requirement, cfg, accept);

  /* 3.5 冲突时自动放宽最软的一条（饮料），并如实说明放宽了什么
   *   预算是硬的、份量是硬的、口味是软偏好 —— 饮料杯数是最容易让步的一项 */
  let relaxationNote: string | null = null;
  if (search.combos.length === 0 && requirement.mealStructure && requirement.mealStructure.drink > 0) {
    const ms = requirement.mealStructure;
    const nextDrink = ms.drink - 1;
    const relaxedCats = requirement.requiredCategories
      .map((c) => (c.category === "drink" ? { ...c, minCount: nextDrink } : c))
      .filter((c) => c.minCount > 0);
    const relaxed: Requirement = {
      ...requirement,
      mealStructure: { ...ms, drink: nextDrink, derived: true },
      requiredCategories: relaxedCats,
    };
    requirement = relaxed; // accept 闭包读的是这个变量，后续搜索会自动用新约束
    const relaxedSearch = searchCombinations(pool, relaxed, cfg, accept);
    if (relaxedSearch.combos.length > 0) {
      search = relaxedSearch;
      relaxationNote = `原约束下无可行组合，已自动把饮料从 ${ms.drink} 杯放宽到 ${nextDrink} 杯`;
    } else {
      // 放宽也没救，回滚，避免报告里的结构与实际使用的不一致
      requirement = inputRequirement;
    }
  }

  provenance.push({
    tool: "(本地)有界回溯搜索",
    purpose: "在预算/类别/数量硬约束下枚举组合并去重",
    status: "success",
    note: `候选池 ${search.poolSize} 项，评估 ${search.evaluatedCount} 个组合，淘汰 ${search.rejectedCount} 个，保留 ${search.combos.length} 个${search.boundedReason ? `（受限：${search.boundedReason}）` : "（已穷举）"}${relaxationNote ? `；${relaxationNote}` : ""}`,
    traceId: null,
  });

  /* 4. 评分 */
  const scored = search.combos.map((lines) => {
    const est = estimateLines(lines, menu);
    const nutri = aggregateNutrition(
      lines.map((l) => ({ ...l, name: menu.get(l.code)?.name ?? l.code })),
      menu,
    );
    const satiety = computeSatiety(
      { lines, menu },
      requirement.people,
      nutri.status === "available" ? nutri.energyKcal : null,
    );
    return {
      lines,
      est,
      nutri,
      satiety,
      score: scoreCandidate({ lines, requirement, menu, nutrition: nutri, estimateCents: est.totalCents, satiety }),
    };
  });
  scored.sort((a, b) => b.score.total - a.score.total);

  /* 5. 送官方核价：先按核心结构去重，保证核价的几个是不同方案而不是换饮料 */
  const toVerify: typeof scored = [];
  {
    const seenCore = new Set<string>();
    const take = (arr: typeof scored) => {
      for (const s of arr) {
        if (toVerify.length >= verifyLimit) return;
        const core = coreKeyOf(s.lines, menu);
        if (seenCore.has(core)) continue;
        seenCore.add(core);
        toVerify.push(s);
      }
    };
    // 一半按综合分、一半按估算价：只按分数取会让「最省」这一档拿到并不便宜的方案
    const byScore = [...scored].sort((a, b) => b.score.total - a.score.total);
    const byPrice = [...scored].sort(
      (a, b) => (a.est.totalCents ?? Number.MAX_SAFE_INTEGER) - (b.est.totalCents ?? Number.MAX_SAFE_INTEGER),
    );
    // 点名商品优先送核价
    if (preferredCodes.size > 0) {
      take(byScore.filter((s) => s.lines.some((l) => preferredCodes.has(l.code))));
    }
    take(byScore.slice(0, Math.ceil(verifyLimit / 2)));
    take(byPrice);
  }
  let verifiedCount = 0;
  let failedPriceCount = 0;
  const candidates: Candidate[] = [];

  for (const s of toVerify) {
    const pricing = await source.calculatePrice({
      context,
      items: s.lines.map((l) => ({ productCode: l.code, quantity: l.quantity })),
    });
    if (pricing.status === "verified") verifiedCount++;
    else failedPriceCount++;
    candidates.push(
      buildCandidate(s.lines, menu, requirement, s.score, s.est, s.nutri, pricing, couponAvailable),
    );
  }

  /* 6. 用券复算（限次） */
  if (couponAvailable && requirement.couponPreference !== "ignore") {
    let tried = 0;
    for (const cand of candidates) {
      if (tried >= couponTryLimit) break;
      if (cand.pricing.status !== "verified") continue;
      const coupon = pickCoupon(coupons, cand.lines);
      if (!coupon) continue;
      tried++;
      const withCoupon = await source.calculatePrice({
        context,
        items: cand.lines.map((l) => ({
          productCode: l.code,
          quantity: l.quantity,
          couponId: coupon.couponId,
          couponCode: coupon.couponCode,
        })),
      });
      const better =
        withCoupon.status === "verified" &&
        withCoupon.breakdown.payableCents !== null &&
        cand.pricing.breakdown.payableCents !== null &&
        withCoupon.breakdown.payableCents < cand.pricing.breakdown.payableCents;
      if (better) {
        candidates[candidates.indexOf(cand)] = buildCandidate(
          cand.lines.map((l) => ({ code: l.code, quantity: l.quantity })),
          menu,
          requirement,
          cand.score,
          cand.estimate,
          cand.nutrition,
          withCoupon,
          couponAvailable,
        );
      }
    }
    provenance.push({
      tool: "calculate-price(含 couponId)",
      purpose: "对候选尝试用券核价，仅在官方返回金额更低时采纳",
      status: tried > 0 ? "success" : "skipped",
      note: tried > 0 ? `对 ${tried} 个候选尝试用券` : "无可适用的券组合",
      traceId: null,
    });
  }

  /* 7. 用官方核价结果复核硬约束；不符合者淘汰并说明原因 */
  const kept: Candidate[] = [];
  const postRejected: OptimizationReport["postVerificationRejected"] = [];
  for (const cand of candidates) {
    if (cand.pricing.status !== "verified") {
      kept.push(cand); // 核价失败单独标注，不混入"违反约束"
      continue;
    }
    const rep = evaluateConstraints({
      lines: cand.lines,
      requirement,
      menu,
      effectiveCents: cand.pricing.breakdown.payableCents,
      effectiveSource: "verified",
      nutrition: cand.nutrition,
      couponState: cand.pricing.couponState,
      couponAvailable,
    });
    const updated: Candidate = { ...cand, constraints: rep };
    if (rep.hardAllSatisfied) kept.push(updated);
    else {
      postRejected.push({
        fingerprint: cand.fingerprint,
        names: cand.lines.map((l) => `${l.name} x${l.quantity}`),
        reasons: rep.hardViolations.map((v) => `${v.label}：${v.reason ?? "未满足"}`),
      });
    }
  }

  /* 8. 排序：满足度优先，价格只作同分时的次要键
   *
   * 这里曾经是「按核价金额升序」——那等于把最便宜的方案排第一，
   * 会稳定地推荐「2 个人点 1 个汉堡」这种吃不饱的方案。
   * 预算是上限不是目标：主键改为综合评分（份量权重最高），
   * 评分相同时才偏好更便宜的。
   */
  kept.sort((a, b) => {
    if (b.score.total !== a.score.total) return b.score.total - a.score.total;
    const pa = a.pricing.breakdown.payableCents;
    const pb = b.pricing.breakdown.payableCents;
    if (pa === null && pb === null) return 0;
    if (pa === null) return 1;
    if (pb === null) return -1;
    return pa - pb;
  });

  /* 9. 确认套餐真实组成（限次，用于解释"套餐里到底有什么"） */
  const comboCodes = [
    ...new Set(
      kept
        .slice(0, 3)
        .flatMap((c) => c.lines.filter((l) => l.isCombo === true).map((l) => l.code)),
    ),
  ].slice(0, detailConfirmLimit);
  for (const code of comboCodes) {
    const detail = await source.fetchMealDetail(context, code);
    if (detail) {
      const item = menu.get(code);
      if (item) {
        item.isCombo = detail.isCombo;
        item.comboDetection = "mcp-detail";
        item.comboComponentCodes = detail.componentCodes;
      }
    }
  }
  provenance.push({
    tool: "query-meal-detail",
    purpose: "确认候选中的套餐真实组成（用于解释，而非定价）",
    status: comboCodes.length > 0 ? "success" : "skipped",
    note: comboCodes.length > 0 ? `确认 ${comboCodes.length} 个套餐：${comboCodes.join("、")}` : "候选中无套餐商品",
    traceId: null,
  });

  // 风格化输出：每种风格一个，且彼此核心结构不同
  const diversified = pickDiverse(kept, menu, 6);
  const best = diversified.find((c) => c.pricing.status === "verified");
  const conclusion = buildConclusion({
    completeness: search.completeness,
    boundedReason: search.boundedReason,
    evaluatedCount: search.evaluatedCount,
    verifiedCount,
    failedPriceCount,
    best,
    keptCount: kept.length,
    postRejected,
    requirement,
    fillCost: minFillCost(menuItems, requirement),
    namedNames: namedProducts.map((m) => m.name),
    relaxationNote,
  });

  return {
    context,
    store,
    requirement,
    candidates: diversified,
    rejectedCount: search.rejectedCount,
    completeness: search.completeness,
    boundedReason: search.boundedReason,
    evaluatedCount: search.evaluatedCount,
    verifiedCount,
    failedPriceCount,
    postVerificationRejected: postRejected,
    conclusion,
    provenance,
    generatedAt: new Date().toISOString(),
  };
}

function buildCandidate(
  lines: Array<{ code: string; quantity: number }>,
  menu: Map<string, MenuItem>,
  requirement: Requirement,
  score: ReturnType<typeof scoreCandidate>,
  est: ReturnType<typeof estimateLines>,
  nutri: ReturnType<typeof aggregateNutrition>,
  pricing: Candidate["pricing"],
  couponAvailable: boolean,
): Candidate {
  const cl = toLines(lines, menu);
  const rep = evaluateConstraints({
    lines,
    requirement,
    menu,
    effectiveCents: pricing.breakdown.payableCents ?? est.totalCents,
    effectiveSource: pricing.status === "verified" ? "verified" : "estimated",
    nutrition: nutri,
    couponState: pricing.couponState,
    couponAvailable,
  });
  const satiety = computeSatiety(
    { lines, menu },
    requirement.people,
    nutri.status === "available" ? nutri.energyKcal : null,
  );
  return {
    fingerprint: fingerprintOf(lines),
    lines: cl,
    itemCount: itemCountOf(lines),
    estimate: est,
    pricing,
    score,
    constraints: rep,
    nutrition: nutri,
    satiety,
  };
}

/**
 * 「让 N 个人吃饱」的最低成本估算。
 * 用菜单里最便宜的主食（必要时加最便宜的饮料）× 人数推算。
 * 明确标注为本地估算 —— 它只用于回答「预算够不够」，绝不充当官方核价结果。
 */
function minFillCost(
  menuItems: MenuItem[],
  requirement: Requirement,
): { cents: number | null; detail: string } {
  const people = Math.max(1, requirement.people);
  const usable = menuItems.filter(
    (m) => m.availability === "available" && m.currentPriceCents !== null,
  );
  const inSlot = (m: MenuItem, slots: CategorySlot[]): boolean => {
    const s = slotSatietyOf(m.category);
    return s !== null && slots.includes(s.slot);
  };
  const byPrice = (a: MenuItem, b: MenuItem) =>
    (a.currentPriceCents ?? 0) - (b.currentPriceCents ?? 0);

  const mains = usable.filter((m) => inSlot(m, MAIN_SLOTS)).sort(byPrice);
  const cheapestMain = mains[0];
  if (!cheapestMain) return { cents: null, detail: "菜单中没有可识别的主食类商品，无法估算" };

  const parts: string[] = [`${cheapestMain.name} ×${people}`];
  let total = (cheapestMain.currentPriceCents ?? 0) * people;

  // 若用户要求饮料，按人数配齐最便宜的饮料
  if (requirement.requiredCategories.some((r) => r.category === "drink")) {
    const drinks = usable.filter((m) => inSlot(m, ["drink"])).sort(byPrice);
    if (drinks[0]) {
      parts.push(`${drinks[0].name} ×${people}`);
      total += (drinks[0].currentPriceCents ?? 0) * people;
    }
  }
  return { cents: total, detail: parts.join(" + ") };
}

/**
 * 组合的「核心结构」指纹：忽略饮料。
 *
 * 只换饮料不算换方案 —— 这正是"5 个候选其实是 1 个方案 + 5 种饮料"的根源。
 * 去重和风格分组都以这个指纹为准。
 */
function coreKeyOf(lines: Array<{ code: string; quantity: number }>, menu: Map<string, MenuItem>): string {
  return lines
    .filter((l) => {
      const s = slotSatietyOf(menu.get(l.code)?.category ?? "");
      return !(s && s.slot === "drink");
    })
    .map((l) => `${l.code}x${l.quantity}`)
    .sort()
    .join("|");
}

/**
 * 风格化挑选：每种风格给一个，且彼此核心结构不同。
 * 单纯按综合分排序只会输出最优点的邻居，看起来像 5 个方案其实是一个。
 */
function pickDiverse(
  kept: Candidate[],
  menu: Map<string, MenuItem>,
  limit: number,
): Candidate[] {
  const strategies: Array<{ label: string; key: (c: Candidate) => number }> = [
    { label: "最省", key: (c) => -(c.pricing.breakdown.payableCents ?? Number.MAX_SAFE_INTEGER) },
    { label: "最均衡", key: (c) => c.score.total },
    { label: "最丰富", key: (c) => c.satiety.totalUnits * 100 + c.score.total / 100 },
    {
      label: "最多样",
      key: (c) => new Set(c.lines.map((l) => menu.get(l.code)?.category)).size * 100 + c.score.total / 100,
    },
  ];

  const out: Candidate[] = [];
  const usedCore = new Set<string>();
  const usedFp = new Set<string>();

  for (const s of strategies) {
    if (out.length >= limit) break;
    const ranked = [...kept].sort((a, b) => s.key(b) - s.key(a));
    for (const c of ranked) {
      if (usedFp.has(c.fingerprint)) continue;
      const core = coreKeyOf(c.lines, menu);
      if (usedCore.has(core)) continue;
      usedCore.add(core);
      usedFp.add(c.fingerprint);
      out.push({ ...c, styleLabel: s.label });
      break;
    }
  }

  // 风格不足时按综合分补齐，但仍要求核心结构不同
  for (const c of kept) {
    if (out.length >= limit) break;
    if (usedFp.has(c.fingerprint)) continue;
    const core = coreKeyOf(c.lines, menu);
    if (usedCore.has(core)) continue;
    usedCore.add(core);
    usedFp.add(c.fingerprint);
    out.push({ ...c, styleLabel: "备选" });
  }
  return out;
}

function pickCoupon(coupons: Coupon[], lines: CandidateLine[]): Coupon | null {
  const codes = new Set(lines.map((l) => l.code));
  const applicable = coupons.find(
    (c) => c.applicableProductCodes.length === 0 || c.applicableProductCodes.some((p) => codes.has(p)),
  );
  return applicable ?? null;
}

function buildConclusion(a: {
  completeness: "exhaustive" | "bounded";
  boundedReason: string | null;
  evaluatedCount: number;
  verifiedCount: number;
  failedPriceCount: number;
  best: Candidate | undefined;
  keptCount: number;
  postRejected: OptimizationReport["postVerificationRejected"];
  requirement: Requirement;
  fillCost: { cents: number | null; detail: string };
  namedNames: string[];
  relaxationNote: string | null;
}): string {
  const parts: string[] = [];
  if (a.relaxationNote) parts.push(a.relaxationNote);
  if (a.namedNames.length > 0) parts.push(`已优先匹配你点名的：${a.namedNames.join("、")}`);
  parts.push(`共评估 ${a.evaluatedCount} 个组合，${a.verifiedCount} 个完成官方核价`);
  if (a.failedPriceCount > 0) parts.push(`${a.failedPriceCount} 个核价失败`);

  const fillNote =
    a.fillCost.cents === null
      ? null
      : `按菜单最低价估算，让 ${a.requirement.people} 人吃饱至少需要 ${formatCents(a.fillCost.cents)}（${a.fillCost.detail}，本地估算非官方核价）`;

  if (!a.best) {
    if (a.postRejected.length > 0) {
      const reason = a.postRejected[0].reasons[0] ?? "未知原因";
      parts.push(
        `${a.postRejected.length} 个候选在核价后被硬约束淘汰（例如：${reason}），因此没有可推荐的方案`,
      );
    } else {
      parts.push("没有候选通过官方核价，无法给出价格可信的方案");
    }
    if (fillNote) parts.push(fillNote);
    if (a.requirement.budgetCents !== null && a.fillCost.cents !== null && a.fillCost.cents > a.requirement.budgetCents) {
      parts.push(
        `预算 ${formatCents(a.requirement.budgetCents)} 不足以让 ${a.requirement.people} 人吃饱，建议把预算提高到 ${formatCents(a.fillCost.cents)} 以上或减少人数`,
      );
    }
    return parts.join("；");
  }
  const scope = a.completeness === "exhaustive"
    ? "已穷举全部可行组合，当前结果为全局最优"
    : `搜索受限（${a.boundedReason ?? "命中搜索上限"}），当前结果仅为「已检查候选中的最优方案」`;
  const price = formatCents(a.best.pricing.breakdown.payableCents);
  const est = a.best.estimate.totalCents;
  const gap = est !== null && a.best.pricing.breakdown.payableCents !== null
    ? `，与本地估算 ${formatCents(est)} 相差 ${formatCents(a.best.pricing.breakdown.payableCents - est)}`
    : "";
  const sat = describeSatiety(a.best.satiety, a.requirement.people);
  parts.push(`${scope}；最优方案官方核价 ${price}${gap}；份量：${sat}`);
  return parts.join("；");
}
