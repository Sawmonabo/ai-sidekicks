// What the palette is handed for the approvals pane, and what answering from it sends.
//
// Asserted on the two pure halves rather than through a mounted pane: which rows
// exist is arithmetic over the same values the cards render from, and what a row
// sends is the card's own request. The pane's suite covers the wiring.

import { describe, expect, it, vi } from "vitest";

import { type SessionGoalProjection } from "../../bridge/index.js";
import { type ApprovalRecord } from "../../bridge/index.js";
import {
  approvalCommandRows,
  performApprovalCommand,
  type ApprovalCommandInput,
} from "./approval-commands.js";

const FIRST_REQUEST = "3f6b1c2d-4e5f-4061-8273-9a4b5c6d7e8f";
const SECOND_REQUEST = "4a7c2d3e-5f60-4172-8384-0b5c6d7e8f90";

const GOAL_SET: SessionGoalProjection = {
  status: "set",
  text: "Ship the console",
  revision: "1",
};
const NO_GOAL: SessionGoalProjection = { status: "none", revision: "1" };

/** A pending record carrying the members the rows and the request actually read. */
function pendingRecord(approvalRequestId: string): ApprovalRecord {
  return {
    approvalRequestId,
    runId: "b3f0a1c2-4d5e-4f60-8a71-9c2d3e4f5061",
    category: "file_write",
    state: "pending",
    requestedBy: "agent-ada",
    requestedScope: "session",
    resourceDescriptor: { path: "src/index.ts" },
    createdAt: "2026-09-02T09:00:00.000Z",
    updatedAt: "2026-09-02T09:00:00.000Z",
  };
}

function inputFor(overrides: Partial<ApprovalCommandInput> = {}): ApprovalCommandInput {
  return {
    pending: [pendingRecord(FIRST_REQUEST)],
    resolvingApprovalIds: new Set<string>(),
    resolve: () => undefined,
    goal: NO_GOAL,
    canMutateGoal: false,
    isMutatingGoal: false,
    clearGoal: () => undefined,
    ...overrides,
  };
}

describe("the rows the approvals pane contributes", () => {
  it("offers both answers for each pending record", () => {
    const rows = approvalCommandRows(inputFor());

    expect(rows.map((row) => row.kind)).toEqual(["approve", "reject"]);
    expect(rows[0]?.title).toBe("Approve the pending request");
  });

  it("names the record once there are two waiting", () => {
    const rows = approvalCommandRows(
      inputFor({ pending: [pendingRecord(FIRST_REQUEST), pendingRecord(SECOND_REQUEST)] }),
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

  it("offers the goal clear only where a goal is set and the role may mutate it", () => {
    const offered = approvalCommandRows(inputFor({ goal: GOAL_SET, canMutateGoal: true }));
    const readOnly = approvalCommandRows(inputFor({ goal: GOAL_SET, canMutateGoal: false }));
    const empty = approvalCommandRows(inputFor({ goal: NO_GOAL, canMutateGoal: true }));
    const settling = approvalCommandRows(
      inputFor({ goal: GOAL_SET, canMutateGoal: true, isMutatingGoal: true }),
    );

    expect(offered.some((row) => row.kind === "clear-goal")).toBe(true);
    expect(readOnly.some((row) => row.kind === "clear-goal")).toBe(false);
    expect(empty.some((row) => row.kind === "clear-goal")).toBe(false);
    expect(settling.some((row) => row.kind === "clear-goal")).toBe(false);
  });
});

describe("what answering from the palette sends", () => {
  it("sends the requested scope and mints no remembered rule", () => {
    const resolve = vi.fn();
    const record = pendingRecord(FIRST_REQUEST);

    performApprovalCommand(
      { kind: "approve", record, title: "Approve the pending request" },
      inputFor({ resolve }),
    );

    expect(resolve).toHaveBeenCalledWith({
      approvalRequestId: FIRST_REQUEST,
      decision: "approved",
      effectiveScope: "session",
    });
  });

  it("sends the rejected decision on the reject row", () => {
    const resolve = vi.fn();

    performApprovalCommand(
      { kind: "reject", record: pendingRecord(FIRST_REQUEST), title: "Reject the pending request" },
      inputFor({ resolve }),
    );

    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ decision: "rejected" }));
  });

  it("answers nothing for a record the read no longer returns as pending", () => {
    const resolve = vi.fn();

    performApprovalCommand(
      { kind: "approve", record: pendingRecord(SECOND_REQUEST), title: "Approve" },
      inputFor({ resolve }),
    );

    expect(resolve).not.toHaveBeenCalled();
  });

  it("clears the goal only while the role may mutate it", () => {
    const clearGoal = vi.fn();
    const row = { kind: "clear-goal", record: undefined, title: "Clear the session goal" } as const;

    performApprovalCommand(row, inputFor({ goal: GOAL_SET, canMutateGoal: false, clearGoal }));
    expect(clearGoal).not.toHaveBeenCalled();

    performApprovalCommand(row, inputFor({ goal: GOAL_SET, canMutateGoal: true, clearGoal }));
    expect(clearGoal).toHaveBeenCalledTimes(1);
  });
});
