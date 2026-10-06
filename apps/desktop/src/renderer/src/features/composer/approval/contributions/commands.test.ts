// Asserted on the two pure halves rather than a mounted card: which record a row names, and what
// a row sends (the card's own request).

import { describe, expect, it, vi } from "vitest";

import type { ApprovalProjectionRow } from "@ai-sidekicks/contracts/approval";

import { type Refusal } from "#renderer/lib/refusal/contract.js";
import { isAcceptedAnswer, pendingRecord } from "../record.test-support.js";
import {
  approvalCommandRows,
  performApprovalCommand,
  type ApprovalCommandInput,
} from "./commands.js";

const FIRST_REQUEST = "3f6b1c2d-4e5f-4061-8273-9a4b5c6d7e8f";
const SECOND_REQUEST = "4a7c2d3e-5f60-4172-8384-0b5c6d7e8f90";

/** The pending ask with the id named. */
function pendingAsk(id: string): ApprovalProjectionRow {
  return pendingRecord({ id });
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
  it("names the record once there are two waiting", () => {
    const rows = approvalCommandRows(
      inputFor({ pending: [pendingAsk(FIRST_REQUEST), pendingAsk(SECOND_REQUEST)] }),
    );

    expect(rows.map((row) => row.title)).toEqual([
      `Approve request ${FIRST_REQUEST} once`,
      `Decline request ${FIRST_REQUEST}`,
      `Approve request ${SECOND_REQUEST} once`,
      `Decline request ${SECOND_REQUEST}`,
    ]);
  });
});

describe("what answering from the palette sends", () => {
  it("sends the card's own answer and mints no remembered rule", () => {
    const resolve = vi.fn();
    const record = pendingAsk(FIRST_REQUEST);

    performApprovalCommand(
      { kind: "approve", record, title: "Approve the pending request once" },
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
      { kind: "reject", record: pendingAsk(FIRST_REQUEST), title: "Decline the pending request" },
      inputFor({ resolve }),
    );

    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ decision: "rejected" }));
  });
});
