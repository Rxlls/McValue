/**
 * 自然语言需求解析。
 *
 * 采用确定性规则解析（正则 + 词典），不依赖任何大模型，也不臆造用户没说的需求。
 * 解析不出来的一律保持 null 并在 notes 中说明，UI 需要展示"未能识别"以提示用户补充。
 */

import { yuanToCents } from "./money";
import type { CategoryRequirement, CouponPreference, MealStructure, NutritionPreference, Requirement } from "./types";

/** 类别语义槽位。解析阶段只产出 slot，之后用真实菜单分类名绑定。 */
export type CategorySlot = "burger" | "snack" | "drink" | "dessert" | "combo" | "coffee" | "breakfast";

/** slot -> 用于匹配真实菜单分类名的正则 */
export const CATEGORY_SLOT_PATTERNS: Record<CategorySlot, RegExp[]> = {
  burger: [/汉堡/, /堡/],
  snack: [/小食/, /炸鸡/, /鸡/, /薯/],
  drink: [/饮/, /咖啡/, /茶/],
  dessert: [/甜品/, /冰淇淋/, /派/, /旋风/],
  combo: [/套餐/, /随心配/, /单人餐/, /多人餐/, /分享/, /精选/, /乐园/],
  coffee: [/咖啡/],
  breakfast: [/早餐/, /满分/],
};

/**
 * 分类 → 槽位的判定优先级。
 *
 * 从「具体商品语义」到「场景化包装」排列：
 * 「小食拼盘/多人餐」这种混合分类既有小食的实质、又有套餐的包装，
 * 必须判成小食 —— 否则一份炸鸡会被当成一份主食，份量直接算错。
 */
const SLOT_PRIORITY: CategorySlot[] = ["burger", "breakfast", "snack", "dessert", "drink", "coffee", "combo"];

/**
 * 判定一个分类（分类名不可用时退回商品名）的主语义槽位。
 * 返回 null 表示无法判断 —— 调用方必须如实标注「未识别」，不能猜。
 */
export function primarySlotOf(category: string, name?: string): CategorySlot | null {
  const norm = (s: string) => s.replace(/\s|\n/g, "");
  const cat = norm(category);
  for (const slot of SLOT_PRIORITY) {
    if (CATEGORY_SLOT_PATTERNS[slot].some((p) => p.test(cat))) return slot;
  }
  // 分类名是「人气热卖」这类杂项时，用商品名兜底（UI 会标注为按名称推断）
  if (name) {
    const n = norm(name);
    for (const slot of SLOT_PRIORITY) {
      if (CATEGORY_SLOT_PATTERNS[slot].some((p) => p.test(n))) return slot;
    }
  }
  return null;
}

/** 用户说法 -> slot */
const KEYWORD_TO_SLOT: Array<{ re: RegExp; slot: CategorySlot }> = [
  { re: /汉堡|堡|牛肉|吉士/, slot: "burger" },
  { re: /小食|薯条|鸡块|鸡翅|炸鸡|鸡排|玉米|小吃/, slot: "snack" },
  { re: /饮料|饮品|喝的|可乐|雪碧|橙汁|牛奶|茶/, slot: "drink" },
  { re: /甜品|冰淇淋|冰激凌|麦旋风|新地|派/, slot: "dessert" },
  { re: /咖啡|拿铁|美式/, slot: "coffee" },
  { re: /早餐|麦满分/, slot: "breakfast" },
  { re: /套餐|套|组合/, slot: "combo" },
];

const TASTE_KEYWORDS = [
  "辣", "香", "脆", "芝士", "牛肉", "鸡肉", "鱼", "虾", "培根", "咖啡",
  "巧克力", "草莓", "蓝莓", "抹茶", "燕麦", "柠檬", "苹果", "橙",
  "酥", "多汁", "清爽", "浓郁", "低脂", "无糖",
];

export interface ParseResult {
  requirement: Requirement;
  /** 解析说明，UI 需要原样展示以保证可解释 */
  notes: string[];
  /** 未能识别的片段提示 */
  unresolved: string[];
}

