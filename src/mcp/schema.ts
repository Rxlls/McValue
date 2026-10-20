/**
 * 官方 MCP 原始响应结构。
 *
 * 全部字段来自真实调用 reference/mcp-tools.json（inputSchema / outputSchema）
 * 与 reference/live/*.txt（真实响应），未凭猜测补充任何字段。
 * 字段含义与单位以官方 outputSchema 描述为准（价格单位：分）。
 */

/** query-nearby-stores -> data[] */
export interface RawStore {
  storeCode: string;
  storeName: string;
  address?: string | null;
  distance?: number | null;
  businessStatus?: boolean | null;
  businessStartTime?: string | null;
  businessEndTime?: string | null;
  beCode?: string | null;
  reservation?: boolean | null;
}

/** query-meals -> data */
export interface RawMenu {
  categories?: Array<{
    name: string;
    meals?: Array<{ code: string; tags?: string[] }>;
  }>;
  meals?: Record<
    string,
    {
      name?: string;
      image?: string | null;
      currentPrice?: string | null;
      originalPrice?: string | null;
      discountType?: string | null;
      canWithOrder?: boolean | null;
      withOrder?: {
        cardId?: string | null;
        cardType?: number | null;
        membershipCode?: string | null;
        specId?: string | null;
      } | null;
    }
  >;
}

/** query-meal-detail -> data */
export interface RawMealDetail {
  code?: string;
  name?: string;
  image?: string | null;
  supportModify?: boolean | null;
  rounds?: Array<{
    id?: number | string;
    name?: string;
    quantity?: number;
    maxQuantity?: number;
    minQuantity?: number;
    choices?: Array<{
      code?: string;
      name?: string;
      quantity?: number;
      isDefault?: number;
      diffPrice?: string | null;
      supportModify?: boolean | null;
    }>;
  }> | null;
}

/** calculate-price -> data */
export interface RawPrice {
  productOriginalPrice?: number | null;
  productPrice?: number | null;
  deliveryOriginalPrice?: number | null;
  deliveryPrice?: number | null;
  packingOriginalPrice?: number | null;
  packingPrice?: number | null;
  tablewarePrice?: number | null;
  originalPrice?: number | null;
  discount?: number | null;
  price?: number | null;
  productList?: Array<{
    productCode?: string;
    productName?: string;
    quantity?: number;
    originalSubtotal?: number | null;
    subtotal?: number | null;
  }> | null;
  takeWayList?: Array<{
    code?: string;
    title?: string | null;
    subtitle?: string | null;
  }> | null;
  mealAssistanceList?: Array<{ code?: string; name?: string }> | null;
  enjoyed?: {
    amountType?: string | null;
    realDiscount?: number | null;
    balance?: number | null;
  } | null;
  enjoyable?: {
    amountType?: string | null;
    realDiscount?: number | null;
    balance?: number | null;
  } | null;
}

/** query-store-coupons -> data[] */
export interface RawCoupon {
  couponId?: string;
  couponCode?: string | null;
  title?: string | null;
  tradeDateTime?: string | null;
  products?: Array<{ productName?: string; productCode?: string }> | null;
}

/**
 * list-nutrition-foods -> data 是一个自描述字符串，形如：
 * "[160]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:\n  猪柳麦满分,null,1288,..."
 */
export interface RawNutritionPayload {
  header: string;
  fieldNames: string[];
  rows: string[][];
}
