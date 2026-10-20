import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import type { AppConfig } from "../src/config";
import { MockDataSource } from "../src/mcp/mock";
import { OrderGuard } from "../src/order/guard";
import { startServer } from "../src/server/http";

/**
 * HTTP 集成测试：在进程内起服务，走完整 API 链路。
 * 使用模拟数据源（不需要 Token），因此可以在任何环境重复运行。
 */

let base = "";
let close: () => Promise<void>;

const cfg: AppConfig = {
  mcpUrl: "https://mcp.mcd.cn",
  mcpToken: "",
  mode: "mock",
  enableRealOrder: false,
  port: 0,
  mcpTimeoutMs: 5000,
  mcpRetry: 0,
};

beforeAll(async () => {
  const { port, close: c } = await startServer({
    cfg,
    bundle: { source: new MockDataSource(), mode: "mock", note: "测试用模拟数据源" },
    guard: new OrderGuard({ enableRealOrder: false }),
    webDir: join(process.cwd(), "web"),
  });
  close = c;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await close?.();
});

async function post(p: string, b: unknown): Promise<any> {
  const r = await fetch(base + p, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(b),
  });
  return (await r.json()) as any;
}
async function get(p: string): Promise<{ status: number; body: string }> {
  const r = await fetch(base + p);
  return { status: r.status, body: await r.text() };
}

describe("HTTP 集成", () => {
  it("健康检查暴露数据源模式与下单开关", async () => {
    const h = await (await fetch(base + "/api/health")).json();
    expect(h.mode).toBe("mock");
    expect(h.realOrderEnabled).toBe(false);
  });

  it("无 Token 时自动降级为模拟模式且不伪造真实价格", async () => {
    const h = await (await fetch(base + "/api/health")).json();
    expect(h.sourceLabel).toContain("模拟");
  });

  it("静态首页可访问", async () => {
    const r = await get("/");
    expect(r.status).toBe(200);
    expect(r.body).toContain("McValue");
  });

  it("optimize 返回经核价的候选并区分估算/核价", async () => {
    const d = await post("/api/optimize", {
      storeCode: "SIM-STORE-0001",
      orderType: 1,
      beType: 1,
      text: "预算 40 元，要汉堡和饮料",
      overrides: { requiredCategories: ["burger", "drink"], people: 1 },
    });
    expect(d.error).toBeUndefined();
    expect(d.report.candidates.length).toBeGreaterThan(0);
    const c = d.report.candidates[0];
    expect(c.pricing.status).toBe("verified");
    expect(c.estimate.status).toBe("estimated");
    expect(c.pricing.breakdown.payableCents).not.toBeNull();
    expect(d.report.conclusion).toBeTruthy();
  });

  it("audit 返回原方案核验与替代方案差异", async () => {
    const d = await post("/api/audit", {
      storeCode: "SIM-STORE-0001",
      orderType: 1,
      beType: 1,
      lines: [
        { productCode: "SIM-BG-02", quantity: 1 },
        { productCode: "SIM-DR-01", quantity: 1 },
      ],
    });
    expect(d.error).toBeUndefined();
    expect(d.report.original.pricing.status).toBe("verified");
    expect(d.report.alternatives.length).toBeGreaterThan(0);
    expect(d.report.differences.some((x: any) => x.field === "应付金额")).toBe(true);
    expect(d.report.comparability.comparable).toBe(true);
  });

  it("下单端点在默认配置下永远拒绝", async () => {
    const d = await post("/api/order/request", {
      draft: {
        storeCode: "SIM-STORE-0001",
        orderType: 1,
        beType: 1,
        takeWayCode: "eat-in",
        items: [{ code: "SIM-BG-01", quantity: 1 }],
        verifiedPayableCents: 1200,
        verifiedAt: new Date().toISOString(),
      },
      confirmation: { storeConfirmed: true, takeWayConfirmed: true, itemsConfirmed: true, priceConfirmed: true },
    });
    expect(d.decision.allowed).toBe(false);
    expect(d.decision.code).toBe("real-order-disabled");
  });

  it("参数缺失时返回明确错误而不是崩溃", async () => {
    const d = await post("/api/optimize", { orderType: 1, beType: 1 });
    expect(d.error).toBeTruthy();
    expect(d.error).toContain("storeCode");
  });
});