function findInt(text: string, re: RegExp): number | null {
  const m = text.match(re);
  if (!m?.[1]) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

/** 数量词：阿拉伯数字或中文数字（「一杯」「两杯」「三份」都要能读） */
const QTY_PATTERN = "[0-9]+|[一二两三四五六七八九十]+";

const CN_DIGITS: Record<string, number> = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

/** "2" / "一" / "两" / "十二" → 数字；读不出返回 null */
export function toNumber(raw: string | undefined | null): number | null {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  }
  if (CN_DIGITS[raw] !== undefined) return CN_DIGITS[raw];
  if (raw.startsWith("十")) return 10 + (CN_DIGITS[raw[1]] ?? 0);
  if (raw.includes("十")) {
    const [a, b] = raw.split("十");
    return (CN_DIGITS[a] ?? 1) * 10 + (CN_DIGITS[b] ?? 0);
  }
  return null;
}

/** 槽位 → 用餐结构分组 */
const SLOT_TO_GROUP: Record<CategorySlot, "main" | "drink" | "side" | "dessert"> = {
  burger: "main",
  combo: "main",
  breakfast: "main",
  drink: "drink",
  coffee: "drink",
  snack: "side",
  dessert: "dessert",
};

/**
 * 各分组的计量单位。
 * 饮料只认「杯/瓶/罐」——若把「个」也给饮料，会出现
 * 「汉堡一个饮料」把饮料的量算成汉堡的量。
 */
const UNIT_OF_GROUP: Record<"main" | "drink" | "side" | "dessert", string> = {
  main: "份|个|件",
  drink: "杯|瓶|罐",
  side: "份|个|件|盒",
  dessert: "份|个|件|支",
};

