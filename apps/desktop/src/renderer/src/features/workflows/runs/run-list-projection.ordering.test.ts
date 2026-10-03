// The order the rows come out in: newest first, with no band for parked runs.

import { describe, expect, it } from "vitest";

import { RunListProjection } from "./run-list-projection.js";
import { phase, run } from "./run-list-projection.test-support.js";

describe("row ordering", () => {
  const settled = run({
    workflowRunId: "run-settled",
    state: "completed",
    startedAt: "2026-09-01T12:00:00.000Z",
    phaseStates: [phase({ state: "completed" })],
  });
  const activeOlder = run({
    workflowRunId: "run-active-older",
    startedAt: "2026-09-01T09:00:00.000Z",
  });
  const activeNewer = run({
    workflowRunId: "run-active-newer",
    startedAt: "2026-09-01T11:00:00.000Z",
  });
  const parked = run({
    workflowRunId: "run-parked",
    startedAt: "2026-09-01T08:00:00.000Z",
    phaseStates: [
      phase({ state: "running", parkReason: "waiting-human", parkCause: "Sign-off needed." }),
    ],
  });

  it("puts the newest run first, and a parked run sits where its start puts it", () => {
    const projection = new RunListProjection([settled, activeOlder, activeNewer, parked]);
    expect(projection.rows.map((row) => row.run.workflowRunId)).toStrictEqual([
      "run-settled",
      "run-active-newer",
      "run-active-older",
      "run-parked",
    ]);
  });
});
