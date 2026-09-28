// The cost receipt's one property: each of its three axes partitions the session figure.
//
// The sum is computed and never shown: the renderer produces no cost figure, and the
// verdict is a boolean per axis and nothing else.

import type { ConsoleBridge } from "../../../bridge/index.js";

/** The receipt itself: one session figure, decomposed three ways. */
export type CostReceipt = Extract<
  Awaited<ReturnType<ConsoleBridge["growth"]["orchestrationCostReceiptRead"]>>,
  { readonly status: "served" }
>["value"];

/** One run's line. Derived, so the row type has exactly one home. */
export type CostReceiptRunRow = CostReceipt["runs"][number];

/** One causing party's line. */
export type CostReceiptCausedByRow = CostReceipt["causedBy"][number];

/** One paying account's line. */
export type CostReceiptAccountRow = CostReceipt["byAccount"][number];

/** How an account is charged. Derived off the row so the closed set has one home. */
export type CostReceiptBillingMode = CostReceiptAccountRow["billingMode"];

/**
 * The three axes, in display order.
 *
 * A tuple with the union derived from it, on the console's standing rule for closed
 * sets: the claim is that a receipt has exactly three partitions, and a claim about
 * a count has to be countable at runtime for a test to hold it.
 */
export const RECEIPT_AXIS_IDS = ["runs", "causedBy", "byAccount"] as const;

/** One axis of the decomposition. Derived, never restated. */
export type ReceiptAxisId = (typeof RECEIPT_AXIS_IDS)[number];

/**
 * Whether each axis accounts for the session figure. Total over the axis set, so a
 * fourth axis added upstream is a compile error here rather than an unchecked table.
 */
export type ReceiptPartitionVerdicts = Readonly<Record<ReceiptAxisId, boolean>>;

/**
 * Check each axis against the figure the daemon settled.
 *
 * Exact integer equality, with no tolerance: the wire counts in whole cents, so a
 * partition that misses by one cent has genuinely dropped or double-counted a row,
 * and an epsilon here would be forgiving a defect rather than a rounding this fold
 * does not have. A non-integer or non-finite row cost fails the same way.
 */
export function verifyReceiptPartitions(receipt: CostReceipt): ReceiptPartitionVerdicts {
  const sessionFigureCents = receipt.sessionTotal.committedSpendCents;
  return {
    runs: accountsFor(receipt.runs, sessionFigureCents),
    causedBy: accountsFor(receipt.causedBy, sessionFigureCents),
    byAccount: accountsFor(receipt.byAccount, sessionFigureCents),
  };
}

/**
 * Whether one axis's rows add to the session figure.
 *
 * The running total is local and dies with the call — this is the one place the
 * console adds cost figures together, and nothing it produces reaches a screen.
 */
function accountsFor(
  rows: readonly { readonly costCents: number }[],
  sessionFigureCents: number,
): boolean {
  let axisTotalCents = 0;
  for (const row of rows) {
    axisTotalCents += row.costCents;
  }
  return axisTotalCents === sessionFigureCents;
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
 */
export const BILLING_MODE_CLAUSES: Readonly<Record<CostReceiptBillingMode, string>> = {
  subscription: "Usage included in a plan. This figure is not currency owed.",
  metered: "Billed per unit against this account.",
  unknown: "This account is not labeled, so how it is charged was never established.",
};
