/* McValue 前端：只做展示与交互，所有价格事实均由后端经官方 MCP 获取。 */

const $ = (id) => document.getElementById(id);
const state = { report: null, stores: [], audit: null, structTouched: false };

/* ---------------- 用餐结构 ---------------- */
const STRUCT_FIELDS = ["stMain", "stDrink", "stSide", "stDessert"];

function readStructure() {
  return {
    main: Number($("stMain").value || 0),
    drink: Number($("stDrink").value || 0),
    side: Number($("stSide").value || 0),
    dessert: Number($("stDessert").value || 0),
  };
}

function writeStructure(s) {
  if (!s) return;
  $("stMain").value = s.main;
  $("stDrink").value = s.drink;
  $("stSide").value = s.side;
  $("stDessert").value = s.dessert;
}

function markStructTouched() {
  state.structTouched = true;
}

function money(c) {
  return c === null || c === undefined ? '<span class="na">未提供</span>' : `¥${(c / 100).toFixed(2)}`;
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2600);
}
async function api(path, body) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `请求失败 ${res.status}`);
  return data;
}
function showTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".tabpane").forEach((p) => p.classList.toggle("active", p.id === `tab-${name}`));
}
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));

/* ---------------- 状态徽章 ---------------- */
function priceBadge(status) {
  if (status === "verified") return '<span class="badge badge-safe">核价成功</span>';
  if (status === "failed") return '<span class="badge badge-danger">核价失败</span>';
  if (status === "estimated") return '<span class="badge badge-warn">本地估算</span>';
  return '<span class="badge badge-neutral">未核价</span>';
}
/** 份量（饱腹）说明。这份信息决定了「N 个人能不能吃饱」，必须显著展示。 */
function satietyHtml(sat) {
  if (!sat) return "";
  const cls = sat.sufficient ? "badge badge-safe" : "badge badge-danger";
  const label = sat.sufficient ? "够吃" : "不够吃";
  const parts = [`${sat.totalUnits} 人份 / 需要 ${sat.requiredUnits} 人份`, `主食 ${sat.mainUnits} 人份`];
  if (sat.drinkCount > 0) parts.push(`饮料 ${sat.drinkCount} 杯`);
  if (sat.kcalPerPerson !== null) parts.push(`人均约 ${sat.kcalPerPerson} kcal`);
  const warn = !sat.sufficient
    ? `<div class="na">⚠ 该方案折算 ${sat.totalUnits} 人份，未达到 ${sat.requiredUnits} 人份，可能吃不饱</div>`
    : "";
  const kcalNote =
    sat.kcalPerPerson === null
      ? ""
      : sat.kcalInReferenceRange
        ? ""
        : `<div class="na">人均热量 ${sat.kcalPerPerson} kcal，不在通用参考区间内（仅提示，非官方口径）</div>`;
  const unclassified =
    sat.unclassifiedNames && sat.unclassifiedNames.length > 0
      ? `<div class="na">${sat.unclassifiedNames.length} 件商品分类未识别，未计入份量</div>`
      : "";
  return `<div class="satiety-line"><span class="${cls}">份量 ${label}</span> <span>${esc(parts.join(" · "))}</span></div>${warn}${kcalNote}${unclassified}`;
}

function nutritionText(agg) {
  if (!agg) return "无营养数据";
  const base = {
    unknown: "无营养数据",
    missing: `营养数据缺失（${agg.totalItems} 件均未匹配）`,
    partial: `营养不完整：合计为下界（已匹配 ${agg.matchedItems}/${agg.totalItems}）`,
    available: `营养已匹配 ${agg.matchedItems}/${agg.totalItems} 件`,
  }[agg.status];
  const kcal = agg.energyKcal === null ? "—" : `${Math.round(agg.energyKcal)} kcal`;
  return `${base}；热量 ${kcal}${agg.isLowerBound ? "（下界）" : ""}`;
}

