/**
 * McValue 领域模型。
 *
 * 设计原则：
 * 1. 凡是官方接口没有返回的字段，一律建模为 null + 显式 status，不允许用 0 / 空串 / 猜测值填充。
 * 2. 本地估算与官方核价是两种互斥的事实来源，任何时候都不能把估算标记为核价成功。
 * 3. 价格必须携带「定价上下文」（门店 + 用餐方式 + 业务编码 + 预约时间），
 *    不同上下文的价格不可直接比较。
 */

import type { Cents } from "./money";
import type { SatietyReport } from "./satiety";

/* ------------------------------------------------------------------ */
/* 状态枚举：所有"不确定"都必须有名字                                    */
/* ------------------------------------------------------------------ */

/**
 * 价格事实等级。UI 必须能一眼区分这四种状态。
 * - unknown:   尚未定价
 * - estimated: 本地用菜单价求和得出的估算，未经官方核价
 * - verified:  MCP calculate-price 成功返回
 * - failed:    MCP 核价失败（超时/业务错误），原因见 failureReason
 */
export type PriceStatus = "unknown" | "estimated" | "verified" | "failed";

/** 商品在该门店的可售状态。 */
export type AvailabilityStatus = "available" | "unknown" | "unavailable";

/** 营养数据完备度。 */
export type NutritionStatus = "available" | "partial" | "missing" | "unknown";

/** 组合搜索是否穷尽了全部可行解。 */
export type SearchCompleteness = "exhaustive" | "bounded";

/** 优惠券在核价中的实际作用。 */
export type CouponState =
  | "not-applied" // 未使用
  | "applied" // 已传入且核价接受
  | "rejected" // 已传入但核价未生效（不适用该组合/门店）
  | "unavailable"; // 该门店当前无可用的结构化券

/* ------------------------------------------------------------------ */
/* 定价上下文                                                          */
/* ------------------------------------------------------------------ */

/**
 * 一次定价所依赖的全部条件。只有上下文完全相同的两个价格才允许直接比较（减法/排序）。
 */
export interface PriceContext {
  storeCode: string;
  /** 1-到店（含到店自取+得来速），2-外送（含麦乐送+企业团餐）。来自官方 Schema。 */
  orderType: 1 | 2;
  /** 1-到店取餐，2-麦乐送到家，5-得来速(DT)，6-企业团餐。来自官方 Schema。 */
  beType: 1 | 2 | 5 | 6;
  /** 外送/得来速/团餐必传；到店自取为 null。 */
  beCode: string | null;
  /** 预约时间 "yyyy-MM-dd HH:mm"，非预约为 null。 */
  reservationDate: string | null;
}

export function contextKey(ctx: PriceContext): string {
  return [
    ctx.storeCode,
    ctx.orderType,
    ctx.beType,
    ctx.beCode ?? "-",
    ctx.reservationDate ?? "-",
  ].join("|");
}

export function sameContext(a: PriceContext, b: PriceContext): boolean {
  return contextKey(a) === contextKey(b);
}

/* ------------------------------------------------------------------ */
/* 门店 / 商品 / 套餐 / 券                                             */
/* ------------------------------------------------------------------ */

export interface Store {
  storeCode: string;
  storeName: string;
  address: string | null;
  distance: number | null;
  businessStatus: boolean | null;
  businessStartTime: string | null;
  businessEndTime: string | null;
}

/** 官方 list-nutrition-foods 返回的一条营养记录。 */
export interface NutritionFact {
  productName: string;
  energyKj: number | null;
  energyKcal: number | null;
  protein: number | null;
  fat: number | null;
  carbohydrate: number | null;
  sodium: number | null;
  calcium: number | null;
}

/** 单个商品在营养库中的匹配结果。 */
export interface NutritionMatch {
  status: NutritionStatus;
  fact: NutritionFact | null;
  /** 匹配方式：精确 / 包含 / 未匹配 */
  matchKind: "exact" | "contains" | "none";
}

