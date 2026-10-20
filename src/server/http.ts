/**
 * 轻量 HTTP 服务：静态前端 + JSON API。
 * 只做编排与转发，业务逻辑全部在 domain / optimizer / audit 中。
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import type { AppConfig } from "../config";
import { parseRequirement } from "../domain/requirement";
import { yuanToCents } from "../domain/money";
import { optimize } from "../optimizer/optimizer";
import { auditOrder } from "../audit/audit";
import { OrderGuard, EMPTY_CONFIRMATION } from "../order/guard";
import type { AuditInputLine, PriceContext, Requirement } from "../domain/types";
import type { DataSourceBundle } from "../mcp";
import type { McDataSource } from "../mcp/source";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

export interface ServerDeps {
  cfg: AppConfig;
  bundle: DataSourceBundle;
  guard: OrderGuard;
  webDir: string;
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? Number(v) : v));
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function buildContext(b: Record<string, unknown>): PriceContext {
  const storeCode = String(b.storeCode ?? "");
  if (!storeCode) throw new Error("缺少 storeCode");
  const orderType = Number(b.orderType ?? 1) === 2 ? 2 : 1;
  const beTypeRaw = Number(b.beType ?? 1);
  const beType = ([1, 2, 5, 6] as const).includes(beTypeRaw as 1 | 2 | 5 | 6) ? (beTypeRaw as 1 | 2 | 5 | 6) : 1;
  const beCode = b.beCode ? String(b.beCode) : null;
  const reservationDate = b.reservationDate ? String(b.reservationDate) : null;
  return { storeCode, orderType, beType, beCode, reservationDate };
}

function applyOverrides(req: Requirement, o: Record<string, unknown> | undefined): Requirement {
  if (!o) return req;
  const out: Requirement = { ...req };
  if (o.budgetYuan !== undefined && o.budgetYuan !== null && o.budgetYuan !== "") {
    const c = yuanToCents(String(o.budgetYuan));
    out.budgetCents = c;
  }
  if (o.people !== undefined && o.people !== null && o.people !== "") {
    out.people = Number(o.people) || 1;
  }
  if (o.maxItems !== undefined && o.maxItems !== null && o.maxItems !== "") {
    out.maxItems = Number(o.maxItems);
  }
  if (typeof o.preferCombo === "boolean") out.preferCombo = o.preferCombo;
  if (o.couponPreference === "auto" || o.couponPreference === "require" || o.couponPreference === "ignore") {
    out.couponPreference = o.couponPreference;
  }
  /* 用餐结构：显式传入时作为数量的唯一事实来源，并派生必选类别 */
  if (o.structure && typeof o.structure === "object") {
    const s = o.structure as Record<string, unknown>;
    const num = (v: unknown) => Math.max(0, Math.floor(Number(v) || 0));
    const st = {
      main: num(s.main),
      drink: num(s.drink),
      side: num(s.side),
      dessert: num(s.dessert),
      derived: false,
    };
    out.mealStructure = st;
    const cats: Requirement["requiredCategories"] = [];
    if (st.main > 0) cats.push({ category: "burger", minCount: st.main });
    if (st.drink > 0) cats.push({ category: "drink", minCount: st.drink });
    if (st.side > 0) cats.push({ category: "snack", minCount: st.side });
    if (st.dessert > 0) cats.push({ category: "dessert", minCount: st.dessert });
    out.requiredCategories = cats;
  } else if (o.requiredCategories && Array.isArray(o.requiredCategories)) {
    // 勾选类别只表示「要这类」，数量按人数配齐 ——
    // 这里原来写死 minCount: 1，会把「2 人 2 个汉堡」压成 1 个，是「1 个汉堡」的直接来源之一
    const ppl = Math.max(1, out.people);
    out.requiredCategories = (o.requiredCategories as string[]).map((c) => ({ category: c, minCount: ppl }));
  }
  const kcal = o.maxKcalPerPerson;
  if (kcal !== undefined && kcal !== null && kcal !== "") {
    out.nutritionPreference = {
      maxKcalPerPerson: Number(kcal),
      minProteinTotal: null,
      maxSodiumTotal: null,
      enforceAsHard: o.nutritionHard === true,
    };
  }
  return out;
}