/* ---------------- 初始化 ---------------- */
async function loadHealth() {
  const h = await api("/api/health");
  const badge = $("modeBadge");
  badge.textContent = h.mode === "live" ? "数据源：官方 MCP 实时" : "数据源：模拟数据";
  badge.className = "badge " + (h.mode === "live" ? "badge-safe" : "badge-warn");
  $("sourceNote").textContent = h.note || "";
  const ob = $("orderBadge");
  ob.textContent = h.realOrderEnabled ? "下单：已开启" : "下单：关闭（只读）";
  ob.className = "badge " + (h.realOrderEnabled ? "badge-danger" : "badge-safe");
}

async function searchStores() {
  $("btnStores").disabled = true;
  try {
    const d = await api("/api/stores", {
      city: $("city").value, keyword: $("keyword").value, beType: Number($("beTypeSel").value),
    });
    state.stores = d.stores || [];
    const sel = $("storeSel");
    sel.innerHTML = state.stores
      .map((s, i) => `<option value="${i}">${esc(s.storeName)} · ${esc(s.storeCode)}${s.businessStatus === false ? "（暂停营业）" : ""}</option>`)
      .join("");
    $("storeHint").textContent = state.stores.length
      ? `共 ${state.stores.length} 家门店` + (d.mode === "mock" ? "（模拟数据）" : "")
      : "未找到门店，请换关键词";
    if (state.stores.length) toast(`找到 ${state.stores.length} 家门店`);
  } catch (e) { toast(e.message); }
  finally { $("btnStores").disabled = false; }
}

/* ---------------- 优化 ---------------- */
async function runOptimize() {
  const store = state.stores[Number($("storeSel").value)];
  if (!store) { toast("请先搜索并选择门店"); return; }
  $("btnOptimize").disabled = true;
  $("optStatus").textContent = "正在拉取菜单、枚举组合并送官方核价…";
  try {
    const d = await api("/api/optimize", {
      storeCode: store.storeCode,
      storeName: store.storeName,
      orderType: 1,
      beType: Number($("beTypeSel").value),
      text: $("nlText").value,
      overrides: {
        budgetYuan: $("budget").value === "" ? null : $("budget").value,
        people: $("people").value,
        maxItems: $("maxItems").value === "" ? null : $("maxItems").value,
        preferCombo: $("preferCombo").checked,
        couponPreference: $("couponPref").value,
        maxKcalPerPerson: $("kcal").value === "" ? null : $("kcal").value,
        // 用户没动过结构时交给后端按自然语言解析；动过就以他填的为准
        ...(state.structTouched ? { structure: readStructure() } : {}),
      },
    });
    state.report = d.report;
    renderNotes(d.parseNotes, d.unresolved);
    // 用实际生效的结构回填面板，让用户看到"系统理解成了什么"
    if (!state.structTouched && d.report?.requirement?.mealStructure) {
      writeStructure(d.report.requirement.mealStructure);
    }
    renderCandidates(d.report);
    renderCompare(d.report);
    renderProvenance(d.report.provenance);
    $("optStatus").textContent = "";
    showTab("candidates");
  } catch (e) {
    toast(e.message); $("optStatus").textContent = `失败：${e.message}`;
  } finally { $("btnOptimize").disabled = false; }
}

function renderNotes(notes, unresolved) {
  const items = (notes || []).map((n) => `<li>${esc(n)}</li>`).join("");
  const un = (unresolved || []).length ? `<li class="na">未能识别：${esc(unresolved.join("、"))} —— 可在上方表单补充</li>` : "";
  $("parseNotes").innerHTML = notes || un ? `<strong>需求解析</strong><ul>${items}${un}</ul>` : "";
}

