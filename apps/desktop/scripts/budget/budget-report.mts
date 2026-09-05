// What a harness prints about the budgets it did NOT measure — Plan-023 Phase 1C.
//
// Formatting, alone. Every harness prints this block beside its own reading, so
// an ungated budget stays visible instead of being absent from every report —
// which is the state a budget has to be talked out of, not into.
//
// It takes the un-measured rows through a structural port rather than importing
// `ConsoleBudgetRegistry`, and that is load-bearing rather than fastidious: the
// registry re-exports this function, so importing the class here would close a
// cycle that `structure:layering` fails. A caller still passes the registry —
// the interface is the shape the registry already has.

import { type ConsoleBudget } from "./budget-document.mts";

/** The one question this report asks of whatever it is handed. */
export interface UnavailableBudgetSource {
  unavailableBudgets(): readonly ConsoleBudget[];
}

/**
 * One line per budget this revision does not measure, printed by every harness
 * so an ungated budget stays visible instead of being absent from every report.
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
      `      produced by ${budget.producedBy}: ${budget.notMeasurableReason ?? ""}`,
    );
  }
  return lines.join("\n");
}