export function startServer(deps: ServerDeps): Promise<{ port: number; close: () => Promise<void> }> {
  const { cfg, bundle, guard, webDir } = deps;
  const source: McDataSource = bundle.source;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${cfg.port}`);
    const path = url.pathname;

    try {
      /* ---------------- 静态资源 ---------------- */
      if (req.method === "GET" && (path === "/" || path === "/index.html")) {
        const file = await readFile(join(webDir, "index.html"));
        res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-store" });
        res.end(file);
        return;
      }
      if (req.method === "GET" && (path === "/app.js" || path === "/styles.css")) {
        const file = await readFile(join(webDir, path.slice(1)));
        res.writeHead(200, { "Content-Type": MIME[extname(path)] ?? "text/plain", "Cache-Control": "no-store" });
        res.end(file);
        return;
      }

      /* ---------------- API ---------------- */
      if (path === "/api/health" && req.method === "GET") {
        json(res, 200, {
          mode: bundle.mode,
          note: bundle.note,
          sourceLabel: source.sourceLabel,
          realOrderEnabled: guard.realOrderEnabled,
          mcpUrl: cfg.mcpUrl,
        });
        return;
      }

      if (path === "/api/stores" && req.method === "POST") {
        const b = await readBody(req);
        const stores = await source.findStores({
          city: String(b.city ?? ""),
          keyword: String(b.keyword ?? ""),
          beType: Number(b.beType ?? 1) === 5 ? 5 : 1,
        });
        json(res, 200, { stores, mode: bundle.mode });
        return;
      }

      if (path === "/api/menu" && req.method === "POST") {
        const b = await readBody(req);
        const ctx = buildContext(b);
        const menu = await source.fetchMenu(ctx);
        const categories = [...new Set(menu.map((m) => m.category))];
        json(res, 200, {
          total: menu.length,
          categories,
          slots: ["burger", "snack", "drink", "dessert", "combo", "coffee", "breakfast"],
        });
        return;
      }

      if (path === "/api/optimize" && req.method === "POST") {
        const b = await readBody(req);
        const ctx = buildContext(b);
        const text = String(b.text ?? "");
        const parsed = parseRequirement(text);
        const requirement = applyOverrides(parsed.requirement, b.overrides as Record<string, unknown>);
        const report = await optimize({
          source,
          context: ctx,
          requirement,
          store: b.storeName
            ? { storeCode: ctx.storeCode, storeName: String(b.storeName), address: null, distance: null, businessStatus: null, businessStartTime: null, businessEndTime: null }
            : null,
          verifyLimit: Number(b.verifyLimit ?? 5),
        });
        json(res, 200, {
          report,
          parseNotes: parsed.notes,
          unresolved: parsed.unresolved,
          mode: bundle.mode,
          sourceLabel: source.sourceLabel,
        });
        return;
      }

      if (path === "/api/audit" && req.method === "POST") {
        const b = await readBody(req);
        const ctx = buildContext(b);
        const rawLines = Array.isArray(b.lines) ? (b.lines as Array<Record<string, unknown>>) : [];
        const lines: AuditInputLine[] = rawLines.map((l) => ({
          productCode: String(l.productCode ?? ""),
          quantity: Number(l.quantity ?? 1),
        }));
        const requirement = b.requirement
          ? applyOverrides(parseRequirement(String(b.text ?? "")).requirement, b.requirement as Record<string, unknown>)
          : null;
        const report = await auditOrder({
          source,
          context: ctx,
          lines,
          requirement,
          people: b.people === undefined || b.people === null ? undefined : Number(b.people),
          alternativeLimit: Number(b.alternativeLimit ?? 3),
        });
        json(res, 200, { report, mode: bundle.mode, sourceLabel: source.sourceLabel });
        return;
      }

      /** 交易保护：本端点只返回"是否允许"的决策，第一版永不调用 create-order。 */
      if (path === "/api/order/request" && req.method === "POST") {
        const b = await readBody(req);
        const draftRaw = (b.draft ?? {}) as Record<string, unknown>;
        const confirmation = (b.confirmation ?? EMPTY_CONFIRMATION) as Record<string, boolean>;
        const ctx = buildContext(draftRaw);
        const items = Array.isArray(draftRaw.items) ? (draftRaw.items as Array<Record<string, unknown>>) : [];
        const decision = guard.requestCreateOrder(
          {
            context: ctx,
            takeWayCode: draftRaw.takeWayCode ? String(draftRaw.takeWayCode) : null,
            items: items.map((i) => ({ code: String(i.code ?? ""), quantity: Number(i.quantity ?? 1) })),
            verifiedPayableCents:
              draftRaw.verifiedPayableCents === null || draftRaw.verifiedPayableCents === undefined
                ? null
                : Number(draftRaw.verifiedPayableCents),
            verifiedAt: draftRaw.verifiedAt ? String(draftRaw.verifiedAt) : null,
            priceTraceId: draftRaw.priceTraceId ? String(draftRaw.priceTraceId) : null,
          },
          {
            storeConfirmed: confirmation.storeConfirmed === true,
            takeWayConfirmed: confirmation.takeWayConfirmed === true,
            itemsConfirmed: confirmation.itemsConfirmed === true,
            priceConfirmed: confirmation.priceConfirmed === true,
          },
        );
        json(res, 200, {
          decision,
          note: "本服务第一版不调用 create-order；该端点仅用于演示交易保护判定。",
        });
        return;
      }

      json(res, 404, { error: `未找到路由 ${path}` });
    } catch (e) {
      json(res, 500, { error: (e as Error).message ?? "服务内部错误" });
    }
  });

  return new Promise((resolvePromise) => {
    server.listen(cfg.port, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : cfg.port;
      resolvePromise({
        port,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

/** 供测试复用：解析静态资源根目录。 */
export function resolveWebDir(from: string): string {
  return resolve(normalize(from));
}

export async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
