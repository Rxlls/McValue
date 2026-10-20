/** 端到端手工验证脚本（需先启动服务）。用法: npx tsx scripts/e2e-check.ts */
const BASE = process.env.BASE ?? "http://127.0.0.1:5173";

async function post(p: string, b: unknown) {
  const r = await fetch(BASE + p, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(b),
  });
  return (await r.json()) as any;
}
async function get(p: string) {
  const r = await fetch(BASE + p);
  return (await r.json()) as any;
}

async function main() {
  const health = await get("/api/health");
  console.log("== health ==", health.mode, "|", health.note, "| 下单开启:", health.realOrderEnabled);

  const stores = await post("/api/stores", { city: "上海", keyword: "人民广场", beType: 1 });
  const store = (stores.stores ?? [])[0];
  console.log("== store ==", store?.storeCode, store?.storeName);

  /* 演示 1：预算 + 必选类别 */
  const d1 = await post("/api/optimize", {
    storeCode: store.storeCode, storeName: store.storeName, orderType: 1, beType: 1,
    text: "2 个人，预算 60 元，要汉堡和饮料，尽量用券",
    overrides: { people: 2, requiredCategories: ["burger", "drink"] },
  });
  console.log("\n== 演示1 ==");
  console.log("结论:", d1.report?.conclusion ?? d1.error);
  (d1.report?.candidates ?? []).slice(0, 3).forEach((c: any, i: number) => {
    console.log(
      ` #${i + 1}`,
      c.lines.map((l: any) => `${l.name}x${l.quantity}`).join(" + "),
      "| 估算", (c.estimate.totalCents / 100).toFixed(2),
      "| 核价", c.pricing.breakdown.payableCents === null ? "—" : (c.pricing.breakdown.payableCents / 100).toFixed(2),
      c.pricing.status,
      "| 营养", c.nutrition.status,
    );
  });
  if (d1.report?.postVerificationRejected?.length) {
    console.log(" 核价后淘汰:", d1.report.postVerificationRejected[0].reasons.join("；"));
  }

  /* 演示 2：审计一份既有清单 */
  const codes = (d1.report?.candidates?.[0]?.lines ?? []).map((l: any) => `${l.code}*${l.quantity}`).join(",");
  if (codes) {
    const d2 = await post("/api/audit", {
      storeCode: store.storeCode, orderType: 1, beType: 1,
      lines: codes.split(",").map((s: string) => {
        const [productCode, qty] = s.split("*");
        return { productCode, quantity: Number(qty || 1) };
      }),
    });
    console.log("\n== 演示2·审计 ==");
    console.log("可比:", d2.report?.comparability?.comparable, "|", d2.report?.comparability?.reason);
    console.log("结论:", d2.report?.conclusion);
    console.log("原方案应付:", d2.report?.original?.pricing?.breakdown?.payableCents, d2.report?.original?.pricing?.status);
    (d2.report?.alternatives ?? []).forEach((a: any) =>
      console.log(" 替代:", a.label, a.pricing.breakdown.payableCents, a.pricing.status),
    );
    (d2.report?.differences ?? []).forEach((x: any) =>
      console.log("  差异:", x.field, "|", x.originalValue, "->", x.alternativeValue, "| 差额", x.delta ?? "—"),
    );
  }

  /* 演示 3：交易保护（下单默认关闭） */
  const d3 = await post("/api/order/request", {
    draft: {
      storeCode: store.storeCode, orderType: 1, beType: 1, takeWayCode: "eat-in",
      items: [{ code: "1100", quantity: 1 }],
      verifiedPayableCents: 2550, verifiedAt: new Date().toISOString(),
    },
    confirmation: { storeConfirmed: true, takeWayConfirmed: true, itemsConfirmed: true, priceConfirmed: true },
  });
  console.log("\n== 演示3·交易保护 ==");
  console.log("允许下单:", d3.decision?.allowed, "| code:", d3.decision?.code);
  console.log("原因:", d3.decision?.reason);
}

main().catch((e) => {
  console.error("e2e 失败:", e);
  process.exit(1);
});
