// A run's or a step's cost as the screen reads it: the cost itself in the one money format, and
// the account that paid. A run or step that spent nothing reads `$0.00` and names no account. The
// daemon sums a run's cost from its steps' stored amounts; nothing here adds figures.

import type { WorkflowCost } from "@ai-sidekicks/contracts/workflow/run/run";

import { formatMoney } from "#renderer/lib/wire/figures.js";

/** How many micro-dollars make a dollar. */
const MICROS_PER_DOLLAR = 1_000_000;

/** The cost alone, `$0.1865` or `$7.30`; `$0.00` where nothing was spent. */
export function costFigure(cost: WorkflowCost | undefined): string {
  return formatMoney((cost?.usdMicros ?? 0) / MICROS_PER_DOLLAR);
}

/**
 * The cost and the account that paid, `$7.30 · Work account`. An account the registry no
 * longer lists is named by its id, since a cost with no payer would read as free.
 */
export function costWithPayer(
  cost: WorkflowCost | undefined,
  accountLabel: (providerAccountId: string) => string | undefined,
): string {
  if (cost === undefined) {
    return costFigure(undefined);
  }
  const payer = accountLabel(cost.providerAccountId) ?? cost.providerAccountId;
  return `${costFigure(cost)} · ${payer}`;
}
