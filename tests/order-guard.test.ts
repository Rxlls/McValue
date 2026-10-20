import { describe, expect, it } from "vitest";
import {
  EMPTY_CONFIRMATION,
  OrderGuard,
  adviseAfterCreate,
  orderFingerprint,
  requestCancel,
  type OrderDraft,
  type UserConfirmation,
} from "../src/order/guard";

const DRAFT: OrderDraft = {
  context: { storeCode: "SIM-STORE-0001", orderType: 1, beType: 1, beCode: null, reservationDate: null },
  takeWayCode: "eat-in",
  items: [{ code: "SIM-BG-01", quantity: 1 }, { code: "SIM-SN-01", quantity: 1 }],
  verifiedPayableCents: 2000,
  verifiedAt: "2026-01-01T00:00:00.000Z",
  priceTraceId: "T1",
};

const ALL_CONFIRMED: UserConfirmation = {
  storeConfirmed: true,
  takeWayConfirmed: true,
  itemsConfirmed: true,
  priceConfirmed: true,
};

describe("交易安全守卫", () => {
  it("默认关闭：即使全部确认也拒绝下单", () => {
    const guard = new OrderGuard({ enableRealOrder: false });
    const d = guard.requestCreateOrder(DRAFT, ALL_CONFIRMED);
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("real-order-disabled");
  });

  it("开启后缺少核价记录即拒绝", () => {
    const guard = new OrderGuard({ enableRealOrder: true });
    const d = guard.requestCreateOrder({ ...DRAFT, verifiedPayableCents: null, verifiedAt: null }, ALL_CONFIRMED);
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("missing-price");
  });

  it("到店场景缺少取餐方式即拒绝", () => {
    const guard = new OrderGuard({ enableRealOrder: true });
    const d = guard.requestCreateOrder({ ...DRAFT, takeWayCode: null }, ALL_CONFIRMED);
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("missing-takeway");
  });

  it("未逐项确认即拒绝，并列出缺失项", () => {
    const guard = new OrderGuard({ enableRealOrder: true });
    const d = guard.requestCreateOrder(DRAFT, { ...EMPTY_CONFIRMATION, storeConfirmed: true });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("incomplete-confirmation");
    expect(d.missing.join()).toContain("用餐方式");
    expect(d.missing.join()).toContain("价格");
  });

  it("全部确认后签发令牌，authorize 通过", () => {
    const guard = new OrderGuard({ enableRealOrder: true });
    const d = guard.requestCreateOrder(DRAFT, ALL_CONFIRMED);
    expect(d.allowed).toBe(true);
    expect(d.token).toBeTruthy();
    const a = guard.authorize(d.token, DRAFT);
    expect(a.allowed).toBe(true);
  });

  it("修改商品数量后令牌失效，必须重新确认", () => {
    const guard = new OrderGuard({ enableRealOrder: true });
    const d = guard.requestCreateOrder(DRAFT, ALL_CONFIRMED);
    const changed: OrderDraft = { ...DRAFT, items: [{ code: "SIM-BG-01", quantity: 2 }, { code: "SIM-SN-01", quantity: 1 }] };
    const a = guard.authorize(d.token, changed);
    expect(a.allowed).toBe(false);
    expect(a.code).toBe("token-invalid");
    expect(a.reason).toContain("必须重新核价并重新确认");
  });

  it("修改价格后令牌失效", () => {
    const guard = new OrderGuard({ enableRealOrder: true });
    const d = guard.requestCreateOrder(DRAFT, ALL_CONFIRMED);
    const a = guard.authorize(d.token, { ...DRAFT, verifiedPayableCents: 1800 });
    expect(a.allowed).toBe(false);
  });

  it("修改门店后令牌失效", () => {
    const guard = new OrderGuard({ enableRealOrder: true });
    const d = guard.requestCreateOrder(DRAFT, ALL_CONFIRMED);
    const a = guard.authorize(d.token, {
      ...DRAFT,
      context: { ...DRAFT.context, storeCode: "OTHER-STORE" },
    });
    expect(a.allowed).toBe(false);
  });

  it("令牌一次性：重复使用被拒绝", () => {
    const guard = new OrderGuard({ enableRealOrder: true });
    const d = guard.requestCreateOrder(DRAFT, ALL_CONFIRMED);
    expect(guard.authorize(d.token!, DRAFT).allowed).toBe(true);
    expect(guard.authorize(d.token!, DRAFT).allowed).toBe(false);
  });

  it("指纹对商品顺序不敏感（顺序变化不算内容变化）", () => {
    const a = orderFingerprint(DRAFT);
    const b = orderFingerprint({
      ...DRAFT,
      items: [{ code: "SIM-SN-01", quantity: 1 }, { code: "SIM-BG-01", quantity: 1 }],
    });
    expect(a).toBe(b);
  });

  it("创建成功不等于支付成功", () => {
    const advice = adviseAfterCreate({ orderId: "O1", status: "待支付", payUrl: "http://x", ok: true, message: null });
    expect(advice.action).toBe("await-payment");
    expect(advice.message).toContain("不等于支付成功");
  });

  it("结果不明时要求先查订单状态，不盲目重试", () => {
    const advice = adviseAfterCreate({ orderId: null, status: null, payUrl: null, ok: false, message: "timeout" });
    expect(advice.action).toBe("query-status");
    expect(advice.message).toContain("不要盲目重试");
  });

  it("取消订单需要单独授权", () => {
    expect(requestCancel({ orderId: "O1", authorized: false }).allowed).toBe(false);
    expect(requestCancel({ orderId: "O1", authorized: true }).allowed).toBe(true);
  });
});
