// The comparison every harness runs, held to its edges.
//
// `evaluateBudget` is the only place a measurement meets a ceiling, which is what
// keeps `<=` from being written a second time inside a measuring script — a
// second copy is a second place a budget can be loosened. The three cases below
// are the boundary: under, exactly at, and one over, because a ceiling that
// excluded its own value would fail a measurement the spec's own figure permits.
//
// The registry's shape is `budget-registry.test.ts`'s and the loader's refusals
// are `budget-document.test.ts`'s; what this file holds is the arithmetic.

import { describe, expect, it } from "vitest";

import {
  ConsoleBudgetRegistry,
  ConsoleBudgetRegistryError,
  evaluateBudget,
} from "../../../scripts/budget/budget-registry.mjs";

const registry = ConsoleBudgetRegistry.load();

describe("budget evaluation", () => {
  it("compares a measurement against the canonical limit", () => {
    const budget = registry.requireBudget("renderer-initial-bundle");
    const under = evaluateBudget(budget, 92_497);
    expect(under.withinBudget).toBe(true);
    expect(under.headroomCanonicalValue).toBe(budget.limit.canonicalValue - 92_497);

    const exactlyAtLimit = evaluateBudget(budget, budget.limit.canonicalValue);
    expect(exactlyAtLimit.withinBudget).toBe(true);
    expect(exactlyAtLimit.utilizationFraction).toBe(1);

    const over = evaluateBudget(budget, budget.limit.canonicalValue + 1);
    expect(over.withinBudget).toBe(false);
    expect(over.headroomCanonicalValue).toBe(-1);
  });

  it("refuses an unknown budget id rather than returning a vacuous pass", () => {
    expect(() => registry.requireBudget("no-such-budget")).toThrow(ConsoleBudgetRegistryError);
  });
});
