// The folds over this pane's reads: what each section renders from, and how far each
// read got.
//
// One sharp claim. `partitionRecords` answers empty for every phase that has not
// answered, which is safe only while its callers render the phase beside it — the
// cases below pin that emptiness as a NON-answer so a later caller cannot read it as
// one. WHICH refusal leaves the pane is no longer decided here: that selection is
// `store/refusal-escalation.ts`' `preferredBannerClassRefusalAmong`, and its cases
// live beside it.

import { describe, expect, it } from "vitest";

import { refuse, type ConsoleRefusal } from "../../../core/index.js";
import { type ApprovalRecord } from "../../../bridge/index.js";
import { partitionRecords, refusalOfPhase } from "./approvals-read-fold.js";

/** A record in the state named, in the shape the console holds. */
function record(approvalRequestId: string, state: ApprovalRecord["state"]): ApprovalRecord {
  return {
    approvalRequestId,
    runId: "019b7a33-3300-740e-8110-d1a4c1150511",
    requestedBy: "019b7a33-3300-7a6e-8110-d1a4c1150501",
    category: "file_write",
    requestedScope: "run",
    resourceDescriptor: { path: "packages/contracts/src/approval.ts" },
    state,
    createdAt: "2026-01-01T13:30:00.900Z",
    updatedAt: "2026-01-01T13:30:00.900Z",
  };
}

/** A refusal whose blast radius is the surface that raised it. */
const READ_REFUSED: ConsoleRefusal = refuse(
  "approvals",
  "call-rejected",
  "The approvals projection read did not complete.",
);

describe("partitionRecords — one answered read, split in two", () => {
  it("puts every returned record in exactly one list", () => {
    const partitioned = partitionRecords({
      status: "answered",
      rows: [record("a", "pending"), record("b", "approved"), record("c", "pending")],
      unreadableCount: 0,
    });
    expect(partitioned.pending.map((row) => row.approvalRequestId)).toStrictEqual(["a", "c"]);
    expect(partitioned.history.map((row) => row.approvalRequestId)).toStrictEqual(["b"]);
  });

  it("answers empty for every phase that has not answered", () => {
    // The emptiness a caller may NOT read as an answer. Three phases produce it and
    // only one of them means "the daemon returned nothing", which is why every caller
    // renders the phase this was folded from beside the arrays.
    for (const phase of [
      { status: "not-checked" },
      { status: "loading" },
      { status: "refused", refusal: READ_REFUSED },
    ] as const) {
      expect(partitionRecords(phase)).toStrictEqual({ pending: [], history: [] });
    }
  });
});

describe("refusalOfPhase", () => {
  it("answers only for the phase that carries a reason", () => {
    expect(refusalOfPhase({ status: "refused", refusal: READ_REFUSED })).toBe(READ_REFUSED);
    expect(refusalOfPhase({ status: "not-checked" })).toBeUndefined();
    expect(refusalOfPhase({ status: "loading" })).toBeUndefined();
    expect(refusalOfPhase({ status: "answered", rows: [], unreadableCount: 0 })).toBeUndefined();
  });
});