export function parseRequirement(rawText: string, overrides: Partial<Requirement> = {}): ParseResult {
  const text = rawText ?? "";
  const notes: string[] = [];
  const unresolved: string[] = [];

  /* 人数 */
  let people = findInt(text, /(\d+)\s*(?:个)?人/);
  if (people === null) {
    people = 1;
    notes.push("未识别到人数，默认按 1 人计算");
  } else {
    notes.push(`识别到人数：${people} 人`);
  }

  /* 预算：支持「人均 X 元」与「总共 X 元」两种说法 */
  let budgetCents: number | null = null;
  const perPerson = text.match(/(?:人均|每人)\s*(\d+(?:\.\d+)?)\s*(?:元|块|rmb|RMB)?/i);
  const yuanMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:元|块|rmb)\b/i);
  const budgetYuan = text.match(/(?:预算|不超过|控制在|以内|最多|低于)\s*(\d+(?:\.\d+)?)/);
  if (perPerson?.[1]) {
    const c = yuanToCents(perPerson[1]);
    if (c !== null) {
      budgetCents = c * people;
      notes.push(`识别到人均预算 ${perPerson[1]} 元，按 ${people} 人换算总预算 ${(budgetCents / 100).toFixed(2)} 元`);
    }
  } else if (budgetYuan?.[1]) {
    const c = yuanToCents(budgetYuan[1]);
    if (c !== null) {
      budgetCents = c;
      notes.push(`识别到总预算 ${budgetYuan[1]} 元`);
    }
  } else if (yuanMatch?.[1]) {
    const c = yuanToCents(yuanMatch[1]);
    if (c !== null) {
      budgetCents = c;
      notes.push(`识别到金额 ${yuanMatch[1]} 元，按总预算处理`);
    }
  }
  if (budgetCents === null) {
    notes.push("未识别到预算金额，将不做预算硬约束");
    unresolved.push("预算");
  }

  /* 必选需求：先收集「用户到底要什么、各多少」，再收敛成用餐结构 */
  const demanded: Array<{ slot: CategorySlot; count: number | null }> = [];

  /** 取某商品关键词前文，用于判断是不是「要 / 数量 / 并列」 */
  const headOf = (idx: number, keyword: string) => {
    const start = Math.max(0, idx - 8);
    return text.slice(start, idx);
  };

  /**
   * 数量词必须紧邻商品名，且单位要符合类别——
   * 否则「汉堡两杯饮品」会把饮品的「两杯」算到汉堡头上。
   * 主食论「个/份」，饮料论「杯」，这样两类数量不会互相串。
   */
  const qtyOf = (keyword: string, group: "main" | "drink" | "side" | "dessert"): { count: number | null; adjacent: boolean } => {
    const unit = UNIT_OF_GROUP[group];
    const after = text.match(new RegExp(`${keyword}[^，。和、]{0,2}?(${QTY_PATTERN})\\s*(?:${unit})`));
    const before = text.match(new RegExp(`(${QTY_PATTERN})\\s*(?:${unit})\\s*[^，。和、]{0,2}?${keyword}`));
    const raw = after?.[1] ?? before?.[1];
    return { count: toNumber(raw), adjacent: Boolean(after || before) };
  };

  // 两遍扫描：第一遍收「明确提出的」，第二遍收「跟在和/、后面的并列项」。
  // 分两遍是因为关键词循环有固定顺序，"可乐和汉堡" 里的汉堡在饮料之前被扫描到，
  // 单遍会误判为"没有需求前缀"而丢弃。
  for (const pass of [0, 1] as const) {
    for (const { re, slot } of KEYWORD_TO_SLOT) {
      const m = text.match(re);
      if (!m) continue;
      if (demanded.some((d) => d.slot === slot)) continue;
      const idx = m.index ?? 0;
      const head = headOf(idx, m[0]);
      const group = SLOT_TO_GROUP[slot];
      const { count, adjacent } = qtyOf(m[0], group);

      const hasDemandVerb = /(要|需|来|加|带|配|点|想|吃|喝)/.test(head);
      const hasOtherMarker = /(其他|其余|剩下|还有)/.test(head);
      const isParallel = demanded.length > 0 && /[和、]|以及|还有/.test(head);

      if (pass === 0) {
        // 有需求动词、有紧邻数量（"一个汉堡"）、或「其他是小吃」这类补充说明
        if (!(hasDemandVerb || adjacent || hasOtherMarker)) continue;
      } else {
        // 并列项：前面已经出现过需求，且本项由和/、连接
        if (!isParallel) continue;
      }
      demanded.push({ slot, count });
    }
  }

  /* 收敛成用餐结构：用户明说几份就几份，没说才按人数推 */
  // 「我们俩喝一杯就行」这类对饮料数量的直接修正，优先级高于按人数推算
  const drinkHint = text.match(/(?:喝|点|要)\s*([0-9]+|[一二两三四五六七八九十]+)\s*杯/);
  const drinkHintCount = toNumber(drinkHint?.[1]);
  if (drinkHintCount !== null) {
    const i = demanded.findIndex((d) => SLOT_TO_GROUP[d.slot] === "drink");
    if (i >= 0) demanded[i] = { ...demanded[i], count: drinkHintCount };
  }

  const struct = { main: 0, drink: 0, side: 0, dessert: 0 };
  let derived = false;
  for (const d of demanded) {
    const group = SLOT_TO_GROUP[d.slot];
    if (d.count === null) derived = true;
    struct[group] = Math.max(struct[group], d.count ?? Math.max(1, people));
  }
  if (demanded.length === 0) {
    // 完全没说要什么：只保「吃饱」的主食底线，不擅自加饮料
    struct.main = Math.max(1, people);
    derived = true;
  }
  const mealStructure: MealStructure = { ...struct, derived };

  /* 必选类别由结构派生，保证「份数」只有一个事实来源 */
  const requiredCategories: CategoryRequirement[] = [];
  const wantsComboOnly =
    demanded.some((d) => d.slot === "combo") && !demanded.some((d) => d.slot === "burger");
  if (mealStructure.main > 0) {
    requiredCategories.push({ category: wantsComboOnly ? "combo" : "burger", minCount: mealStructure.main });
  }
  if (mealStructure.drink > 0) requiredCategories.push({ category: "drink", minCount: mealStructure.drink });
  if (mealStructure.side > 0) requiredCategories.push({ category: "snack", minCount: mealStructure.side });
  if (mealStructure.dessert > 0) requiredCategories.push({ category: "dessert", minCount: mealStructure.dessert });

  if (demanded.length === 0) {
    notes.push("未识别到明确的必选类别，按人数给出主食底线，未擅自添加饮料");
  } else {
    const parts = [`主食 ${mealStructure.main} 份`, `饮料 ${mealStructure.drink} 杯`];
    if (mealStructure.side > 0) parts.push(`小食 ${mealStructure.side} 份`);
    if (mealStructure.dessert > 0) parts.push(`甜品 ${mealStructure.dessert} 份`);
    notes.push(
      `用餐结构：${parts.join(" / ")}${mealStructure.derived ? "（数量按人数推算，可修改）" : "（按你的说法）"}`,
    );
  }

  /* 忌口 */
  const avoidKeywords: string[] = [];
  const avoidMatch = text.match(/(?:不要|不吃|忌|避免|拒绝|别加|少放)\s*([^，。、；\s]{1,8})/g);
  for (const seg of avoidMatch ?? []) {
    const word = seg.replace(/^(?:不要|不吃|忌|避免|拒绝|别加|少放)\s*/, "").trim();
    if (word) avoidKeywords.push(word);
  }
  if (avoidKeywords.length > 0) notes.push(`忌口关键词：${avoidKeywords.join("、")}`);

  /* 口味偏好：必须先剔除忌口片段，否则「不要香菜」会误提取出口味词「香」 */
  let tasteText = text;
  for (const seg of avoidMatch ?? []) tasteText = tasteText.replace(seg, "");
  const tasteKeywords = TASTE_KEYWORDS.filter((k) => tasteText.includes(k));
  if (tasteKeywords.length > 0) notes.push(`口味关键词：${tasteKeywords.join("、")}`);

  /* 优惠券偏好 */
  let couponPreference: CouponPreference = "auto";
  if (/不用券|不使用券|忽略券/.test(text)) {
    couponPreference = "ignore";
    notes.push("优惠偏好：忽略优惠券");
  } else if (/必须用券|一定要用券|要用券|必须用优惠券/.test(text)) {
    couponPreference = "require";
    notes.push("优惠偏好：必须使用优惠券（将作为硬约束校验）");
  } else if (/用券|优惠券|最省|省钱|便宜|优惠|划算/.test(text)) {
    couponPreference = "auto";
    notes.push("优惠偏好：自动择优使用优惠券");
  }

  /* 营养偏好 */
  let nutritionPreference: NutritionPreference | null = null;
  const kcal = text.match(/(\d{3,4})\s*(?:大卡|千卡|kcal|卡)/i);
  const protein = text.match(/蛋白[质量]*\s*(?:不低于|至少|≥|>)?\s*(\d+)\s*g?/i);
  const sodium = text.match(/(?:钠|盐)[^0-9]{0,6}(\d{3,5})/);
  const lowSodium = /低钠|少盐|清淡/.test(text);
  if (kcal?.[1] || protein?.[1] || sodium?.[1] || lowSodium) {
    nutritionPreference = {
      maxKcalPerPerson: kcal?.[1] ? Number.parseInt(kcal[1], 10) : null,
      minProteinTotal: protein?.[1] ? Number.parseInt(protein[1], 10) : null,
      maxSodiumTotal: sodium?.[1] ? Number.parseInt(sodium[1], 10) : lowSodium ? 2000 : null,
      enforceAsHard: /必须|严格|硬性/.test(text),
    };
    const parts: string[] = [];
    if (nutritionPreference.maxKcalPerPerson) parts.push(`人均热量 ≤ ${nutritionPreference.maxKcalPerPerson} kcal`);
    if (nutritionPreference.minProteinTotal) parts.push(`蛋白质 ≥ ${nutritionPreference.minProteinTotal} g`);
    if (nutritionPreference.maxSodiumTotal) parts.push(`钠 ≤ ${nutritionPreference.maxSodiumTotal} mg`);
    notes.push(`营养偏好：${parts.join("，")}${nutritionPreference.enforceAsHard ? "（硬约束）" : "（软偏好）"}`);
  }

  /* 套餐偏好 */
  const preferCombo = /套餐|套|组合/.test(text);
  if (preferCombo) notes.push("偏好：倾向包含套餐");

  /* 件数上限 */
  let maxItems: number | null = null;
  const maxItemsMatch = text.match(/(?:最多|不超过|至多)\s*(\d+)\s*(?:件|个|样|份)/);
  if (maxItemsMatch?.[1]) {
    maxItems = Number.parseInt(maxItemsMatch[1], 10);
    notes.push(`整单件数上限：${maxItems}`);
  }

  const requirement: Requirement = {
    rawText: text,
    budgetCents,
    people,
    requiredCategories,
    maxItems,
    minItems: null,
    maxQtyPerItem: 3,
    mustIncludeCodes: [],
    excludeCodes: [],
    tasteKeywords,
    avoidKeywords,
    couponPreference,
    nutritionPreference,
    preferCombo,
    mealStructure,
    minSatietyPerPerson: 1,
    satietyHard: true,
    ...overrides,
  };

  /* 份量说明：结构决定下限，用户主动点少时尊重但提示 */
  const structUnits =
    mealStructure.main * 1 + mealStructure.drink * 0.3 + mealStructure.side * 0.35 + mealStructure.dessert * 0.2;
  if (structUnits < Math.max(1, people)) {
    notes.push(
      `提示：该结构折算约 ${Math.round(structUnits * 100) / 100} 人份，少于 ${people} 人所需，可能吃不饱（不会因此拒绝生成方案）`,
    );
  } else {
    notes.push(`份量下限：整单至少折算 ${Math.round(structUnits * 100) / 100} 人份，不足即淘汰`);
  }

  return { requirement, notes, unresolved };
}

