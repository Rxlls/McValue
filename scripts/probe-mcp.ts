/**
 * MCP 探测脚本：连接麦当劳官方 MCP Server，列出真实工具与其 inputSchema。
 * 用途：禁止凭猜测编写字段名/枚举值，一切以服务器返回的 Schema 为准。
 *
 * 用法: npm run probe -- [toolName ...]
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.MCD_MCP_URL ?? "https://mcp.mcd.cn";
const token = process.env.MCD_MCP_TOKEN ?? "";

if (!token) {
  console.error("缺少 MCD_MCP_TOKEN，请在 .env 中配置后重试。");
  process.exit(2);
}

const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});

const client = new Client({ name: "mcvalue-probe", version: "0.1.0" });

async function main() {
  await client.connect(transport);
  console.log("已连接:", url);

  const tools = await client.listTools();
  console.log(`\n工具总数: ${tools.tools.length}\n`);

  const wanted = process.argv.slice(2);
  for (const t of tools.tools) {
    const hit = wanted.length === 0 || wanted.includes(t.name);
    console.log(`--- ${t.name}${t.title ? ` (${t.title})` : ""}`);
    if (!hit) continue;
    console.log(`desc: ${(t.description ?? "").replace(/\s+/g, " ").slice(0, 400)}`);
    console.log("inputSchema:", JSON.stringify(t.inputSchema, null, 2));
    console.log("");
  }
  await client.close();
}

main().catch((e) => {
  console.error("探测失败:", e);
  process.exit(1);
});
