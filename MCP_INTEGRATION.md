# MCP_INTEGRATION.md

> 说明本项目实际使用的麦当劳 MCP Server、Tool、调用流程与业务价值。
> 文中所有字段名、枚举值、单位均来自真实调用的 `inputSchema / outputSchema` 与真实响应，未作推测。
> 原始 Schema 快照见 `reference/mcp-tools.json`，真实响应样例见 `reference/live/*.txt`。

---

## 1. 连接的 MCP Server

| 项 | 值 |
| --- | --- |
| Server | 麦当劳官方 MCP（`mcd-mcp`） |
| URL | `https://mcp.mcd.cn` |
| 传输 | Streamable HTTP（官方推荐） |
| 协议版本 | `2025-06-18` |
| 鉴权 | `Authorization: Bearer <MCD_MCP_TOKEN>` |
| SDK | `@modelcontextprotocol/sdk` v1.32.1（`Client` + `StreamableHTTPClientTransport`） |
| 凭据存放 | 仅环境变量 `MCD_MCP_TOKEN`，仓库内无任何明文 Token |

鉴权方式经实测确认：不带 `Bearer` 前缀会返回 `403 / 400003 校验鉴权authToken必填!`；带 `Bearer` 后 `initialize` 返回
`serverInfo: { name: "mcd-mcp", version: "1.0.0" }`。

配置示例见 `mcp-config.example.json`（仅含 `${MCD_MCP_TOKEN}` 占位符）。

---

## 2. 实际使用的 Tool

| Tool | 用途 | 关键入参（来自官方 Schema） | 本项目怎么用 |
| --- | --- | --- | --- |
| `query-nearby-stores` | 查门店 | 必填 `beType`、`searchType`；`searchType=2` 时必填 `city`、`keyword` | 定位定价上下文中的 `storeCode` |
| `query-meals` | 查菜单 | 必填 `storeCode`、`orderType`、`beType`；`beCode` 仅外送/得来速/团餐传 | 构建候选商品池，取 `currentPrice` / `originalPrice` / `discountType` |
| `query-meal-detail` | 查餐品详情 | 必填 `storeCode`、`orderType`、`beType`、`code` | 判定商品是否套餐，并取 `rounds[].choices[].code`（`isDefault=1`）作为真实子项 |
| `calculate-price` | **官方核价** | 必填 `storeCode`、`orderType`、`beType`；`items: [{productCode, quantity, couponId?, couponCode?, roundList?, modification?}]` | 每个候选组合的真实定价；也是审计的唯一价格事实来源 |
| `query-store-coupons` | 查门店可用券 | 必填 `storeCode`、`orderType`、`beType` | 唯一返回结构化 `couponId` 的券源，用于带券复算 |
| `list-nutrition-foods` | 营养数据 | 无入参 | 营养偏好匹配；匹配不到的如实标注缺失 |

**未调用**：`create-order`、`cancel-order`、`delivery-create-order`、`mall-create-order` 等一切写操作。
本项目第一版为只读，链路终点是官方核价。

---

## 3. 官方返回字段的真实口径

### 3.1 `calculate-price` → `data`（单位：分，由官方 outputSchema 明确标注）

| 字段 | 含义 |
| --- | --- |
| `productOriginalPrice` / `productPrice` | 商品原价 / 商品现价 |
| `deliveryOriginalPrice` / `deliveryPrice` | 运费原价 / 运费现价 |
| `packingOriginalPrice` / `packingPrice` | 打包费原价 / 现价 |
| `tablewarePrice` | 餐具费 |
| `originalPrice` / `discount` / `price` | 原价 / 优惠金额 / **应付金额** |
| `productList[]` | `productCode`、`productName`、`quantity`、`originalSubtotal`、`subtotal` |
| `takeWayList[]` | 取餐方式 `code`/`title`/`subtitle`（到店下单时携带） |
| `enjoyed` / `enjoyable` | 已享受 / 可享受优惠：`amountType`（1 特价 2 折扣 3 立减）、`realDiscount`、`balance` |