/**
 * 把 slot 绑定到真实菜单分类名。
 * 绑定不到时返回空数组 —— 调用方需把它当作"该必选类别无法满足"处理，而不是忽略。
 */
export function bindSlotToCategories(slot: string, menuCategories: string[]): string[] {
  if (menuCategories.includes(slot)) return [slot];
  const patterns = CATEGORY_SLOT_PATTERNS[slot as CategorySlot];
  if (!patterns) return [];
  const norm = (s: string) => s.replace(/\s|\n/g, "");
  return menuCategories.filter((c) => patterns.some((p) => p.test(norm(c))));
}

/** 判断某商品的分类是否属于某个 slot（用于硬约束校验） */
export function categoryMatchesSlot(category: string, slot: string): boolean {
  const cats = bindSlotToCategories(slot, [category]);
  return cats.length > 0;
}

/**
 * 需求槽位的等价扩展。
 *
 * 真实菜单里，「汉堡」这个说法对应的分类（巨无霸系列、安格斯厚牛堡…）往往都是
 * 高价的多人四件套，而真正便宜的单人主食藏在「随心配1+1」「精选单人餐」这类套餐分类里。
 * 只按分类名死匹配会得到「预算内凑不出 2 份汉堡」的假无解。
 *
 * 因此：用户要「汉堡」时，允许由套餐类（单人餐/随心配等，实际含汉堡）等价满足。
 */
export const SLOT_EQUIVALENTS: Partial<Record<CategorySlot, CategorySlot[]>> = {
  burger: ["combo"],
};

/** 绑定 slot 及其等价槽位到真实菜单分类名。 */
export function bindSlotWithEquivalents(slot: string, menuCategories: string[]): string[] {
  const out = new Set(bindSlotToCategories(slot, menuCategories));
  for (const eq of SLOT_EQUIVALENTS[slot as CategorySlot] ?? []) {
    for (const c of bindSlotToCategories(eq, menuCategories)) {
      // 等价槽位只接受「主语义确实是该槽位」的分类。
      // 否则「小食拼盘/多人餐」会因含「多人餐」被当成主食套餐。
      if (primarySlotOf(c) === eq) out.add(c);
    }
  }
  return [...out];
}
