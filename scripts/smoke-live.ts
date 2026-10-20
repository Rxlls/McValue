/** 真实 MCP 链路冒烟：门店 -> 菜单 -> 餐品详情 -> 核价。 */
import { loadConfig } from "../src/config";
import { createDataSource } from "../src/mcp/index";

async function main() {
  const cfg = loadConfig();
  const bundle = await createDataSource(cfg);
  console.log("模式:", bundle.mode, "|", bundle.note);
  const ds = bundle.source;

  const stores = await ds.findStores({ city: "上海", keyword: "人民广场", beType: 1 });
  console.log(`\n门店 ${stores.length} 家，取第 1 家:`, stores[0]?.storeCode, stores[0]?.storeName);
  const store = stores[0];
  if (!store) return;

  const ctx = { storeCode: store.storeCode, orderType: 1 as const, beType: 1 as const, beCode: null, reservationDate: null };
  const menu = await ds.fetchMenu(ctx);
  const usable = menu.filter((m) => m.availability === "available" && m.currentPriceCents !== null);
  console.log(`菜单 ${menu.length} 项，可参与计算 ${usable.length} 项`);
  console.log("样例 3 项:", usable.slice(0, 3).map((m) => `${m.name}(${m.code}) ¥${(m.currentPriceCents! / 100).toFixed(2)} [${m.category}] combo=${m.isCombo}`));
  const withNutrition = usable.filter((m) => m.nutrition.status === "available");
  console.log(`营养匹配 ${withNutrition.length}/${usable.length}`);

  const detail = await ds.fetchMealDetail(ctx, "9900005466");
  console.log("套餐详情 9900005466:", detail);

  const coupons = await ds.fetchCoupons(ctx);
  console.log("门店可用券:", coupons.length);

  const pick = usable.slice(0, 3).map((m) => ({ productCode: m.code, quantity: 1 }));
  const price = await ds.calculatePrice({ context: ctx, items: pick });
  console.log("\n核价状态:", price.status);
  console.log("应付:", price.breakdown.payableCents, "原价:", price.breakdown.originalCents, "优惠:", price.breakdown.discountCents);
  console.log("明细:", price.lines.map((l) => `${l.productName} x${l.quantity} = ${l.subtotalCents}`).join("; "));
  await ds.close();
}

main().catch((e) => {
  console.error("冒烟失败:", e);
  process.exit(1);
});
