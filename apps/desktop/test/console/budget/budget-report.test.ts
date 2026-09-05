// The block every harness prints about the budgets it did not measure.
//
// A budget that is not gated at this revision has exactly one way of staying
// visible: every harness prints one line for it beside its own reading. A report
// that omitted a row would put that budget back in the state the registry exists
// to end — a number nobody is watching and nobody notices is unwatched.
//
// Asserted in both directions, because "the report mentions every un-measured
// row" would also be satisfied by a report that listed every row: the enforced
// ones must not appear in the un-measured block.

import { describe, expect, it } from "vitest";

import {
  ConsoleBudgetRegistry,
  formatUnavailableBudgetReport,
} from "../../../scripts/budget/budget-registry.mjs";

const registry = ConsoleBudgetRegistry.load();

describe("un-measured budget report", () => {
  it("prints one explicit n/a line per un-measured budget, so none is silently omitted", () => {
    const report = formatUnavailableBudgetReport(registry);
    for (const budget of registry.unavailableBudgets()) {
      expect(report, `${budget.id} missing from the report`).toContain(budget.id);
      expect(report).toContain(budget.producedBy);
      expect(report).toContain(budget.notMeasurableReason ?? "");
    }
    for (const budget of registry.enforcedBudgets()) {
      expect(report, `${budget.id} should not appear in the n/a block`).not.toContain(
        `n/a  ${budget.id}`,
      );
    }
  });
});
