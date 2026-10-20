/**
 * 真实 MCP 集成测试。
 * 仅在提供了 MCD_MCP_TOKEN 时运行；无 Token 时整体跳过，保证 CI 可用。
 */
import { describe, expect, it } from "vitest";
import { ensureEnvLoaded, loadConfig } from "../src/config";
import { createDataSource } from "../src/mcp";

ensureEnvLoaded();
const cfg = loadConfig();
const hasToken = cfg.mcpToken.length > 0 && cfg.mode !== "mock";
const STORE = process.env.MCD_TEST_STORE ?? "1450713";

describe.skipIf(!hasToken)("官方 MCP 真实调用", () => {
  it("列出工具并包含本项目依赖的核心工具", async () => {
    const bundle = await createDataSource(cfg);
    expect(bundle.mode).toBe("live");
    const ds = bundle.source;
    const ctx = { storeCode: STORE, orderType: 1 as const, beType: 1 as const, beCode: null, reservationDate: null };

    const menu = await ds.fetchMenu(ctx);
    expect(menu.length).toBeGreaterThan(10);
    const priced = menu.filter((m) => m.currentPriceCents !== null && m.availability === "available");
    expect(priced.length).toBeGreaterThan(5);

    const detail = await ds.fetchMealDetail(ctx, "9900005466");
    expect(detail).not.toBeNull();
    expect(detail?.isCombo).toBe(true);
    expect((detail?.componentCodes ?? []).length).toBeGreaterThan(0);

    const price = await ds.calculatePrice({
      context: ctx,
      items: priced.slice(0, 2).map((m) => ({ productCode: m.code, quantity: 1 })),
    });
    expect(price.status).toBe("verified");
    expect(price.breakdown.payableCents).not.toBeNull();
    expect(price.lines.length).toBe(2);

    await ds.close();
  }, 60000);

  it("核价成功时商品小计之和等于商品现价合计", async () => {
    const bundle = await createDataSource(cfg);
    const ds = bundle.source;
    const ctx = { storeCode: STORE, orderType: 1 as const, beType: 1 as const, beCode: null, reservationDate: null };
    const price = await ds.calculatePrice({
      context: ctx,
      items: [
        { productCode: "1100", quantity: 1 },
        { productCode: "4810", quantity: 1 },
      ],
    });
    expect(price.status).toBe("verified");
    const sum = price.lines.reduce((s, l) => s + (l.subtotalCents ?? 0), 0);
    expect(price.breakdown.productCents).toBe(sum);
    await ds.close();
  }, 60000);

  it("随单购条件价商品的官方核价高于菜单现价（估算必须用原价）", async () => {
    const bundle = await createDataSource(cfg);
    const ds = bundle.source;
    const ctx = { storeCode: STORE, orderType: 1 as const, beType: 1 as const, beCode: null, reservationDate: null };
    const menu = await ds.fetchMenu(ctx);
    const conditional = menu.find((m) => m.priceConditional && m.currentPriceCents !== null && m.originalPriceCents !== null);
    if (!conditional) return; // 该门店当前没有条件价商品时跳过断言
    const price = await ds.calculatePrice({
      context: ctx,
      items: [{ productCode: conditional.code, quantity: 1 }],
    });
    expect(price.status).toBe("verified");
    expect(price.breakdown.payableCents).toBe(conditional.originalPriceCents);
    await ds.close();
  }, 60000);
});
