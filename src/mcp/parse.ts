/**
 * MCP 文本响应解析。
 *
 * 麦当劳官方 MCP 的 tool 返回是 text content，内容形如：
 *   "# API Response Information\n...字段说明...\n## Original Response\n\n{...json...}\n## 后续规则"
 * 官方字段说明里会出现 `{code}` 这类占位符，因此不能简单地取第一个 '{'。
 * 统一策略：定位 `{"success"` 起点，再做带字符串转义的括号配平扫描。
 */

export class McpParseError extends Error {
  constructor(message: string, readonly sample: string) {
    super(message);
    this.name = "McpParseError";
  }
}

/** 提取 tool 返回的所有 text 内容。 */
export function toolText(result: unknown): string {
  const r = result as { content?: Array<{ type?: string; text?: string }> };
  if (!r || !Array.isArray(r.content)) return "";
  return r.content
    .map((c) => (typeof c?.text === "string" ? c.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** 从 text 中配平地取出第一个顶层 JSON 对象。 */
export function extractJsonObject(text: string): unknown | null {
  const start = text.indexOf('{"success"');
  if (start < 0) return null;

  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch (e) {
          throw new McpParseError(
            `JSON 解析失败: ${(e as Error).message}`,
            slice.slice(0, 500),
          );
        }
      }
    }
  }
  return null;
}

export interface McpEnvelope<T = unknown> {
  success: boolean;
  code: number | string | null;
  message: string | null;
  traceId: string | null;
  datetime: string | null;
  data: T | null;
}

/** 解析官方统一响应信封。 */
export function parseEnvelope<T>(text: string): McpEnvelope<T> {
  const obj = extractJsonObject(text) as Record<string, unknown> | null;
  if (!obj) {
    throw new McpParseError("响应中未找到 {\"success\" 开头的 JSON 对象", text.slice(0, 500));
  }
  return {
    success: obj["success"] === true,
    code: (obj["code"] as number | string | null) ?? null,
    message: (obj["message"] as string | null) ?? null,
    traceId: (obj["traceId"] as string | null) ?? null,
    datetime: (obj["datetime"] as string | null) ?? null,
    data: (obj["data"] as T) ?? null,
  };
}
