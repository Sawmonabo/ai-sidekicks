// The card and the palette rows are asserted against the same record and refusal, so a change
// that withdraws one and not the other is red here. A `settled` refusal means the request was
// answered elsewhere.

import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { refuse, type Refusal } from "@renderer/lib/refusal.js";
import {
  approvalCommandRows,
  type ApprovalCommandInput,
} from "../contributions/approval-commands.js";
import { pendingRecord } from "../approval-record.test-support.js";
import { renderCard } from "./approval-card.test-support.js";

const ALREADY_RESOLVED: Refusal = refuse(
  "approvals",
  "approval.already_resolved",
  "Answered elsewhere.",
);
const RETRYABLE: Refusal = refuse("approvals", "approval.decision_conflict", "Two answers raced.");

/** The palette's view of one record and one refusal against it. */
function rowsFor(refusalForRecord: Refusal): ApprovalCommandInput {
  const record = pendingRecord();
  return {
    pending: [record],
    resolvingApprovalIds: new Set<string>(),
    resolveRefusalByApprovalId: new Map([[record.id, refusalForRecord]]),
    resolve: () => undefined,
  };
}

describe("a refusal that settles the request takes the answers off the card", () => {
  it("withdraws both actions once somebody else answered", () => {
    // Settled: pressing Approve again can only be refused again.
    renderCard(
      pendingRecord(),
      false,
      refuse("approvals", "approval.already_resolved", "Answered elsewhere."),
    );

    expect(screen.queryByRole("toolbar", { name: "Answer this request" })).toBeNull();
    expect(screen.getByText("approval.already_resolved")).not.toBeNull();
  });

  it("keeps the answers where the refusal leaves the same act admissible", () => {
    // Negative control: withdrawing on every refusal would strand a person on a retryable failure.
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
    // The pair: the card and the palette must withdraw together.
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
