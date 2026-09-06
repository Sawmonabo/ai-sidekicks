// One offer reading, two surfaces: the card's answers and the pane's palette rows.
//
// A refusal the shared remedy table marks `settled` means the request was answered
// somewhere else, so every further press earns the same refusal and the next
// projection read drops the record entirely. The card withdraws its two buttons on
// that, and the palette has to withdraw the two rows for the same record in the same
// breath — which is why `approvals/pane/approval-offer.ts` is ONE function that both
// call rather than two that happen to agree. This suite is the proof of the pair:
// the card and the row builder are asserted against the same record and the same
// refusal, so a change that withdraws one and not the other is red here.

import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { refuse, type ConsoleRefusal } from "../../../core/index.js";
import { approvalCommandRows, type ApprovalCommandInput } from "../approval-commands.js";
import { pendingRecord, renderCard } from "./approval-card.test-support.js";

const ALREADY_RESOLVED: ConsoleRefusal = refuse(
  "approvals",
  "approval.already_resolved",
  "Answered elsewhere.",
);
const RETRYABLE: ConsoleRefusal = refuse(
  "approvals",
  "approval.decision_conflict",
  "Two answers raced.",
);

/** The palette's view of one record and one refusal against it. */
function rowsFor(refusalForRecord: ConsoleRefusal): ApprovalCommandInput {
  const record = pendingRecord();
  return {
    pending: [record],
    resolvingApprovalIds: new Set<string>(),
    resolveRefusalByApprovalId: new Map([[record.approvalRequestId, refusalForRecord]]),
    resolve: () => undefined,
    goal: { status: "none", revision: "1" },
    canMutateGoal: false,
    isMutatingGoal: false,
    clearGoal: () => undefined,
  };
}

describe("a refusal that settles the request takes the answers off the card", () => {
  it("withdraws both actions once somebody else answered", () => {
    // `approval.already_resolved` is settled: pressing Approve again can only be
    // refused again, and a card that keeps offering it is offering an act that
    // cannot work.
    renderCard(
      pendingRecord(),
      false,
      refuse("approvals", "approval.already_resolved", "Answered elsewhere."),
    );

    expect(screen.queryByRole("toolbar", { name: "Answer this request" })).toBeNull();
    expect(screen.getByText("approval.already_resolved")).not.toBeNull();
  });

  it("keeps the answers where the refusal leaves the same act admissible", () => {
    // The negative control: a refusal is not by itself a reason to take a control
    // away, and withdrawing on every one would strand a person on a retryable
    // failure.
    renderCard(
      pendingRecord(),
      false,
      refuse("approvals", "approval.decision_conflict", "Two answers raced."),
    );

    expect(screen.queryByRole("toolbar", { name: "Answer this request" })).not.toBeNull();
  });

  it("says what happens next beside the withdrawn actions", () => {
    renderCard(
      pendingRecord(),
      false,
      refuse("approvals", "approval.already_resolved", "Answered elsewhere."),
    );

    expect(screen.getByText(/leaves the list on the next read/)).not.toBeNull();
  });
});

describe("the palette withdraws exactly where the card does", () => {
  it("offers neither a card action nor a palette row once the request is settled", () => {
    // The pair. Before one shared reading, the card withdrew and the palette did
    // not — so a request somebody else had answered kept two rows, and pressing one
    // sent a decision about a request that was no longer waiting.
    renderCard(pendingRecord(), false, ALREADY_RESOLVED);

    expect(screen.queryByRole("toolbar", { name: "Answer this request" })).toBeNull();
    expect(approvalCommandRows(rowsFor(ALREADY_RESOLVED))).toEqual([]);
  });

  it("negative control: both keep offering where the same act is still admissible", () => {
    renderCard(pendingRecord(), false, RETRYABLE);

    expect(screen.queryByRole("toolbar", { name: "Answer this request" })).not.toBeNull();
    expect(approvalCommandRows(rowsFor(RETRYABLE)).map((row) => row.kind)).toEqual([
      "approve",
      "reject",
    ]);
  });
});