到店场景实测**不返回**配送费与包装费字段 → 本项目显示为「未提供」，绝不用 0 填充。

### 3.2 `query-meals` → `data`

```
data.categories[]        { name, meals: [{ code, tags }] }
data.meals.{code}        { name, image, currentPrice, originalPrice,
                           discountType, canWithOrder, withOrder }
```

### 3.3 `list-nutrition-foods` → `data`

`data` 是自描述文本，形如
`[160]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:`
后接 CSV 行。本项目按 header 里的字段名动态解析，不硬编码列序。

---

## 4. 调用流程

```
① query-nearby-stores(beType=1, searchType=2, city, keyword)   → storeCode
② query-meals(storeCode, orderType, beType[, beCode])           → 菜单 + 菜单价
③ list-nutrition-foods()                                        → 营养库（缓存）
④ query-store-coupons(storeCode, orderType, beType)             → 可用券（couponId）
⑤ [本地] 有界回溯搜索 + 硬约束过滤 + 评分                        → Top-N 候选
⑥ calculate-price(items)                       ×N               → 官方核价
⑦ calculate-price(items + couponId)             ×≤3             → 仅在官方金额更低时采纳
⑧ query-meal-detail(code)                      ×≤3             → 确认套餐真实组成（仅解释用）
⑨ [审计] calculate-price(原方案) / calculate-price(替代方案)      → 同条件差价
```

所有工具调用统一经过超时与错误分类（`timeout` / `transport` / `business` / `unauthorized`）；
业务错误不重试，超时按配置重试一次。

---

## 5. 真实调用中发现的关键事实（已写入代码）

1. **条件价陷阱**：`discountType` 以「随单购」开头的商品，菜单 `currentPrice` 是**附带前置条件的价**。
   实测 `9900011056 全明星双人分享餐八件套`：菜单价 ¥49.90，未购卡时官方核价 **¥114.50**（＝原价）。
   因此本项目对 `priceConditional` 商品一律用 `originalPrice` 做本地估算，否则会系统性低估预算。
   → 对应代码：`src/domain/pricing.ts` 的 `unitPriceForEstimate()`；回归测试：`tests/live-mcp.test.ts`。

2. **营养覆盖率有限**：该门店 109 项可售餐品中仅 56 项能匹配到官方营养库的精确名称。
   因此营养聚合一律标注「已匹配 X/Y 件」，部分缺失时合计值只作为**下界**，绝不声称是完整合计。

3. **券源差异**：`query-store-coupons` 是唯一返回 `couponId` 的结构化券源；本门店实测返回空数组。
   券传入核价后若官方 `discount` 为 0，本项目标记为 `rejected` 并说明「无法确认该券对本组合生效」，不谎报优惠。

4. **可比性**：`orderType`/`beType`/`beCode`/门店任一不同的价格不做差价结论；审计在报告头部显式输出定价上下文。

---

## 6. 业务价值

| 角色 | 价值 |
| --- | --- |
| 用户 | 一句话说出预算与忌口，得到**经过官方核价**的组合，而不是估算数字；能看到省了多少、为什么 |
| 用户 | 已点的单子可以回查：官方真实应付 vs 本地估算的差额来源（配送费/包装费/优惠）一目了然 |
| 商户/运营 | 组合推荐全部基于官方核价结果，避免"展示价与实付价不一致"的客诉 |
| 平台 | 全程只读，不触碰下单与支付，风险可控；交易保护机制可平滑开启下单 |

---

## 7. 降级与容错

- 未提供 Token 或连接失败 → 自动降级为**模拟数据模式**，并在 UI 与所有报告中标注「模拟数据」，价格全部带 `SIM-` 前缀，绝不冒充真实价格。
- `calculate-price` 失败 → 候选状态记为 `failed` 并展示 `failureReason`，**不会**回退成估算数字冒充核价。
- 搜索未穷举 → 结论措辞固定为「已检查候选中的最优方案」，仅在 `completeness === "exhaustive"` 时才称全局最优。