function renderCandidates(report) {
  const box = $("cards");
  const rejected = report.postVerificationRejected || [];
  const ms = report.requirement?.mealStructure;
  const structLine = ms
    ? `<div class="satiety-line"><span class="badge badge-info">用餐结构</span><span>主食 ${ms.main} / 饮料 ${ms.drink} / 小食 ${ms.side} / 甜品 ${ms.dessert}</span>${
        ms.derived ? '<span class="na">（数量按人数推算，可在左侧结构与预设里修改）</span>' : ""
      }</div>`
    : "";
  $("conclusion").innerHTML =
    structLine +
    esc(report.conclusion) +
    (rejected.length
      ? `<div class="hint" style="margin-top:6px"><strong>核价后被淘汰的候选 ${rejected.length} 个：</strong><ul style="margin:4px 0;padding-left:18px">${rejected
          .slice(0, 3)
          .map((r) => `<li>${esc(r.names.join("、"))} —— ${esc(r.reasons.join("；"))}</li>`)
          .join("")}</ul></div>`
      : "");
  if (!report.candidates.length) {
    box.innerHTML = "";
    $("empty").style.display = "block";
    $("empty").textContent = "没有候选通过硬约束，请放宽预算或调整必选类别。";
    return;
  }
  $("empty").style.display = "none";
  box.innerHTML = report.candidates.map((c, i) => cardHtml(c, i, report)).join("");
  box.querySelectorAll("[data-audit]").forEach((b) =>
    b.addEventListener("click", () => {
      $("auditCodes").value = b.dataset.audit;
      $("btnAudit").click();
    }),
  );
}

function cardHtml(c, i, report) {
  const p = c.pricing;
  const b = p.breakdown;
  const lines = c.lines
    .map((l) => `<li><span>${esc(l.name)}${l.isCombo ? ' <span class="badge badge-info">套餐</span>' : ""}</span><span class="qty">×${l.quantity} · ${money(l.menuPriceCents)}</span></li>`)
    .join("");
  const hardOk = c.constraints.hardAllSatisfied;
  const violations = c.constraints.hardViolations.map((v) => esc(`${v.label}（${v.reason || "未满足"}）`)).join("；");
  const soft = c.constraints.softViolations.map((v) => esc(v.label)).join("；");
  const fees = [];
  if (b.deliveryCents !== null) fees.push(`配送费 ${money(b.deliveryCents)}`);
  else fees.push(`配送费 <span class="na">未提供</span>`);
  if (b.packingCents !== null) fees.push(`包装费 ${money(b.packingCents)}`);
  else fees.push(`包装费 <span class="na">未提供</span>`);

  return `
  <div class="card ${i === 0 ? "best" : ""}">
    <h3><span>方案 ${i + 1}${c.styleLabel ? ` · ${esc(c.styleLabel)}` : ""}</span><span class="rank">评分 ${c.score.total}</span></h3>
    <div class="status">${priceBadge(p.status)}${i === 0 ? '<span class="badge badge-info">推荐</span>' : ""}</div>
    ${satietyHtml(c.satiety)}
    <ul class="lines">${lines}</ul>
    <div class="prices">
      <span class="k">本地估算</span><span class="v">${money(c.estimate.totalCents)}</span>
      <span class="k">官方核价应付</span><span class="v strong">${money(b.payableCents)}</span>
      <span class="k">商品原价</span><span class="v">${money(b.productOriginalCents)}</span>
      <span class="k">优惠金额</span><span class="v">${money(b.discountCents)}</span>
    </div>
    <div class="meta">
      <div>${fees.join(" · ")}</div>
      ${p.status === "failed" ? `<div class="na">核价失败原因：${esc(p.failureReason || "未知")}（${esc(p.failureKind || "")}）</div>` : ""}
      ${p.couponNote ? `<div>优惠券：${esc(p.couponNote)}</div>` : ""}
      <div>营养：${esc(nutritionText(c.nutrition))}</div>
      <div>约束：${hardOk ? '<span class="badge badge-safe">硬约束全部满足</span>' : `<span class="badge badge-danger">${violations}</span>`}</div>
      ${soft ? `<div class="na">未满足的软偏好：${soft}</div>` : ""}
      <div class="na">搜索范围：${report.completeness === "exhaustive" ? "已穷举" : `受限（${esc(report.boundedReason || "")}）`}</div>
    </div>
    <details class="meta"><summary>评分依据</summary>${c.score.explanation.map((e) => `<div>${esc(e)}</div>`).join("")}</details>
    <div class="actions">
      <button class="btn" data-audit="${c.lines.map((l) => `${l.code}*${l.quantity}`).join(",")}">审计此方案</button>
    </div>
  </div>`;
}

