// What the palette is handed for the approval card, and what answering from it sends.
//
// Asserted on the two pure halves rather than through a mounted card: which rows
// exist is arithmetic over the same values the cards render from, and what a row
// sends is the card's own request. The hook's suite covers the registration.

import { describe, expect, it, vi } from "vitest";

import type { ApprovalProjectionRow } from "@ai-sidekicks/contracts";

import { refuse, type Refusal } from "@renderer/lib/refusal.js";
import { isAcceptedAnswer, pendingRecord } from "../approval-record.test-support.js";
import {
  approvalCommandRows,
  performApprovalCommand,
  type ApprovalCommandInput,
} from "./approval-commands.js";

const FIRST_REQUEST = "3f6b1c2d-4e5f-4061-8273-9a4b5c6d7e8f";
const SECOND_REQUEST = "4a7c2d3e-5f60-4172-8384-0b5c6d7e8f90";

/** The pending ask with the id named. */
function pendingAsk(id: string): ApprovalProjectionRow {
  return pendingRecord({ id });
}

/** The refusal that says somebody else answered: `settled` in the shared table. */
function alreadyResolved(approvalRequestId: string): ReadonlyMap<string, Refusal> {
  return new Map([
    [
      approvalRequestId,
      refuse("approvals", "approval.already_resolved", "this request was already answered"),
    ],
  ]);
}

function inputFor(overrides: Partial<ApprovalCommandInput> = {}): ApprovalCommandInput {
  return {
    pending: [pendingAsk(FIRST_REQUEST)],
    resolvingApprovalIds: new Set<string>(),
    resolveRefusalByApprovalId: new Map<string, Refusal>(),
    resolve: () => undefined,
    ...overrides,
  };
}

describe("the rows the approval card contributes", () => {
  it("offers both answers for each pending record", () => {
    const rows = approvalCommandRows(inputFor());

    expect(rows.map((row) => row.kind)).toEqual(["approve", "reject"]);
    expect(rows[0]?.title).toBe("Approve the pending request");
  });

  it("names the record once there are two waiting", () => {
    const rows = approvalCommandRows(
      inputFor({ pending: [pendingAsk(FIRST_REQUEST), pendingAsk(SECOND_REQUEST)] }),
    );

    expect(rows.map((row) => row.title)).toEqual([
      `Approve request ${FIRST_REQUEST}`,
      `Reject request ${FIRST_REQUEST}`,
      `Approve request ${SECOND_REQUEST}`,
      `Reject request ${SECOND_REQUEST}`,
    ]);
  });

  it("offers nothing for a record whose answer is already in flight", () => {
    const rows = approvalCommandRows(inputFor({ resolvingApprovalIds: new Set([FIRST_REQUEST]) }));

    expect(rows).toEqual([]);
  });

  it("offers nothing for a record a SETTLED refusal already answered", () => {
    // The card takes both buttons off on `approval.already_resolved` — somebody else
    // answered — so the two palette rows go with them. One reading serves card and palette:
    // withholding this map is what left the palette offering a decision about a
    // request that was no longer waiting.
    const rows = approvalCommandRows(
      inputFor({ resolveRefusalByApprovalId: alreadyResolved(FIRST_REQUEST) }),
    );

    expect(rows).toEqual([]);
  });

  it("negative control: an unsettled refusal leaves both rows, since the act may work", () => {
    const rows = approvalCommandRows(
      inputFor({
        resolveRefusalByApprovalId: new Map([
          [FIRST_REQUEST, refuse("approvals", "session.goal_delivery_failed", "nothing landed")],
        ]),
      }),
    );

    expect(rows.map((row) => row.kind)).toEqual(["approve", "reject"]);
  });
});

describe("what answering from the palette sends", () => {
  it("sends the card's own answer and mints no remembered rule", () => {
    const resolve = vi.fn();
    const record = pendingAsk(FIRST_REQUEST);

    performApprovalCommand(
      { kind: "approve", record, title: "Approve the pending request" },
      inputFor({ resolve }),
    );

    expect(resolve).toHaveBeenCalledWith({
      approvalRequestId: FIRST_REQUEST,
      decision: "approved",
      clientResolutionId: expect.any(String),
    });
    expect(isAcceptedAnswer(resolve.mock.calls[0]?.[0])).toBe(true);
  });

  it("sends the rejected decision on the reject row", () => {
    const resolve = vi.fn();

    performApprovalCommand(
      { kind: "reject", record: pendingAsk(FIRST_REQUEST), title: "Reject the pending request" },
      inputFor({ resolve }),
    );

    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ decision: "rejected" }));
  });

  it("answers nothing for a record a settled refusal reached after the row was built", () => {
    // The row leaves the palette on the next contribution, and a press can land in
    // the gap. The invoke path re-reads the same offer, so it cannot send a decision
    // the card has already withdrawn.
    const resolve = vi.fn();

    performApprovalCommand(
      { kind: "approve", record: pendingAsk(FIRST_REQUEST), title: "Approve" },
      inputFor({ resolve, resolveRefusalByApprovalId: alreadyResolved(FIRST_REQUEST) }),
    );

    expect(resolve).not.toHaveBeenCalled();
  });

  it("answers nothing for a record the read no longer returns as pending", () => {
    const resolve = vi.fn();

    performApprovalCommand(
      { kind: "approve", record: pendingAsk(SECOND_REQUEST), title: "Approve" },
      inputFor({ resolve }),
    );

    expect(resolve).not.toHaveBeenCalled();
  });
});
