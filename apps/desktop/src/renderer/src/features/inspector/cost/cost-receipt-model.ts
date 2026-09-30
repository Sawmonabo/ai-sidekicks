// The cost receipt's one property: every figure on it adds up to the one above it.
//
// Each provider's account rows and its voice row add to that provider's subtotal, and
// the subtotals add to the session's committed spend. The sums are computed and never
// shown: the renderer produces no cost figure, and the verdict is a boolean per level
// and nothing else.

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
 * Exact integer equality, with no tolerance: the wire counts in whole micro-dollars,
 * so a partition that misses by one has genuinely dropped or double-counted a row, and
 * an epsilon here would be forgiving a defect rather than a rounding this fold does
 * not have.
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

/**
 * The sum of one level's figures.
 *
 * The running total is local and dies with the call — this is the one place the
 * console adds cost figures together, and nothing it produces reaches a screen.
 */
function sumOf(usdMicros: readonly number[]): number {
  let total = 0;
  for (const figure of usdMicros) {
    total += figure;
  }
  return total;
}

/**
 * The one clause each billing mode puts beside a figure on its own row.
 *
 * The accounts page owns the VOCABULARY — what each mode means as a term — and this
 * is not a second copy of it: it is the clause that stops one figure being misread
 * in the cell it sits in, which is why it is worded about the figure rather than
 * about the mode. `subscription` is the row it exists for — usage inside a plan is
 * not currency owed, and a money figure with nothing beside it says the opposite.
 *
 * TOTAL over the wire's own set, so a fourth mode landing upstream is a compile
 * error here rather than a figure that quietly loses its clause.
 *
 * @consumedBy the inspector's cost section
 */
export const BILLING_MODE_CLAUSES: Readonly<Record<BillingMode, string>> = {
  subscription: "Usage included in a plan. This figure is not currency owed.",
  metered: "Billed per unit against this account.",
  unknown: "This account is not labeled, so how it is charged was never established.",
};