function renderCompare(report) {
  const cs = report.candidates;
  if (!cs.length) { $("compareBox").innerHTML = "暂无可比较的方案。"; return; }
  const rows = cs.map((c, i) => `
    <tr>
      <td>方案 ${i + 1}</td>
      <td>${c.lines.map((l) => `${esc(l.name)}×${l.quantity}`).join("、")}</td>
      <td class="num">${money(c.estimate.totalCents)}</td>
      <td class="num">${money(c.pricing.breakdown.payableCents)}</td>
      <td>${priceBadge(c.pricing.status)}</td>
      <td class="num">${c.score.total}</td>
      <td>${c.constraints.hardAllSatisfied ? '<span class="badge badge-safe">满足</span>' : `<span class="badge badge-danger">${c.constraints.hardViolations.length} 项不满足</span>`}</td>
    </tr>`).join("");
  $("compareBox").innerHTML = `
    <table class="diff">
      <thead><tr><th>方案</th><th>商品明细</th><th>本地估算</th><th>官方核价应付</th><th>核价状态</th><th>评分</th><th>硬约束</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="hint">排序以官方核价金额为准；估算仅用于挑选候选，不作为成交价格。</p>`;
}

function renderProvenance(prov) {
  $("provenanceBox").innerHTML = `
    <table class="diff">
      <thead><tr><th>工具 / 步骤</th><th>用途</th><th>状态</th><th>说明</th></tr></thead>
      <tbody>${(prov || []).map((p) => `
        <tr>
          <td><code>${esc(p.tool)}</code></td><td>${esc(p.purpose)}</td>
          <td>${p.status === "success" ? '<span class="badge badge-safe">成功</span>' : p.status === "failed" ? '<span class="badge badge-danger">失败</span>' : '<span class="badge badge-neutral">跳过</span>'}</td>
          <td>${esc(p.note || "")}</td>
        </tr>`).join("")}</tbody>
    </table>`;
}

/* ---------------- 审计 ---------------- */
async function runAudit() {
  const store = state.stores[Number($("storeSel").value)];
  if (!store) { toast("请先选择门店"); return; }
  let codes = $("auditCodes").value.trim();
  if (!codes) {
    if (!state.report?.candidates?.length) { toast("请先生成方案或直接输入商品编码"); return; }
    codes = state.report.candidates[0].lines.map((l) => `${l.code}*${l.quantity}`).join(",");
  }
  const lines = codes.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    const [code, qty] = s.split("*");
    return { productCode: code.trim(), quantity: Number(qty || 1) };
  }).filter((l) => l.productCode);
  if (!lines.length) { toast("商品编码格式应为 编码*数量"); return; }

  $("btnAudit").disabled = true;
  try {
    const d = await api("/api/audit", {
      storeCode: store.storeCode, orderType: 1, beType: Number($("beTypeSel").value), lines,
      // 带上人数，让审计回答「这份订单够不够吃」
      people: Number($("people").value || 1),
    });
    state.audit = d.report;
    renderAudit(d.report);
    showTab("audit");
  } catch (e) { toast(e.message); }
  finally { $("btnAudit").disabled = false; }
}

function planHtml(p) {
  const b = p.pricing.breakdown;
  return `
    <div class="plan">
      <h4>${esc(p.label)} ${priceBadge(p.pricing.status)}</h4>
      ${satietyHtml(p.satiety)}
      <ul class="lines">${p.lines.map((l) => `<li><span>${esc(l.name)}</span><span class="qty">×${l.quantity}</span></li>`).join("")}</ul>
      <div class="prices">
        <span class="k">本地估算</span><span class="v">${money(p.estimate.totalCents)}</span>
        <span class="k">官方核价应付</span><span class="v strong">${money(b.payableCents)}</span>
        <span class="k">商品原价</span><span class="v">${money(b.productOriginalCents)}</span>
        <span class="k">商品现价</span><span class="v">${money(b.productCents)}</span>
        <span class="k">配送费</span><span class="v">${money(b.deliveryCents)}</span>
        <span class="k">包装费</span><span class="v">${money(b.packingCents)}</span>
        <span class="k">优惠金额</span><span class="v">${money(b.discountCents)}</span>
        <span class="k">应付金额</span><span class="v strong">${money(b.payableCents)}</span>
      </div>
      <div class="meta">
        ${p.pricing.status === "failed" ? `<div class="na">核价失败：${esc(p.pricing.failureReason || "未知")}</div>` : ""}
        <div>估算与核价核对：${esc(p.consistency.note)}</div>
        <div>营养：${esc(nutritionText(p.nutrition))}</div>
        <div>约束：${p.constraints.hardAllSatisfied ? '<span class="badge badge-safe">硬约束全部满足</span>' : p.constraints.hardViolations.map((v) => esc(`${v.label}（${v.reason || ""}）`)).join("；")}</div>
        ${p.pricing.traceId ? `<div class="na">traceId：${esc(p.pricing.traceId)}</div>` : ""}
      </div>
    </div>`;
}

