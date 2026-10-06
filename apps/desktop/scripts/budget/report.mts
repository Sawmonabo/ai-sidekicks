// Formats the budgets a harness did not measure, so an ungated budget stays visible in every
// report. It reads the rows through a small interface instead of importing `BudgetRegistry`.

import { type Budget } from "./document.mts";

/** The one question this report asks of whatever it is handed. */
export interface UnavailableBudgetSource {
  unavailableBudgets(): readonly Budget[];
}

/**
 * One line per budget this revision does not measure, for every harness to print beside its own
 * reading.
 */
export function formatUnavailableBudgetReport(source: UnavailableBudgetSource): string {
  const unavailable = source.unavailableBudgets();
  if (unavailable.length === 0) {
    return "Every budget in the registry is measured at this revision.";
  }
  const lines = [`Budgets NOT gated at this revision (${unavailable.length}):`];
  for (const budget of unavailable) {
    lines.push(
      `  ${budget.id} — ${budget.specTarget}`,
      `      ${budget.notMeasurableReason ?? ""}`,
    );
  }
  return lines.join("\n");
}
