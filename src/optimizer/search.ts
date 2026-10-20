/**
 * 有界组合搜索（回溯 / DFS）。
 *
 * 关键约束：
 * 1. 组合以「商品索引非递减」的方式生成，天然避免排列重复（A+B 与 B+A 只生成一次）。
 * 2. 预算与件数上界用于剪枝（价格为正，超预算即可停止该分支）。
 * 3. 搜索受 maxNodes / maxAccepted / poolSize 三重上限约束；一旦触发任一上限，
 *    结果就只能称为「已检查候选中的最优方案」，completeness 记为 bounded。
 */

import type { Cents } from "../domain/money";
import type { MenuItem, Requirement, SearchCompleteness } from "../domain/types";
import { bindSlotWithEquivalents } from "../domain/requirement";
import type { SimpleLine } from "../domain/lines";
import { fingerprintOf } from "../domain/lines";

export interface PoolItem {
  code: string;
  name: string;
  category: string;
  priceCents: Cents;
  relevance: number;
  isCombo: boolean;
}

export interface SearchConfig {
  /** 候选池大小上限 */
  poolSize: number;
  /** 整单件数上限 */
  maxItems: number;
  /** 单个商品数量上限 */
  maxQtyPerItem: number;
  /** 搜索节点上限 */
  maxNodes: number;
  /** 最多保留多少个通过硬约束的组合 */
  maxAccepted: number;
  /** 每个必选类别至少保留多少件商品进入候选池 */
  minPerRequiredCategory: number;
}

export const DEFAULT_SEARCH_CONFIG: SearchConfig = {
  // 池子需要容纳「必选分类 + 等价分类」的代表，同时留出位置给便宜主食，
  // 否则池子会被高价四件套占满，造成预算内的假无解
  poolSize: 32,
  maxItems: 8,
  maxQtyPerItem: 3,
  maxNodes: 150000,
  maxAccepted: 240,
  minPerRequiredCategory: 2,
};

/** 参与搜索的最低资格：可售、有菜单价、不在排除列表、不命中忌口。 */
function eligible(item: MenuItem, requirement: Requirement): boolean {
  if (item.availability !== "available") return false;
  if (item.currentPriceCents === null) return false;
  if (requirement.excludeCodes.includes(item.code)) return false;
  if (requirement.avoidKeywords.some((k) => item.name.includes(k))) return false;
  return true;
}

function relevanceOf(
  item: MenuItem,
  requirement: Requirement,
  requiredCats: Set<string>,
  preferredCodes: Set<string>,
): number {
  let score = 0;
  if (requiredCats.has(item.category)) score += 60;
  // 用户点名要的商品（"要两杯可乐"里的可乐）：强偏好，但不设成硬约束免得门店没货就无解
  if (preferredCodes.has(item.code)) score += 90;
  for (const k of requirement.tasteKeywords) {
    if (item.name.includes(k) || item.tags.includes(k) || item.category.includes(k)) score += 12;
  }
  if (requirement.preferCombo && item.isCombo === true) score += 10;
  if (item.discountType) score += 5;
  // 轻微偏好价格适中的商品，避免池子被最贵/最便宜的商品占满
  score += Math.max(0, 10 - Math.floor((item.currentPriceCents ?? 0) / 500));
  return score;
}

export function buildPool(
  menu: MenuItem[],
  requirement: Requirement,
  config: SearchConfig = DEFAULT_SEARCH_CONFIG,
  preferredCodes: Set<string> = new Set(),
): PoolItem[] {
  const requiredCats = new Set<string>();
  const allCategories = [...new Set(menu.map((m) => m.category))];
  for (const req of requirement.requiredCategories) {
    // 与硬约束校验保持同一口径：含汉堡的套餐也视作能满足「要汉堡」
    for (const c of bindSlotWithEquivalents(req.category, allCategories)) requiredCats.add(c);
  }

  const pool: PoolItem[] = menu
    .filter((m) => eligible(m, requirement))
    .map((m) => ({
      code: m.code,
      name: m.name,
      category: m.category,
      priceCents: m.currentPriceCents as Cents,
      relevance: relevanceOf(m, requirement, requiredCats, preferredCodes),
      isCombo: m.isCombo === true,
    }));

  // 必选类别必须有足够代表进入候选池，否则该类硬约束永远无法满足
  const picked: PoolItem[] = [];
  const pickedCodes = new Set<string>();
  for (const cat of requiredCats) {
    const inCat = pool.filter((p) => p.category === cat).sort((a, b) => b.relevance - a.relevance);
    for (const item of inCat.slice(0, config.minPerRequiredCategory)) {
      if (pickedCodes.has(item.code)) continue;
      picked.push(item);
      pickedCodes.add(item.code);
    }
  }
  const rest = pool
    .filter((p) => !pickedCodes.has(p.code))
    .sort((a, b) => b.relevance - a.relevance || a.priceCents - b.priceCents);
  for (const item of rest) {
    if (picked.length >= config.poolSize) break;
    picked.push(item);
    pickedCodes.add(item.code);
  }
  return picked;
}

