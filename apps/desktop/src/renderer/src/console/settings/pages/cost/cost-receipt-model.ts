// The receipt's one property, and the only arithmetic the cost page is allowed.
//
// A receipt is answerable rather than merely itemised because each of its three
// axes is a PARTITION of the same figure: every row belongs to exactly one bucket
// on each axis, and the buckets together account for the whole. `GrowthCostReceipt`
// states that identity in its own comment — each axis totals to
// `sessionTotal.committedSpendCents` — and a surface that renders three tables
// without ever checking it is a surface that would render a double-counted row and
// a dropped row identically.
//
// THE SUM IS COMPUTED AND NEVER SHOWN
//
// This is the distinction the page's own rules turn on. `Spec-023 §Console Design
// (Meridian)`'s cost section forbids the renderer producing a figure — the
// accountant produces the number a session is charged, and a table that added its
// own column up would be a second accountant reaching a second answer. What happens
// here is not that: the total is compared against the one the daemon sent and then
// discarded. No caller can render it, because none is returned — the verdict is a
// boolean per axis and nothing else. That is deliberate, and it is why this
// verification is not the arithmetic the page forbids.
//
// WHERE THE CENTS FORMATTER WENT
//
// `formatCentsAsCurrency` was declared here while this page was its only reader. The
// session cast bar renders the same committed figure from the same accountant, and
// `workspace/` and `settings/` are sibling view families that may not import each
// other — so the adapter is hoisted to `console/primitives/wire-figures.ts`, which
// `apps/desktop/AGENTS.md` already makes the one module that formats a wire value.
// What it added was the unit conversion, which is a fact about the receipt's wire
// shape; that fact now sits beside the money formatter it adapts, where both readers
// reach it and neither owns it.

import type { ConsoleBridge } from "../../../bridge/index.js";
import type { GrowthReading } from "../../../bridge/index.js";
import { formatCount } from "../../../primitives/index.js";

/**
 * What one `orchestrationCostReceiptRead` call answers.
 *
 * Derived off the port rather than restated, on `collaboration/invites/SentInvites.tsx`'s
 * rule: the bridge door exports the bridge and not the port's vocabulary, and a
 * hand-written copy of a reply shape is a second declaration nothing checks against
 * the first.
 */
export type CostReceiptOutcome = Awaited<
  ReturnType<ConsoleBridge["growth"]["orchestrationCostReceiptRead"]>
>;

/** What the page holds for one read. See {@link GrowthReading} for the second arm. */
export type CostReceiptReading = GrowthReading<CostReceiptOutcome>;

/** The receipt itself: one session figure, decomposed three ways. */
export type CostReceipt = Extract<CostReceiptOutcome, { readonly status: "served" }>["value"];

/** One run's line. Derived, so the row type has exactly one home. */
export type CostReceiptRunRow = CostReceipt["runs"][number];

/** One causing party's line. */
export type CostReceiptCausedByRow = CostReceipt["causedBy"][number];

/** One paying account's line. */
export type CostReceiptAccountRow = CostReceipt["byAccount"][number];

/** How an account is charged. Derived off the row so the closed set has one home. */
export type CostReceiptBillingMode = CostReceiptAccountRow["billingMode"];

/**
 * The three axes, in the order the page renders them.
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
 * does not have. A non-integer or non-finite row cost fails the same way, which is
 * the honest outcome — the page then withholds that table rather than presenting
 * rows it cannot vouch for.
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
  unknown: "This account is not labelled, so how it is charged was never established.",
};

/**
 * What a settled read says out loud, once.
 *
 * A refusal is carried VERBATIM — the daemon's own sentence, never paraphrased and
 * never softened into a house phrasing that would say less than what was refused.
 * The served arm names what was read and how many rows each split holds, phrased so
 * no count needs a plural: "0 by run" and "1 by run" both read as English.
 */
export function announcementFor(outcome: CostReceiptOutcome): string {
  if (outcome.status === "unavailable") {
    return outcome.detail;
  }
  const { runs, causedBy, byAccount } = outcome.value;
  return `Cost receipt read. Rows: ${formatCount(runs.length)} by run, ${formatCount(causedBy.length)} by party, ${formatCount(byAccount.length)} by account.`;
}
