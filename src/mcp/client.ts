/**
 * 官方 MCP TypeScript SDK 客户端封装。
 *
 * 只负责「传输 + 超时 + 错误分类」，不做任何业务语义解释。
 * 传输：StreamableHTTP（官方推荐），鉴权：Authorization: Bearer <token>（经真实调用验证）。
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export type McpErrorKind = "timeout" | "transport" | "business" | "unauthorized";

export class McpCallError extends Error {
  constructor(
    readonly kind: McpErrorKind,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "McpCallError";
  }
}

export interface McpClientOptions {
  url: string;
  token: string;
  timeoutMs: number;
  /** 对 timeout/transport 类错误的重试次数；业务错误不重试 */
  retry: number;
}

export interface ToolCallOutcome {
  text: string;
  /** 是否为 error 结果（isError=true） */
  isError: boolean;
}

function classify(toolName: string, err: unknown): McpCallError {
  if (err instanceof McpCallError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  if (/401|403|未授权|authToken|Unauthorized/i.test(msg)) {
    return new McpCallError("unauthorized", `${toolName}: 鉴权失败（请检查 MCD_MCP_TOKEN）`, msg);
  }
  return new McpCallError("transport", `${toolName}: ${msg}`, msg);
}

export class McpRawClient {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;

  constructor(private readonly opts: McpClientOptions) {}

  private async ensure(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const transport = new StreamableHTTPClientTransport(new URL(this.opts.url), {
        requestInit: { headers: { Authorization: `Bearer ${this.opts.token}` } },
      });
      const client = new Client({ name: "mcvalue", version: "0.1.0" });
      await client.connect(transport);
      this.client = client;
      return client;
    })();
    try {
      return await this.connecting;
    } catch (e) {
      this.connecting = null;
      throw classify("connect", e);
    }
  }

  private withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new McpCallError("timeout", `${label}: 调用超时 ${ms}ms`)), ms);
    });
    return Promise.race([p, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    }) as Promise<T>;
  }

  async listTools(): Promise<Array<{ name: string; inputSchema: unknown }>> {
    const c = await this.ensure();
    const r = await this.withTimeout(c.listTools(), this.opts.timeoutMs, "listTools");
    return r.tools.map((t) => ({ name: t.name, inputSchema: t.inputSchema }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallOutcome> {
    let lastErr: McpCallError | null = null;
    for (let attempt = 0; attempt <= this.opts.retry; attempt++) {
      try {
        const c = await this.ensure();
        const res = (await this.withTimeout(
          c.callTool({ name, arguments: args }),
          this.opts.timeoutMs,
          name,
        )) as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
        const text = (res.content ?? [])
          .map((x) => (typeof x?.text === "string" ? x.text : ""))
          .filter(Boolean)
          .join("\n");
        return { text, isError: res.isError === true };
      } catch (e) {
        lastErr = classify(name, e);
        // 业务错误不重试
        if (lastErr.kind === "business" || lastErr.kind === "unauthorized") break;
      }
    }
    throw lastErr ?? new McpCallError("transport", `${name}: 未知失败`);
  }

  async close(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        /* 关闭失败忽略 */
      }
      this.client = null;
    }
    this.connecting = null;
  }
}