function renderAudit(r) {
  const diffRows = (r.differences || []).map((d) => `
    <tr><td>${esc(d.field)}</td><td>${esc(d.originalValue)}</td><td>${esc(d.alternativeValue)}</td>
    <td class="num">${d.delta ? `<span class="money">${esc(d.delta)}</span>` : '<span class="na">—</span>'}</td></tr>`).join("");
  $("auditResult").innerHTML = `
    <div class="conclusion">
      ${esc(r.conclusion)}
      <div class="hint">可比性：${r.comparability.comparable ? '<span class="badge badge-safe">同条件可比</span>' : `<span class="badge badge-danger">不可比</span> ${esc(r.comparability.reason)}`}</div>
      <div class="hint">定价上下文：门店 ${esc(r.context.storeCode)} · orderType=${r.context.orderType} · beType=${r.context.beType} · beCode=${esc(r.context.beCode || "无")}</div>
    </div>
    <div class="audit-grid">
      <div>${planHtml(r.original)}</div>
      <div>${(r.alternatives || []).map(planHtml).join("") || '<div class="empty">无替代方案</div>'}</div>
    </div>
    <h3>差异对比</h3>
    <table class="diff">
      <thead><tr><th>字段</th><th>原方案</th><th>替代方案</th><th>差额</th></tr></thead>
      <tbody>${diffRows}</tbody>
    </table>
    <h3>数据来源与核价状态</h3>
    <table class="diff">
      <thead><tr><th>工具</th><th>用途</th><th>状态</th><th>说明</th></tr></thead>
      <tbody>${(r.provenance || []).map((p) => `<tr><td><code>${esc(p.tool)}</code></td><td>${esc(p.purpose)}</td>
        <td>${p.status === "success" ? '<span class="badge badge-safe">成功</span>' : p.status === "failed" ? '<span class="badge badge-danger">失败</span>' : '<span class="badge badge-neutral">跳过</span>'}</td>
        <td>${esc(p.note || "")}</td></tr>`).join("")}</tbody>
    </table>
    <p class="hint">本服务第一版不调用 create-order；创建订单需单独开启并逐项确认，且创建订单不等于支付成功。</p>`;
}

/* ---------------- 绑定 ---------------- */
$("btnStores").addEventListener("click", searchStores);
$("btnOptimize").addEventListener("click", runOptimize);
$("btnAudit").addEventListener("click", runAudit);

/* 结构面板：改过就标记，之后不再被自然语言或人数覆盖 */
STRUCT_FIELDS.forEach((id) => $(id).addEventListener("input", markStructTouched));

/* 人数变化：没手动改过结构时，按人数同步「每人一份主食、一杯饮料」的默认值 */
$("people").addEventListener("change", () => {
  if (state.structTouched) return;
  const n = Math.max(1, Number($("people").value || 1));
  $("stMain").value = n;
  $("stDrink").value = n;
});

/* 结构预设 */
document.querySelectorAll("#structPresets button").forEach((b) => {
  b.addEventListener("click", () => {
    const [main, drink, side, dessert] = String(b.dataset.struct || "").split(",").map((x) => Number(x || 0));
    writeStructure({ main, drink, side, dessert });
    markStructTouched();
    toast(`已设为 主食 ${main} / 饮料 ${drink} / 小食 ${side} / 甜品 ${dessert}，点「生成方案」生效`);
  });
});

loadHealth().then(searchStores).catch((e) => toast(e.message));
