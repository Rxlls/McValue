/**
 * 交易安全守卫。
 *
 * 第一版默认关闭真实下单：enableRealOrder=false 时，任何 create-order 调用都被拒绝。
 * 即便开启，也必须满足：
 *   1. 有官方核价成功记录（verified），且金额非空；
 *   2. 用户已逐项确认门店、用餐方式、商品与数量、价格；
 *   3. 确认令牌与当前订单草稿指纹一致 —— 任何重要字段变动都会让令牌失效，必须重新核价并重新确认；
 *   4. 创建订单 ≠ 支付成功；结果不明时先查订单状态，不盲目重试；
 *   5. 取消订单同样需要单独授权。
 */

import { createHash, randomBytes } from "node:crypto";
import { formatCents } from "../domain/money";
import { normalizeLines, type SimpleLine } from "../domain/lines";
import type { PriceContext } from "../domain/types";

export interface OrderDraftItem extends SimpleLine {
  couponId?: string | null;
}

export interface OrderDraft {
  context: PriceContext;
  /** 取餐方式 code，来自 calculate-price 的 takeWayList */
  takeWayCode: string | null;
  items: OrderDraftItem[];
  /** 最近一次成功核价的应付金额（分）。没有则不允许下单。 */
  verifiedPayableCents: number | null;
  verifiedAt: string | null;
  priceTraceId: string | null;
}

export interface UserConfirmation {
  storeConfirmed: boolean;
  takeWayConfirmed: boolean;
  itemsConfirmed: boolean;
  priceConfirmed: boolean;
}

export const EMPTY_CONFIRMATION: UserConfirmation = {
  storeConfirmed: false,
  takeWayConfirmed: false,
  itemsConfirmed: false,
  priceConfirmed: false,
};

/**
 * 订单指纹：覆盖门店、用餐方式、业务编码、预约时间、取餐方式、商品明细与核价金额。
 * 任一重要字段变化都会导致指纹变化，从而让已签发的确认令牌失效。
 */
export function orderFingerprint(draft: OrderDraft): string {
  const items = normalizeLines(draft.items.map((i) => ({ code: i.code, quantity: i.quantity })));
  const coupons = draft.items
    .map((i) => `${i.code}:${i.couponId ?? "-"}`)
    .sort()
    .join(",");
  const raw = [
    draft.context.storeCode,
    draft.context.orderType,
    draft.context.beType,
    draft.context.beCode ?? "-",
    draft.context.reservationDate ?? "-",
    draft.takeWayCode ?? "-",
    items.map((i) => `${i.code}*${i.quantity}`).join(","),
    coupons,
    draft.verifiedPayableCents ?? "null",
  ].join("|");
  return createHash("sha256").update(raw).digest("hex");
}

export type GuardCode =
  | "ok"
  | "real-order-disabled"
  | "missing-price"
  | "missing-takeway"
  | "incomplete-confirmation"
  | "empty-items"
  | "token-invalid"
  | "token-missing";

export interface GuardDecision {
  allowed: boolean;
  code: GuardCode;
  reason: string;
  /** 还缺哪些确认项 */
  missing: string[];
  token: string | null;
  fingerprint: string;
}

export interface GuardOptions {
  enableRealOrder: boolean;
  /** 令牌有效期（毫秒），超时需重新确认 */
  tokenTtlMs?: number;
}

interface IssuedToken {
  fingerprint: string;
  issuedAt: number;
}

export class OrderGuard {
  private readonly tokens = new Map<string, IssuedToken>();
  private readonly ttlMs: number;

  constructor(private readonly opts: GuardOptions) {
    this.ttlMs = opts.tokenTtlMs ?? 10 * 60 * 1000;
  }

  get realOrderEnabled(): boolean {
    return this.opts.enableRealOrder;
  }