export interface MenuItem {
  /** 官方餐品唯一编码 */
  code: string;
  name: string;
  /** 所属菜单分类（来自 query-meals 的 categories[].name） */
  category: string;
  /** 官方返回的标签（"套餐"/"单品"/"上新"/"麦金卡" 等） */
  tags: string[];
  image: string | null;
  /** 菜单现价。注意：这是"售价参考"，不是核价结果。 */
  currentPriceCents: Cents | null;
  /** 菜单划线价 */
  originalPriceCents: Cents | null;
  /** discountType：null / "早餐卡优惠" / "促销优惠" / "麦金卡优惠" / "随单购…" */
  discountType: string | null;
  /**
   * 菜单现价是否附带前置条件（discountType 以"随单购"开头）。
   * 真实观察：全明星双人分享餐八件套菜单价 ¥49.90（随单购麦金卡优惠），
   * 未购卡时官方核价为 ¥114.50 —— 估算必须使用原价，否则会系统性低估。
   */
  priceConditional: boolean;
  canWithOrder: boolean;
  availability: AvailabilityStatus;
  /** 是否套餐（组合品）。null = 未知。 */
  isCombo: boolean | null;
  /** 套餐判定来源：官方 query-meal-detail 确认 / 由标签与命名推断 / 未知 */
  comboDetection: "mcp-detail" | "heuristic" | "unknown";
  /** 套餐默认子项编码（来自 query-meal-detail），非套餐或未知时为 null。 */
  comboComponentCodes: string[] | null;
  nutrition: NutritionMatch;
}

export interface Coupon {
  couponId: string;
  couponCode: string | null;
  title: string | null;
  /** 有效期原文，官方返回什么就存什么，不做解析 */
  tradeDateTime: string | null;
  /** 适用商品（官方给出时才有） */
  applicableProductCodes: string[];
}

/* ------------------------------------------------------------------ */
/* 需求解析                                                            */
/* ------------------------------------------------------------------ */

/** 类别硬需求：至少 minCount 件属于 category 的商品。 */
export interface CategoryRequirement {
  category: string;
  minCount: number;
}

/** 营养偏好（软约束，除非显式声明 must）。 */
export interface NutritionPreference {
  /** 人均热量上限（kcal） */
  maxKcalPerPerson: number | null;
  /** 整单蛋白质下限（g） */
  minProteinTotal: number | null;
  /** 整单钠上限（mg） */
  maxSodiumTotal: number | null;
  /** 是否作为硬约束。默认 false（软偏好）。 */
  enforceAsHard: boolean;
}

export type CouponPreference = "auto" | "require" | "ignore";

/**
 * 用餐结构：这顿饭想吃什么、各几份。
 *
 * 这是对「2 个人 = 2 个汉堡 + 2 杯饮料」这种机械乘法的替代。
 * 现实中 2 个人可能是：2 主食 2 饮料、1 主食 2 饮料 + 小食、2 主食 1 饮料 + 小食……
 * 系统不确定时应当**询问**，而不是替用户决定。
 */
export interface MealStructure {
  /** 主食份数（汉堡 / 套餐 / 早餐） */
  main: number;
  /** 饮料杯数 */
  drink: number;
  /** 小食份数 */
  side: number;
  /** 甜品份数 */
  dessert: number;
  /**
   * 是否由系统按人数推导。
   * true = 这是默认值，UI 必须显式提示「按人数推算，可修改」，不能假装是用户的意思。
   */
  derived: boolean;
}

export interface Requirement {
  rawText: string;
  /** 总预算（分）。null = 未指定。 */
  budgetCents: Cents | null;
  people: number;
  /** 必选类别（硬约束） */
  requiredCategories: CategoryRequirement[];
  /** 整单商品总件数上限（硬约束）。null = 未指定。 */
  maxItems: number | null;
  /** 整单商品总件数下限（硬约束）。null = 未指定。 */
  minItems: number | null;
  /** 单个商品数量上限（硬约束） */
  maxQtyPerItem: number;
  /** 必须包含的商品编码（硬约束） */
  mustIncludeCodes: string[];
  /** 必须排除的商品编码（硬约束） */
  excludeCodes: string[];
  /** 口味关键词（软偏好） */
  tasteKeywords: string[];
  /** 忌口/回避关键词（硬约束：命中即排除该商品） */
  avoidKeywords: string[];
  couponPreference: CouponPreference;
  nutritionPreference: NutritionPreference | null;
  /** 是否偏好套餐（软偏好） */
  preferCombo: boolean;
  /**
   * 用餐结构。null = 未确定（此时按人数推默认值，并在 UI 上要求用户确认）。
   * 设置后，requiredCategories 由它派生，保证「份数」只有一个事实来源。
   */
  mealStructure: MealStructure | null;
  /**
   * 每人所需的人份下限（硬约束，默认 1）。
   * 用于保证「N 个人点够 N 人份」，避免产出吃不饱的最便宜方案。
   * 若设置了 mealStructure，实际下限取 min(人数, 结构折算份量)，尊重用户主动少吃。
   */
  minSatietyPerPerson: number;
  /** 份量约束是否作为硬约束。默认 true（吃不饱直接淘汰）。 */
  satietyHard: boolean;
}

