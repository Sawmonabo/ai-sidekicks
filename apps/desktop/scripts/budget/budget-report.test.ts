// Every harness prints this block, so a budget that is not gated stays visible instead of
// becoming a number nobody watches. Asserted both ways: a report that listed every row would also
// mention every un-measured one, so the enforced rows must be absent.

import { describe, expect, it } from "vitest";

import { BudgetRegistry } from "./budget-registry.mjs";
import { formatUnavailableBudgetReport } from "./budget-report.mjs";

const registry = BudgetRegistry.load();

describe("un-measured budget report", () => {
  it("prints one explicit n/a line per un-measured budget, so none is silently omitted", () => {
    const report = formatUnavailableBudgetReport(registry);
    for (const budget of registry.unavailableBudgets()) {
      expect(report, `${budget.id} missing from the report`).toContain(budget.id);
      expect(report).toContain(budget.notMeasurableReason ?? "");
    }
    for (const budget of registry.enforcedBudgets()) {
      expect(report, `${budget.id} should not appear in the n/a block`).not.toContain(
        `n/a  ${budget.id}`,
      );
    }
  });
});