  /**
   * 校验是否可以下单，并在全部条件满足时签发一次性确认令牌。
   * 注意：本方法只做"是否允许"的判断，绝不在这里发起任何网络调用。
   */
  requestCreateOrder(draft: OrderDraft, confirmation: UserConfirmation): GuardDecision {
    const fp = orderFingerprint(draft);
    const base = { token: null, fingerprint: fp };

    if (!this.opts.enableRealOrder) {
      return {
        ...base,
        allowed: false,
        code: "real-order-disabled",
        reason: "真实下单总开关未开启（ENABLE_MCD_REAL_ORDER=false）。本项目默认只读，链路终点是官方核价。",
        missing: ["开启 ENABLE_MCD_REAL_ORDER 并由用户重新确认"],
      };
    }

    if (draft.items.length === 0) {
      return { ...base, allowed: false, code: "empty-items", reason: "订单商品为空", missing: ["商品清单"] };
    }

    if (draft.verifiedPayableCents === null || draft.verifiedAt === null) {
      return {
        ...base,
        allowed: false,
        code: "missing-price",
        reason: "没有成功的官方核价记录，禁止下单。必须先调用 calculate-price 取得可信金额。",
        missing: ["官方核价"],
      };
    }

    if (draft.context.orderType === 1 && !draft.takeWayCode) {
      return {
        ...base,
        allowed: false,
        code: "missing-takeway",
        reason: "到店场景缺少取餐方式（takeWayCode 需从 calculate-price 的 takeWayList 中选择）。",
        missing: ["取餐方式"],
      };
    }

    const missing: string[] = [];
    if (!confirmation.storeConfirmed) missing.push(`门店：${draft.context.storeCode}`);
    if (!confirmation.takeWayConfirmed) missing.push(`用餐方式：${draft.takeWayCode ?? "（未选择）"}`);
    if (!confirmation.itemsConfirmed) {
      missing.push(`商品与数量：${draft.items.map((i) => `${i.code} x${i.quantity}`).join("、")}`);
    }
    if (!confirmation.priceConfirmed) missing.push(`价格：${formatCents(draft.verifiedPayableCents)}`);
    if (missing.length > 0) {
      return {
        ...base,
        allowed: false,
        code: "incomplete-confirmation",
        reason: "用户尚未明确确认全部关键订单信息。",
        missing,
      };
    }

    const token = randomBytes(16).toString("hex");
    this.tokens.set(token, { fingerprint: fp, issuedAt: Date.now() });
    return { allowed: true, code: "ok", reason: "已确认，允许调用 create-order", missing: [], token, fingerprint: fp };
  }

  /** 真正调用 create-order 前的最后一道校验。 */
  authorize(token: string | null, draft: OrderDraft): GuardDecision {
    const fp = orderFingerprint(draft);
    if (!token) {
      return {
        allowed: false,
        code: "token-missing",
        reason: "缺少确认令牌",
        missing: ["用户确认"],
        token: null,
        fingerprint: fp,
      };
    }
    const issued = this.tokens.get(token);
    if (!issued) {
      return {
        allowed: false,
        code: "token-invalid",
        reason: "确认令牌不存在或已被使用",
        missing: ["重新确认"],
        token: null,
        fingerprint: fp,
      };
    }
    if (issued.fingerprint !== fp) {
      // 关键字段被改过 —— 令牌立即作废
      this.tokens.delete(token);
      return {
        allowed: false,
        code: "token-invalid",
        reason: "订单关键字段在确认后被修改（门店/用餐方式/商品/数量/价格任一变化），原确认已失效，必须重新核价并重新确认。",
        missing: ["重新核价", "重新确认"],
        token: null,
        fingerprint: fp,
      };
    }
    if (Date.now() - issued.issuedAt > this.ttlMs) {
      this.tokens.delete(token);
      return {
        allowed: false,
        code: "token-invalid",
        reason: "确认令牌已超时，请重新核价并确认。",
        missing: ["重新确认"],
        token: null,
        fingerprint: fp,
      };
    }
    // 一次性令牌：使用后即作废
    this.tokens.delete(token);
    return { allowed: true, code: "ok", reason: "令牌有效", missing: [], token, fingerprint: fp };
  }

  revoke(token: string): void {
    this.tokens.delete(token);
  }
}

/* ------------------------------------------------------------------ */
/* 下单后的行为约束                                                    */
/* ------------------------------------------------------------------ */

export interface CreateOrderOutcome {
  orderId: string | null;
  status: string | null;
  payUrl: string | null;
  ok: boolean;
  message: string | null;
}

export type PostCreateAdvice =
  | { action: "await-payment"; message: string }
  | { action: "query-status"; message: string }
  | { action: "failed"; message: string };

/**
 * 创建订单后的处置建议。
 * 创建订单不代表支付成功；结果不明时先查订单状态，不盲目重试。
 */
export function adviseAfterCreate(outcome: CreateOrderOutcome): PostCreateAdvice {
  if (!outcome.ok || !outcome.orderId) {
    return {
      action: "query-status",
      message:
        "下单结果不明确（超时或未返回订单号）。不要盲目重试 create-order —— 请先用 query-order 查询订单状态，确认是否已创建，再决定后续动作。",
    };
  }
  return {
    action: "await-payment",
    message: `订单 ${outcome.orderId} 已创建，当前状态：${outcome.status ?? "未知"}。创建订单不等于支付成功，需用户通过支付链接完成支付后再用 query-order 复核。`,
  };
}

export interface CancelRequest {
  orderId: string;
  /** 用户明确授权取消（需单独确认，不能复用下单确认） */
  authorized: boolean;
  reason?: string | null;
}

export function requestCancel(req: CancelRequest): { allowed: boolean; reason: string } {
  if (!req.orderId) return { allowed: false, reason: "缺少订单号" };
  if (!req.authorized) {
    return { allowed: false, reason: "取消订单必须获得用户单独且明确的授权，不能沿用下单确认。" };
  }
  return { allowed: true, reason: `已获得取消授权，可对订单 ${req.orderId} 调用 cancel-order` };
}