export interface SearchOutcome {
  combos: SimpleLine[][];
  /** 实际枚举并做硬约束判定的组合数 */
  evaluatedCount: number;
  /** 因硬约束被淘汰的组合数 */
  rejectedCount: number;
  completeness: SearchCompleteness;
  /** 未穷举的原因（穷举时为 null） */
  boundedReason: string | null;
  /** 候选池规模 */
  poolSize: number;
}

/**
 * 回溯搜索。accept 用于判定组合是否满足全部硬约束（由调用方基于估算价判定）。
 */
export function searchCombinations(
  pool: PoolItem[],
  requirement: Requirement,
  config: SearchConfig = DEFAULT_SEARCH_CONFIG,
  accept: (lines: SimpleLine[]) => boolean,
): SearchOutcome {
  const budget = requirement.budgetCents;
  const maxItems = Math.min(requirement.maxItems ?? config.maxItems, config.maxItems);
  const maxQty = Math.min(requirement.maxQtyPerItem, config.maxQtyPerItem);
  const mustInclude = requirement.mustIncludeCodes;

  const combos: SimpleLine[][] = [];
  const seen = new Set<string>();
  let evaluated = 0;
  let rejected = 0;
  let nodes = 0;
  let boundedReason: string | null = null;

  const current: SimpleLine[] = [];

  const dfs = (startIdx: number, itemCount: number, cost: number): void => {
    if (boundedReason) return;
    nodes++;
    if (nodes > config.maxNodes) {
      boundedReason = `搜索节点数达到上限 ${config.maxNodes}`;
      return;
    }

    for (let i = startIdx; i < pool.length; i++) {
      const item = pool[i];
      for (let qty = 1; qty <= maxQty; qty++) {
        const nextCount = itemCount + qty;
        if (nextCount > maxItems) break;
        const nextCost = cost + item.priceCents * qty;
        if (budget !== null && nextCost > budget) break;

        current.push({ code: item.code, quantity: qty });
        const snap = current.map((c) => ({ ...c }));
        evaluated++;

        const fp = fingerprintOf(snap);
        if (!seen.has(fp)) {
          seen.add(fp);
          if (accept(snap)) {
            if (combos.length < config.maxAccepted) combos.push(snap.map((c) => ({ ...c })));
            else boundedReason = `通过硬约束的组合数达到上限 ${config.maxAccepted}（提前收敛）`;
          } else {
            rejected++;
          }
        }
        dfs(i + 1, nextCount, nextCost);
        current.pop();

        if (boundedReason) return;
      }
      if (boundedReason) return;
    }
  };

  // 必选商品强制作种子，保证 mustInclude 一定被探索
  if (mustInclude.length > 0) {
    const seeds = pool.filter((p) => mustInclude.includes(p.code));
    for (const s of seeds) {
      current.push({ code: s.code, quantity: 1 });
    }
    const baseCount = current.reduce((a, c) => a + c.quantity, 0);
    const baseCost = current.reduce((a, c) => a + (pool.find((p) => p.code === c.code)?.priceCents ?? 0) * c.quantity, 0);
    const startIdx = 0;
    if (baseCount > 0) {
      const snap = current.map((c) => ({ ...c }));
      evaluated++;
      const fp = fingerprintOf(snap);
      seen.add(fp);
          if (accept(snap)) {
            if (combos.length < config.maxAccepted) combos.push(snap);
            else boundedReason = `通过硬约束的组合数达到上限 ${config.maxAccepted}（提前收敛）`;
          } else rejected++;
      // 从种子之后继续扩展：这里简化为从 pool 起点扩展，靠 maxItems 约束规模
      dfs(startIdx, baseCount, baseCost);
      current.length = 0;
    } else {
      current.length = 0;
      dfs(0, 0, 0);
    }
  } else {
    dfs(0, 0, 0);
  }

  return {
    combos,
    evaluatedCount: evaluated,
    rejectedCount: rejected,
    completeness: boundedReason ? "bounded" : "exhaustive",
    boundedReason,
    poolSize: pool.length,
  };
}
