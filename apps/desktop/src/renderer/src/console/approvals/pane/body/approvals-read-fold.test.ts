// The folds over this pane's reads, and the one that decides what leaves the pane.
//
// Two claims, and the second is the sharp one. `partitionRecords` answers empty for
// every phase that has not answered, which is safe only while its callers render the
// phase beside it — the cases below pin that emptiness as a NON-answer so a later
// caller cannot read it as one. And `bannerClassRefusalAmong` is what makes a
// vanished session reach the frame from whichever of this pane's three reads noticed
// it first, rather than from the one that happens to be inspected.

import { describe, expect, it } from "vitest";

import { refuse, type ConsoleRefusal } from "../../../core/index.js";
import { type ApprovalRecord } from "../../../bridge/index.js";
import {
  bannerClassRefusalAmong,
  partitionRecords,
  refusalOfPhase,
} from "./approvals-read-fold.js";

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

/** The daemon's answer when the session named by a call is gone. */
const SESSION_GONE: ConsoleRefusal = refuse(
  "growth-port",
  "session.not_found",
  "No session with that id is open on this node.",
);

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

describe("bannerClassRefusalAmong — one handover for one vanished session", () => {
  it("selects a banner-class refusal from a later read, not only the first", () => {
    // The finding: the request list answered and the independent rules read came back
    // saying the session was gone, so the session-wide failure stayed inside one
    // section and the rest of the workspace went on looking live.
    expect(
      bannerClassRefusalAmong([
        refusalOfPhase({ status: "answered", rows: [], unreadableCount: 0 }),
        SESSION_GONE,
      ]),
    ).toBe(SESSION_GONE);
    // And from the third candidate, which is the capability read: a refusal there is
    // as much a fact about the session as one on either projection read.
    expect(bannerClassRefusalAmong([undefined, undefined, SESSION_GONE])).toBe(SESSION_GONE);
  });

  it("prefers the earlier candidate when two reads report the same loss", () => {
    // One fact, one handover. The frame keys a banner on origin AND code, so two
    // reads that noticed the same loss under two origins would otherwise raise two
    // banners saying the same sentence.
    const alsoGone = refuse("approvals", "session.not_found", "The session is gone.");
    expect(bannerClassRefusalAmong([SESSION_GONE, alsoGone])).toBe(SESSION_GONE);
  });

  it("negative control: an ordinary refusal stays the surface's own business", () => {
    // Without this the selector would pass while escalating everything, which would
    // put one pane's read failure across the whole workspace.
    expect(bannerClassRefusalAmong([READ_REFUSED, undefined])).toBeUndefined();
    expect(bannerClassRefusalAmong([undefined, undefined, undefined])).toBeUndefined();
  });
});

describe("refusalOfPhase", () => {
  it("answers only for the phase that carries a reason", () => {
    expect(refusalOfPhase({ status: "refused", refusal: SESSION_GONE })).toBe(SESSION_GONE);
    expect(refusalOfPhase({ status: "not-checked" })).toBeUndefined();
    expect(refusalOfPhase({ status: "loading" })).toBeUndefined();
    expect(refusalOfPhase({ status: "answered", rows: [], unreadableCount: 0 })).toBeUndefined();
  });
});
