// The cost receipt's one property: every figure adds up to the one above it. The sums are
// computed and never shown; the verdict is a boolean per level.

import type { BillingMode, SessionCostReceipt } from "@ai-sidekicks/contracts";

/** Whether each level of the receipt accounts for the level above it. */
export interface ReceiptPartitionVerdicts {
  /** Every provider's accounts and voice add to that provider's subtotal. */
  readonly providerSubtotals: boolean;
  /** The provider subtotals add to the session's committed spend. */
  readonly sessionTotal: boolean;
}

/**
 * Check each level of the receipt against the figure the daemon settled.
 *
 * Exact integer equality with no tolerance: the wire counts whole micro-dollars, so a miss by
 * one is a dropped or double-counted row, not rounding.
 */
export function verifyReceiptPartitions(receipt: SessionCostReceipt): ReceiptPartitionVerdicts {
  return {
    providerSubtotals: receipt.providers.every(
      (provider) =>
        sumOf(provider.accounts.map((account) => account.usdMicros)) +
          (provider.voice?.usdMicros ?? 0) ===
        provider.subtotalUsdMicros,
    ),
    sessionTotal:
      sumOf(receipt.providers.map((provider) => provider.subtotalUsdMicros)) ===
      receipt.sessionTotal.committedSpendUsdMicros,
  };
}

/** The sum of one level's figures. The total is local and never reaches a screen. */
function sumOf(usdMicros: readonly number[]): number {
  let total = 0;
  for (const figure of usdMicros) {
    total += figure;
  }
  return total;
}

/**
 * The clause each billing mode puts beside a figure on its own row.
 *
 * Worded about the figure, not the mode, so it stops one figure being misread in its cell: a
 * subscription's usage is not currency owed. Total over the wire's set, so a new mode is a
 * compile error here.
 *
 * @consumedBy the inspector's cost section
 */
export const BILLING_MODE_CLAUSES: Readonly<Record<BillingMode, string>> = {
  subscription: "Usage included in a plan. This figure is not currency owed.",
  metered: "Billed per unit against this account.",
  unknown: "This account is not labeled, so how it is charged was never established.",
};
