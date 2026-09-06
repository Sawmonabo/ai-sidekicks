// What the cost model is for: answering whether each axis accounts for the figure.
//
// Its cents-to-money adapter is no longer here — it is `primitives/wire-figures.ts`'
// now that a second view family renders the same accountant's figure — and its cases
// moved with it, which is what keeps a formatter's rules asserted beside the
// formatter rather than beside one of its callers.
//
// The partition check is the case worth the most. A receipt whose axes do not add up
// is not a cosmetic defect — it is a row counted twice or a row dropped, and both
// render identically to a table that never checked. So each arm is asserted per
// axis rather than as one verdict, because an all-or-nothing answer would hide
// which split is wrong from the surface that has to withhold exactly that one.

import { describe, expect, it } from "vitest";

import {
  RECEIPT_AXIS_IDS,
  verifyReceiptPartitions,
  type CostReceipt,
} from "./cost-receipt-model.js";

/**
 * A budget state whose decomposition members agree with each other.
 *
 * The shape declares two arithmetic identities — priced plus unpriced is observed,
 * and observed plus reserved is committed — so a fixture that ignored them would be
 * testing the verification against a state the accountant could never emit.
 */
function budgetState(committedSpendCents: number): CostReceipt["sessionTotal"] {
  return {
    sessionId: "session-cost",
    costLimitCents: 500_000,
    turnLimitPerAgent: 40,
    maxExecutingChannels: 4,
    maxQueueDepthPerChannel: 8,
    maxPendingOrchestrationRuns: 6,
    activeChildLimit: 2,
    unpricedFamilyCaps: [],
    observedCostCents: committedSpendCents,
    reservedCostCents: 0,
    observedPricedCostCents: committedSpendCents,
    observedUnpricedDebitCents: 0,
    committedSpendCents,
    costStatus: "priced",
  };
}

/** A receipt whose three axes each carry the costs they are handed. */
function receipt(options: {
  readonly committedSpendCents: number;
  readonly runCosts: readonly number[];
  readonly causedByCosts: readonly number[];
  readonly accountCosts: readonly number[];
}): CostReceipt {
  return {
    sessionTotal: budgetState(options.committedSpendCents),
    runs: options.runCosts.map((costCents, index) => ({
      runId: `run-${String(index + 1)}`,
      costCents,
      costStatus: "priced",
      aggregationScope: "run-only",
    })),
    causedBy: options.causedByCosts.map((costCents, index) => ({
      party: { kind: "participant", participantId: `participant-${String(index + 1)}` },
      costCents,
      costStatus: "priced",
    })),
    byAccount: options.accountCosts.map((costCents, index) => ({
      providerAccountId: `account-${String(index + 1)}`,
      displayLabel: `Account ${String(index + 1)}`,
      billingMode: "metered",
      costCents,
      costStatus: "priced",
    })),
  };
}

/** A receipt whose three axes all account for the same figure. */
function balancedReceipt(): CostReceipt {
  return receipt({
    committedSpendCents: 1_000,
    runCosts: [600, 400],
    causedByCosts: [700, 300],
    accountCosts: [1_000],
  });
}

describe("verifyReceiptPartitions — each axis accounts for the whole figure, or it does not", () => {
  it("answers for every declared axis and nothing else", () => {
    const verdicts = verifyReceiptPartitions(balancedReceipt());
    expect(Object.keys(verdicts).sort()).toStrictEqual([...RECEIPT_AXIS_IDS].sort());
  });

  it("passes a receipt whose three axes each add to the session figure", () => {
    expect(verifyReceiptPartitions(balancedReceipt())).toStrictEqual({
      runs: true,
      causedBy: true,
      byAccount: true,
    });
  });

  it("fails only the axis that dropped a row", () => {
    // A dropped row is the under-count arm: the split no longer accounts for the
    // figure, and the two axes beside it still do. Asserting all three is what makes
    // this a per-axis verdict rather than one that condemns the whole receipt.
    const verdicts = verifyReceiptPartitions(
      receipt({
        committedSpendCents: 1_000,
        runCosts: [600],
        causedByCosts: [700, 300],
        accountCosts: [1_000],
      }),
    );
    expect(verdicts).toStrictEqual({ runs: false, causedBy: true, byAccount: true });
  });

  it("fails the axis that counted a row twice", () => {
    // The over-count arm, which a check written as "no row exceeds the total" would
    // miss entirely. One cent over is still over.
    const verdicts = verifyReceiptPartitions(
      receipt({
        committedSpendCents: 1_000,
        runCosts: [600, 400],
        causedByCosts: [700, 300],
        accountCosts: [1_000, 1],
      }),
    );
    expect(verdicts).toStrictEqual({ runs: true, causedBy: true, byAccount: false });
  });

  it("passes empty axes when the figure itself is nothing", () => {
    // A session that has spent nothing is a real answer, and its three empty splits
    // do account for it. The page renders the figure and three empty tables.
    expect(
      verifyReceiptPartitions(
        receipt({ committedSpendCents: 0, runCosts: [], causedByCosts: [], accountCosts: [] }),
      ),
    ).toStrictEqual({ runs: true, causedBy: true, byAccount: true });
  });

  it("negative control: empty axes fail when the figure is not nothing", () => {
    // Without this, the case above would pass over a check that answered `true` for
    // any empty list — which would let a receipt charging a session render three
    // empty tables and call the decomposition sound.
    expect(
      verifyReceiptPartitions(
        receipt({ committedSpendCents: 1_000, runCosts: [], causedByCosts: [], accountCosts: [] }),
      ),
    ).toStrictEqual({ runs: false, causedBy: false, byAccount: false });
  });
});
