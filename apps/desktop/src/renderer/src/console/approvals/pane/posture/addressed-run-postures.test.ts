// Which run a decision is about, and whether the pane can say what it ran under.
//
// The failure each case guards is the same shape: a pane with no run of its own
// inventing one. It has exactly one honest source — every approval record carries
// the `runId` that raised it — and this module is the whole of the derivation, so a
// case here is the only place the rule can be held.

import type { ExecutionPosture } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import type { ApprovalRecord } from "../../../bridge/index.js";
import type { ConsoleEntity } from "../../../store/index.js";
import { addressedRunPostures } from "./addressed-run-postures.js";

const RUN_A = "019b7a33-3300-740e-8110-d1a4c115051a";
const RUN_B = "019b7a33-3300-740e-8110-d1a4c115051b";

const POSTURE: ExecutionPosture = {
  mode: "readonly-sandboxed",
  networkAccess: "none",
  writableRoots: [],
  credentialPolicyRef: "sha256:4f2c8a17d3e05b96c84f2c8a17d3e05b96c84f2c8a17d3e05b96c84f2c8a17d3",
};

function record(runId: string, approvalRequestId: string): ApprovalRecord {
  return {
    approvalRequestId,
    runId,
    category: "file_write",
    state: "pending",
    requestedBy: "agent-implementer",
    requestedScope: "session",
    resourceDescriptor: { path: "/Users/dev/code/one" },
    createdAt: "2026-01-01T13:30:00.200Z",
    updatedAt: "2026-01-01T13:30:00.200Z",
  };
}

/** A run entity whose body carries the stamp, as the projector writes it. */
function runEntity(runId: string, posture: ExecutionPosture | undefined): ConsoleEntity {
  return {
    kind: "run",
    id: runId,
    body: posture === undefined ? {} : { executionPosture: posture },
  };
}

describe("the runs a pending decision is about", () => {
  it("names one run per decision, in the order the decisions are listed", () => {
    const addressed = addressedRunPostures(
      [record(RUN_B, "approval-1"), record(RUN_A, "approval-2")],
      { [RUN_A]: runEntity(RUN_A, POSTURE), [RUN_B]: runEntity(RUN_B, POSTURE) },
    );
    expect(addressed.map((entry) => entry.runId)).toStrictEqual([RUN_B, RUN_A]);
  });

  it("names a run once even where one turn raised several requests", () => {
    // The wait-for-all barrier raises one request per contributing principal, all
    // against one run. Three rows for one boundary would imply three boundaries.
    const addressed = addressedRunPostures(
      [record(RUN_A, "approval-1"), record(RUN_A, "approval-2"), record(RUN_A, "approval-3")],
      { [RUN_A]: runEntity(RUN_A, POSTURE) },
    );
    expect(addressed).toHaveLength(1);
    expect(addressed[0]?.posture?.mode).toBe("readonly-sandboxed");
  });

  it("carries a run whose boundary is unknown rather than dropping it", () => {
    // A run that has not reached `running` carries no stamp. The row still belongs
    // here, because "this decision is about a run whose boundary is unknown" is a
    // reading and filtering it out would make missing evidence look like silence.
    const addressed = addressedRunPostures([record(RUN_A, "approval-1")], {
      [RUN_A]: runEntity(RUN_A, undefined),
    });
    expect(addressed).toStrictEqual([{ runId: RUN_A, posture: undefined }]);
  });

  it("carries a run the partition does not hold at all", () => {
    const addressed = addressedRunPostures([record(RUN_A, "approval-1")], {});
    expect(addressed).toStrictEqual([{ runId: RUN_A, posture: undefined }]);
  });

  it("names no run when nothing is waiting on a decision", () => {
    expect(addressedRunPostures([], { [RUN_A]: runEntity(RUN_A, POSTURE) })).toStrictEqual([]);
  });

  it("negative control: a body carrying an unparseable posture reads as unknown", () => {
    // The narrowing is the bridge's registered parse, not a member check here: a
    // posture that would not survive the contract's own strictness must not reach a
    // surface as a valid permission boundary.
    const addressed = addressedRunPostures([record(RUN_A, "approval-1")], {
      [RUN_A]: { kind: "run", id: RUN_A, body: { executionPosture: { mode: "trusted" } } },
    });
    expect(addressed[0]?.posture).toBeUndefined();
  });
});
