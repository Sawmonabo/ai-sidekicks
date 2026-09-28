// The folds over this pane's reads: what each section renders from, and how far each
// read got.
//
// One sharp claim. `partitionRecords` answers empty for every phase that has not
// answered, which is safe only while its callers render the phase beside it — the
// cases below pin that emptiness as a NON-answer so a caller cannot read it as one.

import { describe, expect, it } from "vitest";

import { type ApprovalRecord } from "../../../bridge/index.js";
import { partitionRecords } from "./approvals-read-fold.js";

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

  it("answers empty while the read has not answered", () => {
    // The emptiness a caller may NOT read as an answer: only an answered read with no
    // rows means "the daemon returned nothing", which is why every caller renders the
    // phase this was folded from beside the arrays.
    expect(partitionRecords({ status: "loading" })).toStrictEqual({ pending: [], history: [] });
  });
});
