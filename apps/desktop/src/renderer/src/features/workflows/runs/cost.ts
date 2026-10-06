// A run's or a step's cost as the screen reads it: the cost itself in the one money format, and
// the account that paid. A run or step that spent nothing reads `$0.00` and names no account. The
// daemon sums a run's cost from its steps' stored amounts; nothing here adds figures.

import type { WorkflowCost } from "@ai-sidekicks/contracts/workflow/run/step/record";

import { formatMoney } from "#renderer/lib/wire/figures.js";

/** How many micro-dollars make a dollar. */
const MICROS_PER_DOLLAR = 1_000_000;

/**
 * What the account registry says about the account a cost was paid from: not read yet, read
 * without it because it was removed, or listed with the label it is named by.
 */
export type PayerReading =
  | { readonly kind: "unread" }
  | { readonly kind: "removed" }
  | { readonly kind: "listed"; readonly label: string };

/** The cost alone, `$0.1865` or `$7.30`; `$0.00` where nothing was spent. */
export function costFigure(cost: WorkflowCost | undefined): string {
  return formatMoney((cost?.usdMicros ?? 0) / MICROS_PER_DOLLAR);
}

/**
 * The cost and the account that paid, `$7.30 · sam@example.com · Max`, or `$7.30 · Removed
 * account` for a payer the read registry no longer lists. Never the account's id: before the
 * registry is read it is the cost alone.
 */
export function costWithPayer(
  cost: WorkflowCost | undefined,
  payerOf: (providerAccountId: string) => PayerReading,
): string {
  if (cost === undefined) {
    return costFigure(undefined);
  }
  const payer = payerOf(cost.providerAccountId);
  const payerWords =
    payer.kind === "removed"
      ? "Removed account"
      : payer.kind === "listed"
        ? payer.label
        : undefined;
  return payerWords === undefined ? costFigure(cost) : `${costFigure(cost)} · ${payerWords}`;
}
