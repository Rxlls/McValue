/**
 * 配置加载。所有凭证只从环境变量读取，代码库中不存在任何硬编码 Token。
 */
export type DataSourceMode = "live" | "mock" | "auto";

export interface AppConfig {
  mcpUrl: string;
  mcpToken: string;
  mode: DataSourceMode;
  /** 真实下单总开关。默认 false —— 第一版不允许调用 create-order。 */
  enableRealOrder: boolean;
  port: number;
  /** 单次 MCP 调用超时（毫秒） */
  mcpTimeoutMs: number;
  /** 核价失败时的重试次数（仅对超时/网络类错误生效，业务错误不重试） */
  mcpRetry: number;
}

function bool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function int(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 在测试等未通过 `--env-file` 启动的场景下手动加载 .env。
 * 只在关键变量缺失时尝试，找不到文件就静默跳过。
 */
export function ensureEnvLoaded(file = ".env"): void {
  if (process.env.MCD_MCP_TOKEN) return;
  try {
    (process as unknown as { loadEnvFile: (p?: string) => void }).loadEnvFile(file);
  } catch {
    /* 没有 .env 文件时忽略 */
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    mcpUrl: env.MCD_MCP_URL?.trim() || "https://mcp.mcd.cn",
    mcpToken: env.MCD_MCP_TOKEN?.trim() ?? "",
    mode: (["live", "mock", "auto"] as const).includes(env.MCD_MCP_MODE as DataSourceMode)
      ? (env.MCD_MCP_MODE as DataSourceMode)
      : "auto",
    enableRealOrder: bool(env.ENABLE_MCD_REAL_ORDER, false),
    port: int(env.PORT, 5173),
    mcpTimeoutMs: int(env.MCP_TIMEOUT_MS, 20000),
    mcpRetry: int(env.MCP_RETRY, 1),
  };
}

/** 是否具备真实调用条件：显式 live，或 auto 且提供了 Token。 */
export function resolveMode(cfg: AppConfig): "live" | "mock" {
  if (cfg.mode === "live") return "live";
  if (cfg.mode === "mock") return "mock";
  return cfg.mcpToken ? "live" : "mock";
}