/* ------------------------------------------------------------------ */
/* 约束校验                                                           */
/* ------------------------------------------------------------------ */

export type ConstraintKind =
  | "budget"
  | "satiety"
  | "required-category"
  | "max-items"
  | "min-items"
  | "max-qty-per-item"
  | "must-include"
  | "exclude"
  | "avoid-keyword"
  | "availability"
  | "nutrition"
  | "coupon";

export interface ConstraintResult {
  kind: ConstraintKind;
  /** 约束的自然语言描述 */
  label: string;
  hard: boolean;
  satisfied: boolean;
  /** 未满足原因（官方数据缺失时明确写"数据缺失"，而不是判为通过） */
  reason: string | null;
}

export interface ConstraintReport {
  results: ConstraintResult[];
  /** 硬约束是否全部满足 */
  hardAllSatisfied: boolean;
  /** 未满足的硬约束 */
  hardViolations: ConstraintResult[];
  /** 未满足的软偏好 */
  softViolations: ConstraintResult[];
}

/* ------------------------------------------------------------------ */
/* 核价结果                                                            */
/* ------------------------------------------------------------------ */

/** calculate-price 返回的官方字段（单位分）。未知字段一律 null。 */
export interface McpPriceBreakdown {
  productOriginalCents: Cents | null;
  productCents: Cents | null;
  deliveryOriginalCents: Cents | null;
  deliveryCents: Cents | null;
  packingOriginalCents: Cents | null;
  packingCents: Cents | null;
  tablewareCents: Cents | null;
  originalCents: Cents | null;
  discountCents: Cents | null;
  /** 应付金额（官方 price 字段） */
  payableCents: Cents | null;
}

export interface McpPriceLine {
  productCode: string;
  productName: string;
  quantity: number;
  originalSubtotalCents: Cents | null;
  subtotalCents: Cents | null;
}

export interface McpTakeWay {
  code: string;
  title: string | null;
  subtitle: string | null;
}

export interface McpEnjoyInfo {
  /** 1 特价 2 折扣 3 立减 */
  amountType: string | null;
  realDiscount: number | null;
  balance: Cents | null;
}

export type PriceFailureKind =
  | "timeout"
  | "transport"
  | "business"
  | "schema"
  | "disabled"
  | "unknown";

export interface PriceResult {
  status: PriceStatus;
  context: PriceContext;
  lines: McpPriceLine[];
  breakdown: McpPriceBreakdown;
  takeWayList: McpTakeWay[];
  /** 已享受优惠（官方 enjoyed） */
  enjoyed: McpEnjoyInfo | null;
  /** 可享受优惠（官方 enjoyable） */
  enjoyable: McpEnjoyInfo | null;
  couponState: CouponState;
  couponId: string | null;
  /** 券的实际作用说明（例如"券已传入但核价优惠金额为 0，未对本组合生效"） */
  couponNote: string | null;
  /** 失败原因（人类可读），仅 status='failed' 时有值 */
  failureReason: string | null;
  failureKind: PriceFailureKind | null;
  /** 官方 traceId，便于追溯 */
  traceId: string | null;
  fetchedAt: string | null;
  /** 官方原始响应快照（脱敏后仅保留结构字段，用于审计留痕） */
  rawSummary: string | null;
}

/* ------------------------------------------------------------------ */
/* 候选组合                                                           */
/* ------------------------------------------------------------------ */

export interface CandidateLine {
  code: string;
  name: string;
  quantity: number;
  /** 菜单价（用于估算），缺失为 null */
  menuPriceCents: Cents | null;
  isCombo: boolean | null;
}

/** 本地估算：仅由菜单价求和，不含配送费/包装费/优惠，绝不等同于核价。 */
export interface PriceEstimate {
  status: "estimated" | "unknown";
  totalCents: Cents | null;
  /** 有多少件商品拿不到菜单价 */
  missingPriceCount: number;
  note: string;
}

export interface ScoreBreakdown {
  /** 总分（0-100） */
  total: number;
  /** 口味匹配 */
  taste: number;
  /** 多样性（不同类别数 / 不重复程度） */
  diversity: number;
  /** 预算贴合度（越接近预算上限越省得多，但不超支） */
  budgetFit: number;
  /** 营养契合度；营养数据缺失时为 null 且不参与加权 */
  nutrition: number | null;
  /** 份量充足度（是否满足 N 人份） */
  satiety: number;
  /** 套餐偏好 */
  comboAffinity: number;
  /** 各项权重说明，便于解释 */
  weights: Record<string, number>;
  /** 解释：为什么得这个分 */
  explanation: string[];
}

