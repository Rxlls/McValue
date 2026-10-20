import { describe, expect, it } from "vitest";
import { parseRequirement, bindSlotToCategories } from "../src/domain/requirement";

describe("需求解析", () => {
  it("识别总预算", () => {
    const { requirement } = parseRequirement("预算60元，2个人吃");
    expect(requirement.budgetCents).toBe(6000);
    expect(requirement.people).toBe(2);
  });

  it("人均预算按人数换算为总预算", () => {
    const { requirement } = parseRequirement("3个人，人均30元");
    expect(requirement.people).toBe(3);
    expect(requirement.budgetCents).toBe(9000);
  });

  it("未识别预算时预算为 null，不臆造", () => {
    const { requirement, unresolved } = parseRequirement("帮我随便配点吃的");
    expect(requirement.budgetCents).toBeNull();
    expect(unresolved).toContain("预算");
  });

  it("识别必选类别与忌口", () => {
    const { requirement } = parseRequirement("要2份汉堡，来份小食，不要香菜");
    expect(requirement.requiredCategories.map((c) => c.category)).toContain("burger");
    expect(requirement.requiredCategories.map((c) => c.category)).toContain("snack");
    expect(requirement.avoidKeywords).toContain("香菜");
  });

  it("识别营养偏好", () => {
    const { requirement } = parseRequirement("人均500大卡以内，蛋白质至少30g");
    expect(requirement.nutritionPreference?.maxKcalPerPerson).toBe(500);
    expect(requirement.nutritionPreference?.minProteinTotal).toBe(30);
    expect(requirement.nutritionPreference?.enforceAsHard).toBe(false);
  });

  it("识别必须用券为硬约束", () => {
    const { requirement } = parseRequirement("必须用券，最省");
    expect(requirement.couponPreference).toBe("require");
  });

  it("把 slot 绑定到真实菜单分类名", () => {
    const cats = ["巨无霸\n牛鱼肉堡", "小食甜品\n/其他", "饮品", "麦咖啡™"];
    expect(bindSlotToCategories("burger", cats)).toContain("巨无霸\n牛鱼肉堡");
    expect(bindSlotToCategories("drink", cats)).toContain("饮品");
    expect(bindSlotToCategories("coffee", cats)).toContain("麦咖啡™");
    // 不存在的 slot 返回空，而不是随便挑一个
    expect(bindSlotToCategories("nonexistent-slot", cats)).toEqual([]);
  });
});
