// The session cost plane's values: the budget state, the unpriced-family cap, the
// principal a turn is attributed to, and the receipt with its three row shapes.
//
// One of the domain modules behind `growth-values/index.ts`. The barrel states the
// rules every value here obeys — why a shape earns a name, what belongs in the
// signature table instead, and what belongs in a module of its own — and publishes
// the whole set. Import from the barrel; this file is the domain's own text.

import type { BillingMode } from "@ai-sidekicks/contracts";

/**
 * Whether a figure is fully priced. Aggregate reuse of the row-level usage vocabulary.
 *
 * A type alias rather than a value list because nothing here enumerates it: the wire
 * supplies the reading and the console renders it, and `Spec-016 §Cost Figure Display
 * Consistency` makes it observability only — a surface that branched enforcement on it
 * would be a second trust regime over a number the daemon already settled.
 */
export type GrowthCostStatus = "priced" | "unpriced";

/**
 * The session's limits and its committed spend, mirrored member-for-member from
 * `OrchestrationBudgetState` in
 * `docs/architecture/contracts/api-payload-contracts.md` (the budget read and update
 * replies carry this same shape, and the cost receipt's session total IS it).
 *
 * Mirrored rather than imported because no code package carries the type — the shape
 * is registered in that document and nowhere else, which is the whole of what this
 * row's slate entry says. The four decomposition members at the end are not new
 * arithmetic: `observedPricedCostCents + observedUnpricedDebitCents` is
 * `observedCostCents`, and `observedCostCents + reservedCostCents` is
 * `committedSpendCents`, which is the enforced figure every surfaced session cost
 * renders — never a sum the renderer takes over a visible run list.
 */
export interface GrowthBudgetState {
  readonly sessionId: string;
  readonly costLimitCents: number;
  readonly turnLimitPerAgent: number;
  readonly maxExecutingChannels: number;
  readonly maxQueueDepthPerChannel: number;
  readonly maxPendingOrchestrationRuns: number;
  readonly activeChildLimit: number;
  readonly unpricedFamilyCaps: readonly GrowthUnpricedFamilyCap[];
  readonly observedCostCents: number;
  readonly reservedCostCents: number;
  readonly observedPricedCostCents: number;
  readonly observedUnpricedDebitCents: number;
  readonly committedSpendCents: number;
  readonly costStatus: GrowthCostStatus;
}

/** One owner-supplied escape for a model family the wire prices at nothing. */
export interface GrowthUnpricedFamilyCap {
  readonly modelFamily: string;
  readonly hardCapUsdCents: number;
}

/**
 * The party a unit of work is attributed to — the turn-scoped effective principal,
 * carried verbatim from the metered rows the receipt folds.
 *
 * Two closed arms with the participant reference required on the participant arm and
 * absent on the system arm, rather than one nullable id: an unstamped value and a
 * deliberately-unattributed one would otherwise be the same shape, and spend no
 * participant caused — a sweep, an idle settlement, a recovery turn — is a real answer
 * rather than a missing one.
 */
export type GrowthEffectivePrincipal =
  | { readonly kind: "participant"; readonly participantId: string }
  | { readonly kind: "system" };

/**
 * The receipt: one session figure, decomposed three ways.
 *
 * Each axis is a PARTITION of the same spend, so each totals to
 * `sessionTotal.committedSpendCents`. A surface asserting that is asserting no row was
 * double-counted or dropped, which is the one property a receipt is for.
 */
export interface GrowthCostReceipt {
  readonly sessionTotal: GrowthBudgetState;
  readonly runs: readonly GrowthCostReceiptRunRow[];
  readonly causedBy: readonly GrowthCostReceiptCausedByRow[];
  readonly byAccount: readonly GrowthCostReceiptAccountRow[];
}

export interface GrowthCostReceiptRunRow {
  readonly runId: string;
  readonly costCents: number;
  readonly costStatus: GrowthCostStatus;
  /**
   * Required and closed at one literal. The receipt is the one surface emitting
   * run-scoped cost figures, and every row carrying the declaration is what makes that
   * verifiable positively rather than by nobody having added a second scope.
   */
  readonly aggregationScope: "run-only";
}

export interface GrowthCostReceiptCausedByRow {
  readonly party: GrowthEffectivePrincipal;
  readonly costCents: number;
  readonly costStatus: GrowthCostStatus;
}

export interface GrowthCostReceiptAccountRow {
  readonly providerAccountId: string;
  readonly displayLabel: string;
  /**
   * How the account is billed. The CONTRACTS type, imported rather than restated.
   *
   * This member used to name a local `GrowthBillingMode` spelling the same three
   * arms, and a closed set with two homes drifts in exactly one direction: the
   * package widens its union, the console still compiles, and the new arm arrives
   * on the wire as a value this surface cannot represent — rendered as whichever
   * label the fallback happens to be, which is a spend claim nothing supports.
   * `provider-account.ts` is where the arms and the reason `unknown` is one of them
   * are stated; there is no second name for them here, because a name here would be
   * the same defect with an alias in front of it.
   */
  readonly billingMode: BillingMode;
  readonly costCents: number;
  readonly costStatus: GrowthCostStatus;
}
