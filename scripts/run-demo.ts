/**
 * 三个演示案例（无需启动 Web 服务）。
 *   npm run demo
 * 有 Token 时走官方 MCP 真实数据；无 Token 时自动使用模拟数据（会明确标注）。
 */
import { ensureEnvLoaded, loadConfig } from "../src/config";
import { createDataSource } from "../src/mcp";
import { MockDataSource } from "../src/mcp/mock";
import { parseRequirement } from "../src/domain/requirement";
import { optimize } from "../src/optimizer/optimizer";
import { auditOrder } from "../src/audit/audit";
import { OrderGuard } from "../src/order/guard";
import { formatCents } from "../src/domain/money";
import type { PriceContext } from "../src/domain/types";

ensureEnvLoaded();

function hr(t: string) {
  console.log(`\n${"─".repeat(64)}\n ${t}\n${"─".repeat(64)}`);
}
const m = (c: number | null) => (c === null ? "未提供" : formatCents(c));

async function main() {
  const cfg = loadConfig();
  const bundle = await createDataSource(cfg);
  const ds = bundle.source;
  console.log(`数据源：${bundle.mode} —— ${bundle.note}`);

  const stores = await ds.findStores({ city: "上海", keyword: "人民广场", beType: 1 });
  const store = stores[0];
  if (!store) throw new Error("未找到门店");
  const ctx: PriceContext = {
    storeCode: store.storeCode,
    orderType: 1,
    beType: 1,
    beCode: null,
    reservationDate: null,
  };
  console.log(`门店：${store.storeName}（${store.storeCode}）`);

  /* ============ 案例 1：预算 + 必选类别的套餐优化 ============ */
  hr("案例 1 · 套餐优化：2 人 / 预算 ¥60 / 必选汉堡+饮料");
  const parsed = parseRequirement("2 个人，预算 60 元，要汉堡和饮料，尽量用券");
  console.log("需求解析：");
  for (const n of parsed.notes) console.log("  ·", n);

  const report = await optimize({
    source: ds,
    context: ctx,
    requirement: parsed.requirement,
    store,
    verifyLimit: 5,
  });
  console.log("\n结论：", report.conclusion);
  console.log(
    `搜索：评估 ${report.evaluatedCount} 个组合 / 核价成功 ${report.verifiedCount} / 失败 ${report.failedPriceCount} / 穷举=${report.completeness === "exhaustive"}`,
  );
  const ms = report.requirement.mealStructure;
  if (ms) {
    console.log(
      `\n用餐结构：主食 ${ms.main} / 饮料 ${ms.drink} / 小食 ${ms.side} / 甜品 ${ms.dessert}${ms.derived ? "（按人数推算，可调）" : "（按你的说法）"}`,
    );
  }
  for (const [i, c] of report.candidates.slice(0, 4).entries()) {
    console.log(
      `\n  #${i + 1} [${c.styleLabel ?? "备选"}] ${c.lines.map((l) => `${l.name}×${l.quantity}`).join(" + ")}`,
    );
    console.log(`     本地估算 ${m(c.estimate.totalCents)}  →  官方核价 ${m(c.pricing.breakdown.payableCents)} [${c.pricing.status}]`);
    console.log(
      `     份量 ${c.satiety.totalUnits} 人份（需 ${c.satiety.requiredUnits}）| 评分 ${c.score.total} | 营养 ${c.nutrition.status} | 硬约束 ${c.constraints.hardAllSatisfied ? "全部满足" : "不满足"}`,
    );
    if (i === 0) for (const e of c.score.explanation) console.log(`       - ${e}`);
  }
  if (report.postVerificationRejected.length) {
    console.log(`\n  核价后被淘汰 ${report.postVerificationRejected.length} 个，例：${report.postVerificationRejected[0].reasons[0]}`);
  }

  /* ============ 案例 2：点餐审计 ============ */
  hr("案例 2 · 点餐审计：核验推荐方案并比较替代方案");
  const best = report.candidates[0];
  if (!best) {
    console.log("没有可审计的方案");
  } else {
    const audit = await auditOrder({
      source: ds,
      context: ctx,
      lines: best.lines.map((l) => ({ productCode: l.code, quantity: l.quantity })),
      alternativeLimit: 3,
    });
    console.log("原方案：", best.lines.map((l) => `${l.name}×${l.quantity}`).join(" + "));
    console.log(`  官方核价应付 ${m(audit.original.pricing.breakdown.payableCents)} [${audit.original.pricing.status}]`);
    console.log(`  估算与核价核对：${audit.original.consistency.note}`);
    console.log(`  可比性：${audit.comparability.comparable ? "同条件可比" : audit.comparability.reason}`);
    console.log("\n差异对比：");
    for (const d of audit.differences) {
      console.log(`  ${d.field.padEnd(12, "　")} ${String(d.originalValue).padEnd(22)} → ${String(d.alternativeValue).padEnd(22)} 差额 ${d.delta ?? "—"}`);
    }
    console.log("\n结论：", audit.conclusion);
  }

  /* ============ 案例 3：核价失败展示 + 交易保护 ============ */
  hr("案例 3 · 核价失败展示与交易安全保护");
  const failing = new MockDataSource({ priceFailure: "always", couponApplicableCodes: [] });
  const failReport = await optimize({
    source: failing,
    context: { ...ctx, storeCode: "SIM-STORE-0001" },
    requirement: parsed.requirement,
    verifyLimit: 2,
  });
  console.log("（故障注入：模拟核价失败）");
  for (const c of failReport.candidates) {
    console.log(`  ${c.lines.map((l) => l.name).join(" + ")} → [${c.pricing.status}] 原因：${c.pricing.failureReason}`);
    console.log(`  应付金额显示为：${m(c.pricing.breakdown.payableCents)}（不会伪装成已核价）`);
  }
  console.log("结论：", failReport.conclusion);

  const guard = new OrderGuard({ enableRealOrder: cfg.enableRealOrder });
  const decision = guard.requestCreateOrder(
    {
      context: ctx,
      takeWayCode: "eat-in",
      items: [{ code: best?.lines[0]?.code ?? "1100", quantity: 1 }],
      verifiedPayableCents: best?.pricing.breakdown.payableCents ?? 2550,
      verifiedAt: new Date().toISOString(),
      priceTraceId: null,
    },
    { storeConfirmed: true, takeWayConfirmed: true, itemsConfirmed: true, priceConfirmed: true },
  );
  console.log("\n交易保护（即使全部确认）：");
  console.log(`  允许下单：${decision.allowed} | code=${decision.code}`);
  console.log(`  原因：${decision.reason}`);
  console.log("\n  创建订单 ≠ 支付成功；结果不明时先用 query-order 查询状态，不盲目重试。");

  await ds.close();
  await failing.close();
}

main().catch((e) => {
  console.error("演示失败：", e);
  process.exit(1);
});
