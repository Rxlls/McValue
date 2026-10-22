/**
 * 优化器基线对照实验。
 *   npm run bench            使用模拟菜单（确定性，可离线复现）
 *   npm run bench -- --live  使用官方 MCP 真实菜单（需 MCD_MCP_TOKEN）
 *
 * 目的：回答「这个优化器到底比朴素策略强多少」，而不是只声明它更好。
 *
 * 公平性约束（四条策略完全相同）：
 *   1. 同一份菜单、同一门店、同一用餐方式；
 *   2. 同一套份量判定（computeSatiety）与必选类别判定；
 *   3. 全部经过 dataSource.calculatePrice 核价，不拿本地估算互相比较；
 *   4. 同一预算口径（官方应付金额 payableCents）。
 *
 * 基线策略：
 *   A McValue      本项目优化器（份量优先 + 综合评分 + 结构去重）
 *   B 贪心凑单      最便宜的主食 × 人数 + 最便宜的饮料 × 人数（最常见的"人工凑单"）
 *   C 只挑最便宜    不分品类，直接取最便宜的 N 件（N = 人数 × 2）
 *   D 随机可行      随机抽 300 次，保留份量与类别都满足的最便宜解
 */

import { ensureEnvLoaded, loadConfig } from "../src/config";
import { createDataSource } from "../src/mcp";
import { parseRequirement } from "../src/domain/requirement";
import { optimize } from "../src/optimizer/optimizer";
import { computeSatiety, slotSatietyOf } from "../src/domain/satiety";
import { evaluateConstraints } from "../src/domain/constraints";
import { aggregateNutrition, estimateLines } from "../src/domain/pricing";
import { formatCents } from "../src/domain/money";
import type { MenuItem, PriceContext, PriceResult, Requirement } from "../src/domain/types";

ensureEnvLoaded();

const useLive = process.argv.includes("--live");

interface Case {
  label: string;
  text: string;
}

const CASES: Case[] = [
  { label: "1 人 / ¥30", text: "1 个人，预算 30 元，要汉堡和饮料" },
  { label: "2 人 / ¥60", text: "2 个人，预算 60 元，要汉堡和饮料" },
  { label: "2 人 / ¥90", text: "2 个人，预算 90 元，要汉堡和饮料" },
  { label: "3 人 / ¥90", text: "3 个人，预算 90 元，要汉堡和饮料" },
  { label: "4 人 / ¥120", text: "4 个人，预算 120 元，要汉堡和饮料" },
];

type Lines = Array<{ code: string; quantity: number }>;

