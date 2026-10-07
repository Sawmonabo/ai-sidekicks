// The boundary of the comparison every harness runs: under, exactly at, and one over the limit.
// A ceiling that excluded its own value would fail a measurement its budget permits.

import { describe, expect, it } from "vitest";

import { BudgetRegistryError } from "./document.js";
import { evaluateBudget } from "./evaluation.js";
import { BudgetRegistry } from "./registry.js";

const registry = BudgetRegistry.load();

describe("budget evaluation", () => {
  it("compares a measurement against the canonical limit", () => {
    const budget = registry.requireBudget("renderer-heap-at-rest");
    const under = evaluateBudget(budget, 92_497_000);
    expect(under.withinBudget).toBe(true);
    expect(under.headroomCanonicalValue).toBe(budget.limit.canonicalValue - 92_497_000);

    const exactlyAtLimit = evaluateBudget(budget, budget.limit.canonicalValue);
    expect(exactlyAtLimit.withinBudget).toBe(true);
    expect(exactlyAtLimit.utilizationFraction).toBe(1);

    const over = evaluateBudget(budget, budget.limit.canonicalValue + 1);
    expect(over.withinBudget).toBe(false);
    expect(over.headroomCanonicalValue).toBe(-1);
  });

  it("refuses an unknown budget id rather than returning a vacuous pass", () => {
    expect(() => registry.requireBudget("no-such-budget")).toThrow(BudgetRegistryError);
  });
});
