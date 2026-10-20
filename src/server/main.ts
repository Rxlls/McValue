/** McValue 启动入口。 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, resolveMode } from "../config";
import { createDataSource } from "../mcp";
import { OrderGuard } from "../order/guard";
import { startServer } from "./http";

const here = dirname(fileURLToPath(import.meta.url));
const webDir = join(here, "..", "..", "web");

async function main(): Promise<void> {
  const cfg = loadConfig();
  const bundle = await createDataSource(cfg);
  const guard = new OrderGuard({ enableRealOrder: cfg.enableRealOrder });

  console.log("──────────────────────────────────────────────");
  console.log(" McValue · 麦当劳套餐组合优化与点餐审计");
  console.log("──────────────────────────────────────────────");
  console.log(` 数据源模式 : ${bundle.mode}（${bundle.note}）`);
  console.log(` MCP 地址   : ${cfg.mcpUrl}`);
  console.log(` 配置模式   : ${cfg.mode} -> ${resolveMode(cfg)}`);
  console.log(` 真实下单   : ${guard.realOrderEnabled ? "已开启" : "关闭（默认，本项目只读）"}`);
  console.log(` 服务地址   : http://localhost:${cfg.port}`);
  console.log("──────────────────────────────────────────────");

  const { port } = await startServer({ cfg, bundle, guard, webDir });
  console.log(`\n已启动：http://localhost:${port}`);
}

main().catch((e) => {
  console.error("启动失败:", e);
  process.exit(1);
});