export interface NutritionAggregate {
  status: NutritionStatus;
  /** 已匹配到官方营养数据的商品件数 */
  matchedItems: number;
  /** 组合内商品总件数 */
  totalItems: number;
  energyKcal: number | null;
  protein: number | null;
  fat: number | null;
  carbohydrate: number | null;
  sodium: number | null;
  /** 未匹配的餐品名称，用于 UI 如实标注 */
  unmatchedNames: string[];
  /** 近似匹配（名称包含而非完全相等）的餐品名称，需标注为估算口径 */
  approximateNames: string[];
  /** 合计值是否只是「下界」（存在未匹配项时为真） */
  isLowerBound: boolean;
}

export interface Candidate {
  /** 由 (code:qty) 排序后生成的稳定指纹，用于去重与订单确认 */
  fingerprint: string;
  lines: CandidateLine[];
  /** 商品总件数（含数量） */
  itemCount: number;
  estimate: PriceEstimate;
  /** 官方核价结果；未核价时 status='unknown' */
  pricing: PriceResult;
  score: ScoreBreakdown;
  constraints: ConstraintReport;
  nutrition: NutritionAggregate;
  /** 份量（饱腹）折算结果 */
  satiety: SatietyReport;
  /** 方案风格标签（最省 / 最均衡 / 最丰富 / 最多样 / 备选），用于解释"为什么给你这几个" */
  styleLabel?: string;
}

/* ------------------------------------------------------------------ */
/* 审计                                                               */
/* ------------------------------------------------------------------ */

export interface AuditInputLine {
  productCode: string;
  quantity: number;
}

export interface AuditedPlan {
  /** 方案标识："original" 或 "alternative-N" */
  planId: string;
  label: string;
  lines: CandidateLine[];
  itemCount: number;
  estimate: PriceEstimate;
  pricing: PriceResult;
  constraints: ConstraintReport;
  nutrition: NutritionAggregate;
  /** 份量折算：用于回答「这份订单够几个人吃」 */
  satiety: SatietyReport;
  /** 复核：官方核价与本地估算是否一致 */
  consistency: PriceConsistencyCheck;
}

export interface PriceConsistencyCheck {
  /** 是否可比（官方核价成功且估算可得） */
  comparable: boolean;
  estimateCents: Cents | null;
  verifiedCents: Cents | null;
  deltaCents: Cents | null;
  /** 不一致时的说明（例如存在配送费/包装费/优惠，估算不含这些） */
  note: string;
}

export interface PlanDifference {
  field: string;
  originalValue: string;
  alternativeValue: string;
  /** 差值为 null 表示无法计算（数据缺失） */
  delta: string | null;
  note: string | null;
}

export interface DataProvenance {
  tool: string;
  purpose: string;
  status: "success" | "failed" | "skipped";
  note: string | null;
  traceId: string | null;
}

export interface AuditReport {
  /** 审计所用的定价上下文 */
  context: PriceContext;
  /** 两个方案是否在相同条件下可比 */
  comparability: {
    comparable: boolean;
    reason: string;
  };
  original: AuditedPlan;
  alternatives: AuditedPlan[];
  differences: PlanDifference[];
  constraints: ConstraintReport;
  provenance: DataProvenance[];
  /** 结论（不夸大，不声称"最优"，除非穷举） */
  conclusion: string;
  generatedAt: string;
}

/* ------------------------------------------------------------------ */
/* 优化结果                                                           */
/* ------------------------------------------------------------------ */

export interface OptimizationReport {
  context: PriceContext;
  store: Store | null;
  requirement: Requirement;
  candidates: Candidate[];
  /** 被硬约束淘汰的候选数量（只统计数量，不输出全部内容） */
  rejectedCount: number;
  /** 搜索是否穷举 */
  completeness: SearchCompleteness;
  /** 未穷举的原因 */
  boundedReason: string | null;
  /** 实际枚举并评估的组合数 */
  evaluatedCount: number;
  /** 送达官方核价的组合数 */
  verifiedCount: number;
  /** 核价失败的组合数 */
  failedPriceCount: number;
  /** 估算合格、但官方核价后发现违反硬约束而被淘汰的组合 */
  postVerificationRejected: Array<{ fingerprint: string; names: string[]; reasons: string[] }>;
  /** 结论措辞（严格区分"已检查候选中最优"与"全局最优"） */
  conclusion: string;
  provenance: DataProvenance[];
  generatedAt: string;
}