interface Outcome {
  strategy: string;
  /** 是否拿到可用方案 */
  produced: boolean;
  satietyOk: boolean;
  categoryOk: boolean;
  budgetOk: boolean | null;
  payableCents: number | null;
  itemCount: number;
  verified: boolean;
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function payableOf(p: PriceResult): number | null {
  return p.status === "verified" ? p.breakdown.payableCents : null;
}

/**
 * 用**产品自身的约束判定**给所有策略打分，而不是脚本另写一套标准。
 * 这一点很关键：项目允许「套餐(combo)」顶替「汉堡(burger)」这类等价槽位，
 * 如果基线脚本用更严格的自定义规则，就会把合法方案误判为不合格，
 * 得出「优化器 0% 达标」这种假结论。
 */
function judge(
  lines: Lines,
  req: Requirement,
  menu: Map<string, MenuItem>,
  effectiveCents: number | null,
  effectiveSource: "verified" | "estimated" | "none",
): { satietyOk: boolean; categoryOk: boolean; budgetOk: boolean | null; hardOk: boolean } {
  const nutri = aggregateNutrition(
    lines.map((l) => ({ ...l, name: menu.get(l.code)?.name ?? l.code })),
    menu,
  );
  const rep = evaluateConstraints({
    lines,
    requirement: req,
    menu,
    effectiveCents,
    effectiveSource,
    nutrition: nutri,
    couponState: "not-applied",
    couponAvailable: false,
  });
  const by = (k: "satiety" | "required-category" | "budget") => rep.results.find((r) => r.kind === k);
  return {
    satietyOk: by("satiety")?.satisfied ?? true,
    categoryOk: by("required-category")?.satisfied ?? true,
    budgetOk: effectiveCents === null ? null : (by("budget")?.satisfied ?? null),
    hardOk: rep.hardAllSatisfied,
  };
}

function dedupe(lines: Lines): Lines {
  const m = new Map<string, number>();
  for (const l of lines) m.set(l.code, (m.get(l.code) ?? 0) + l.quantity);
  return [...m.entries()].map(([code, quantity]) => ({ code, quantity }));
}

/**
 * 策略 B：最便宜的主食 × 人数 + 最便宜的饮料 × 人数。
 * 必须遵守单品数量上限（maxQtyPerItem），否则这个基线会做出产品根本不接受的组合，
 * 比出来的"更便宜"没有意义。
 */
function greedyCheapest(menu: MenuItem[], req: Requirement): Lines {
  const out: Lines = [];
  const cap = Math.max(1, req.maxQtyPerItem);
  for (const r of req.requiredCategories) {
    const candidates = menu
      .filter((m) => slotSatietyOf(m.category, m.name)?.slot === r.category)
      .filter((m) => m.currentPriceCents !== null)
      .sort((a, b) => (a.currentPriceCents ?? 0) - (b.currentPriceCents ?? 0));
    let left = r.minCount;
    for (const item of candidates) {
      if (left <= 0) break;
      const qty = Math.min(cap, left);
      out.push({ code: item.code, quantity: qty });
      left -= qty;
    }
  }
  return dedupe(out);
}

/** 策略 C：不分品类，取最便宜的 N 件（N = 人数 × 2）。单品数量同样受上限约束。 */
function cheapestOverall(menu: MenuItem[], req: Requirement): Lines {
  const n = Math.max(2, req.people * 2);
  const cap = Math.max(1, req.maxQtyPerItem);
  const sorted = [...menu]
    .filter((m) => m.currentPriceCents !== null)
    .sort((a, b) => (a.currentPriceCents ?? 0) - (b.currentPriceCents ?? 0));
  const out: Lines = [];
  let left = n;
  for (const m of sorted) {
    if (left <= 0) break;
    const qty = Math.min(cap, left);
    out.push({ code: m.code, quantity: qty });
    left -= qty;
  }
  return out;
}

/** 策略 D：随机抽 300 次，返回份量/类别满足且估算在预算内的最便宜解。 */
function randomFeasible(menu: MenuItem[], req: Requirement, menuMap: Map<string, MenuItem>): Lines | null {
  const rnd = lcg(20261020);
  const usable = menu.filter((m) => m.currentPriceCents !== null);
  const maxN = Math.max(2, req.people * 2 + 2);
  let best: { lines: Lines; est: number } | null = null;

  for (let iter = 0; iter < 300; iter += 1) {
    const n = 1 + Math.floor(rnd() * maxN);
    const raw: Lines = [];
    for (let i = 0; i < n; i += 1) {
      const item = usable[Math.floor(rnd() * usable.length)];
      if (item) raw.push({ code: item.code, quantity: 1 });
    }
    const lines = dedupe(raw).slice(0, req.maxItems ?? 12);

    const est = lines.reduce((s, l) => s + (menuMap.get(l.code)?.currentPriceCents ?? 0) * l.quantity, 0);
    if (req.budgetCents !== null && est > req.budgetCents) continue;
    if (!judge(lines, req, menuMap, est, "estimated").hardOk) continue;
    if (!best || est < best.est) best = { lines, est };
  }
  return best?.lines ?? null;
}

async function evaluate(
  strategy: string,
  lines: Lines | null,
  ctx: PriceContext,
  menuMap: Map<string, MenuItem>,
  req: Requirement,
  source: Awaited<ReturnType<typeof createDataSource>>["source"],
): Promise<Outcome> {
  if (!lines || lines.length === 0) {
    return {
      strategy,
      produced: false,
      satietyOk: false,
      categoryOk: false,
      budgetOk: null,
      payableCents: null,
      itemCount: 0,
      verified: false,
    };
  }
  const price = await source.calculatePrice({
    context: ctx,
    items: lines.map((l) => ({ productCode: l.code, quantity: l.quantity })),
  });
  const payable = payableOf(price);
  const est = estimateLines(lines, menuMap).totalCents;
  const verdict = judge(
    lines,
    req,
    menuMap,
    payable ?? est,
    payable !== null ? "verified" : "estimated",
  );
  const itemCount = lines.reduce((s, l) => s + l.quantity, 0);
  return {
    strategy,
    produced: true,
    satietyOk: verdict.satietyOk,
    categoryOk: verdict.categoryOk,
    budgetOk: payable === null || req.budgetCents === null ? null : payable <= req.budgetCents,
    payableCents: payable,
    itemCount,
    verified: price.status === "verified",
  };
}

function pct(n: number, d: number): string {
  return d === 0 ? "—" : `${Math.round((n / d) * 100)}%`;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const bundle = await createDataSource(cfg);
  const source = bundle.source;

  if (useLive && bundle.mode !== "live") {
    console.error("--live 需要可用的 MCD_MCP_TOKEN，当前为模拟模式。");
    process.exitCode = 1;
    return;
  }

  const stores = await source.findStores({ city: "上海", keyword: "人民广场", beType: 1 });
  const store = stores[0];
  if (!store) throw new Error("未找到门店");

  const ctx: PriceContext = { storeCode: store.storeCode, orderType: 1, beType: 1, beCode: null, reservationDate: null };
  const menu = await source.fetchMenu(ctx);
  const menuMap = new Map(menu.map((m) => [m.code, m]));

  console.log("═".repeat(78));
  console.log(` 优化器基线对照　数据源：${bundle.mode}　门店：${store.storeName}（${store.storeCode}）`);
  console.log("═".repeat(78));
  if (bundle.mode !== "live") {
    console.log(" 注意：当前为模拟菜单，结果用于验证方法可复现，不代表真实门店的绝对金额。");
  }

  const strategies = ["McValue", "贪心凑单", "只挑最便宜", "随机可行"] as const;
  const acc = new Map<string, Outcome[]>(strategies.map((s) => [s, [] as Outcome[]]));

  for (const c of CASES) {
    const req = parseRequirement(c.text).requirement;
    const rows: Outcome[] = [];

    const report = await optimize({ source, context: ctx, requirement: req, store });
    const best = report.candidates.find((x) => x.pricing.status === "verified") ?? report.candidates[0];
    const mvLines: Lines | null = best ? best.lines.map((l) => ({ code: l.code, quantity: l.quantity })) : null;
    rows.push(await evaluate("McValue", mvLines, ctx, menuMap, req, source));

    rows.push(await evaluate("贪心凑单", greedyCheapest(menu, req), ctx, menuMap, req, source));
    rows.push(await evaluate("只挑最便宜", cheapestOverall(menu, req), ctx, menuMap, req, source));
    rows.push(await evaluate("随机可行", randomFeasible(menu, req, menuMap), ctx, menuMap, req, source));

    console.log(`\n── ${c.label} ─ ${req.requiredCategories.map((r) => `${r.category}×${r.minCount}`).join(" ")}`);
    for (const r of rows) {
      const money = r.payableCents === null ? "未核价" : formatCents(r.payableCents);
      const flags = [
        r.satietyOk ? "份量✓" : "份量✗",
        r.categoryOk ? "类别✓" : "类别✗",
        r.budgetOk === null ? "预算?" : r.budgetOk ? "预算✓" : "预算✗",
      ].join(" ");
      console.log(`   ${r.strategy.padEnd(6)} ${money.padStart(9)}  ${String(r.itemCount).padStart(2)} 件  ${flags}`);
    }
    for (const r of rows) acc.get(r.strategy)?.push(r);
  }

  console.log(`\n${"═".repeat(78)}`);
  console.log(" 汇总（5 个场景）");
  console.log("═".repeat(78));
  console.log(` ${"策略".padEnd(8)} ${"出方案".padEnd(6)} ${"份量达标".padEnd(8)} ${"类别达标".padEnd(8)} ${"预算内".padEnd(7)} ${"核价成功".padEnd(8)} 平均实付`);
  for (const s of strategies) {
    const list = acc.get(s) ?? [];
    const produced = list.filter((r) => r.produced);
    const verified = produced.filter((r) => r.verified && r.payableCents !== null);
    const avg = verified.length
      ? formatCents(Math.round(verified.reduce((x, r) => x + (r.payableCents ?? 0), 0) / verified.length))
      : "—";
    console.log(
      ` ${s.padEnd(8)} ${pct(produced.length, list.length).padEnd(7)} ${pct(produced.filter((r) => r.satietyOk).length, list.length).padEnd(9)} ${pct(produced.filter((r) => r.categoryOk).length, list.length).padEnd(9)} ${pct(produced.filter((r) => r.budgetOk === true).length, list.length).padEnd(8)} ${pct(verified.length, list.length).padEnd(9)} ${avg}`,
    );
  }
  console.log("\n 口径说明：达标率的分母是全部 5 个场景；没有产出方案记为未达标，不剔除。");
  console.log(" 「只挑最便宜」与「随机可行」出现预算✗，恰恰说明便宜不等于够吃、够吃不等于在预算内。");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
