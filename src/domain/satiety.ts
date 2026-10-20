/**
 * 份量（饱腹）模型。
 *
 * 为什么需要它：只按「预算 + 必选类别」建模会产出「2 个人 1 个汉堡」这种荒谬方案。
 * 预算回答的是「最多能花多少」，份量回答的是「够不够吃」——后者才是用餐的底线。
 *
 * 重要边界（诚实声明，务必保留）：
 * - 本模型是**启发式的**：它只用「这是汉堡 / 这是饮料」这种分类常识，
 *   把商品折算成"人份"，不代表任何官方营养口径。
 * - 真实热量只在官方营养数据可取时作为**参考展示**，缺失时明确标注缺失，
 *   绝不用估算值冒充官方数据，也绝不把参考热量当硬约束。
 * - 分类无法识别的商品保守计 0 人份，并登记到 unclassifiedNames，
 *   由 UI 如实提示「有 N 件商品无法判断份量」。
 */

import { primarySlotOf, type CategorySlot } from "./requirement";
import type { MealStructure, MenuItem } from "./types";

/**
 * 每个类别槽位折算的「人份」贡献。
 * 1.0 = 一份主食（一个汉堡大致够一个成年人一顿的主食量）。
 * 饮料/小食/甜品是配角，贡献远低于主食——这正是「两个汉堡两杯饮料才够两人吃」的由来。
 */
export const SLOT_SATIETY: Record<CategorySlot, number> = {
  burger: 1,
  combo: 1,
  breakfast: 1,
  snack: 0.35,
  drink: 0.3,
  dessert: 0.2,
  coffee: 0.15,
};

/** 管饱的槽位（主食类）。用于判断"这单有没有正经主食"。 */
export const MAIN_SLOTS: CategorySlot[] = ["burger", "combo", "breakfast"];

/**
 * 成人一餐热量参考区间（kcal/人）。
 * 这是通用膳食常识，来自公开营养学参考，**不是麦当劳官方数据**，
 * 因此只作为参考展示，缺失营养数据时不参与任何判定。
 */
export const REFERENCE_KCAL_PER_PERSON = { low: 500, high: 850 };


/** 用餐结构折算的总人份。用于「用户主动点少」时尊重其选择。 */
export function structureUnitsOf(s: MealStructure): number {
  const units =
    s.main * SLOT_SATIETY.burger + s.drink * SLOT_SATIETY.drink + s.side * SLOT_SATIETY.snack + s.dessert * SLOT_SATIETY.dessert;
  return Math.round(units * 100) / 100;
}

/** 把真实菜单分类名映射到 { slot, 人份 }。判定不了返回 null（未知，保守计 0）。 */
export function slotSatietyOf(
  category: string,
  name?: string,
): { slot: CategorySlot; units: number } | null {
  const slot = primarySlotOf(category, name);
  return slot ? { slot, units: SLOT_SATIETY[slot] } : null;
}

export interface SatietyReport {
  /** 折算后的总人份 */
  totalUnits: number;
  /** 其中主食类贡献的人份 */
  mainUnits: number;
  /** 饮料杯数 */
  drinkCount: number;
  /** 达到 people 人所需的人份 */
  requiredUnits: number;
  /** 是否达到所需人份 */
  sufficient: boolean;
  /** 人均份量比（totalUnits / people） */
  unitsPerPerson: number;
  /**
   * 热量参考（仅在官方营养数据完整覆盖时给出）。
   * null = 营养数据缺失或不完整，不做任何判断。
   */
  kcalPerPerson: number | null;
  /** 热量参考是否落在通用参考区间内；数据缺失时为 null */
  kcalInReferenceRange: boolean | null;
  /** 无法识别分类（因而无法折算份量）的商品名称 */
  unclassifiedNames: string[];
}

export interface SatietyInput {
  lines: Array<{ code: string; quantity: number }>;
  menu: Map<string, MenuItem>;
}

export function computeSatiety(input: SatietyInput, people: number, kcalTotal: number | null): SatietyReport {
  const ppl = Math.max(1, people);
  let totalUnits = 0;
  let mainUnits = 0;
  let drinkCount = 0;
  const unclassifiedNames: string[] = [];

  for (const l of input.lines) {
    const item = input.menu.get(l.code);
    const mapped = item ? slotSatietyOf(item.category, item.name) : null;
    if (!mapped) {
      unclassifiedNames.push(item?.name ?? l.code);
      continue;
    }
    totalUnits += mapped.units * l.quantity;
    if (MAIN_SLOTS.includes(mapped.slot)) mainUnits += mapped.units * l.quantity;
    if (mapped.slot === "drink") drinkCount += l.quantity;
  }

  const requiredUnits = ppl;
  const unitsPerPerson = totalUnits / ppl;

  // 热量只在完整匹配时作为参考，缺失/不完整一律 null
  const kcalPerPerson = kcalTotal === null ? null : kcalTotal / ppl;
  const kcalInReferenceRange =
    kcalPerPerson === null
      ? null
      : kcalPerPerson >= REFERENCE_KCAL_PER_PERSON.low && kcalPerPerson <= REFERENCE_KCAL_PER_PERSON.high;

  return {
    totalUnits: round2(totalUnits),
    mainUnits: round2(mainUnits),
    drinkCount,
    requiredUnits,
    sufficient: totalUnits >= requiredUnits,
    unitsPerPerson: round2(unitsPerPerson),
    kcalPerPerson: kcalPerPerson === null ? null : Math.round(kcalPerPerson),
    kcalInReferenceRange,
    unclassifiedNames,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 给 UI 的一句话份量说明。 */
export function describeSatiety(r: SatietyReport, people: number): string {
  const ppl = Math.max(1, people);
  const parts: string[] = [];
  parts.push(
    r.sufficient
      ? `折算 ${r.totalUnits} 人份，达到 ${ppl} 人所需 ${r.requiredUnits} 人份`
      : `仅折算 ${r.totalUnits} 人份，未达到 ${ppl} 人所需 ${r.requiredUnits} 人份（差 ${round2(r.requiredUnits - r.totalUnits)} 人份）`,
  );
  parts.push(`其中主食 ${r.mainUnits} 人份`);
  if (r.drinkCount > 0) parts.push(`饮料 ${r.drinkCount} 杯`);
  if (r.unclassifiedNames.length > 0) {
    parts.push(`${r.unclassifiedNames.length} 件商品分类未识别，未计入份量（${r.unclassifiedNames.join("、")}）`);
  }
  if (r.kcalPerPerson === null) {
    parts.push("热量参考不可用（官方营养数据缺失或不完整）");
  } else {
    parts.push(
      `人均热量 ${r.kcalPerPerson} kcal（通用参考 ${REFERENCE_KCAL_PER_PERSON.low}-${REFERENCE_KCAL_PER_PERSON.high} kcal，非官方口径）`,
    );
  }
  return parts.join("；");
}
