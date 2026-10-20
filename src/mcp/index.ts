/**
 * 数据源工厂：根据配置与连通性决定 live / mock，并向调用方说明降级原因。
 */

import { resolveMode, type AppConfig } from "../config";
import { McpRawClient } from "./client";
import { LiveDataSource } from "./live";
import { MockDataSource, type MockOptions } from "./mock";
import type { McDataSource } from "./source";

export interface DataSourceBundle {
  source: McDataSource;
  mode: "live" | "mock";
  /** 为什么是这个模式（连接失败原因会如实写出） */
  note: string;
}

export async function createDataSource(
  cfg: AppConfig,
  mockOptions?: Partial<MockOptions>,
): Promise<DataSourceBundle> {
  const mode = resolveMode(cfg);
  if (mode === "mock") {
    return {
      source: new MockDataSource(mockOptions ? { ...defaultMockOptions(), ...mockOptions } : undefined),
      mode: "mock",
      note: cfg.mcpToken
        ? "已配置为模拟数据模式"
        : "未提供 MCD_MCP_TOKEN，已降级为模拟数据模式（价格非真实）",
    };
  }

  const client = new McpRawClient({
    url: cfg.mcpUrl,
    token: cfg.mcpToken,
    timeoutMs: cfg.mcpTimeoutMs,
    retry: cfg.mcpRetry,
  });

  try {
    // 先做一次轻量探测，确认鉴权与连通性；失败则明确记录原因并降级
    await client.listTools();
    return {
      source: new LiveDataSource(client),
      mode: "live",
      note: `已连接麦当劳官方 MCP：${cfg.mcpUrl}`,
    };
  } catch (e) {
    await client.close();
    return {
      source: new MockDataSource(mockOptions ? { ...defaultMockOptions(), ...mockOptions } : undefined),
      mode: "mock",
      note: `连接官方 MCP 失败（${(e as Error).message}），已降级为模拟数据模式（价格非真实）`,
    };
  }
}

function defaultMockOptions(): MockOptions {
  return { priceFailure: "none", couponApplicableCodes: ["SIM-CB-02"] };
}

export { MockDataSource, MOCK_CATALOG, MOCK_STORE, MOCK_COUPON } from "./mock";
export { LiveDataSource } from "./live";
export type { McDataSource, PriceInput, PriceInputLine, MealDetailFact } from "./source";
export { parseNutritionPayload, NutritionIndex } from "./source";
