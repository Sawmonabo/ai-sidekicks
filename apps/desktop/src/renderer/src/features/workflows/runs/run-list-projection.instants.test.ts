// The readings taken when an instant the console cannot parse arrives anyway: on the park a
// phase carries (classified, not folded into "nothing armed") and on a run's start (sorts under
// every readable start).

import { describe, expect, it } from "vitest";

import { RunListProjection } from "./run-list-projection.js";
import { workflowInstant } from "./run-list-rows.js";
import { phase, run } from "./run-list-projection.test-support.js";

/**
 * A resume instant no parser accepts, shaped like a real timestamp because that is what a daemon
 * emitting a malformed boundary sends.
 */
const UNREADABLE_INSTANT = "2026-09-01T99:99:99.000Z";

describe("an instant the console cannot read", () => {
  it("negative control: the fixture really is unreadable", () => {
    // Unreadable here means unreadable by `workflowInstant`, which the host parser disagrees with
    // in both directions.
    expect(workflowInstant(UNREADABLE_INSTANT).kind).toBe("malformed");
  });

  it("classifies each park on its own reading when one run holds both kinds", () => {
    const projection = new RunListProjection([
      run({
        phaseStates: [
          phase({
            phaseId: "phase-malformed",
            parkReason: "provider-usage-limited",
            parkCause: "Spent.",
            autoResumeAt: UNREADABLE_INSTANT,
          }),
          phase({
            phaseId: "phase-real",
            parkReason: "provider-usage-limited",
            parkCause: "Spent.",
            autoResumeAt: "2026-09-01T11:30:00.000Z",
          }),
        ],
      }),
    ]);
    // Per park, not per row: the badge draws one park at a time.
    expect(projection.rows[0]?.parkedPhases.map((parked) => parked.schedule.kind)).toStrictEqual([
      "unreadable",
      "armed",
    ]);
  });

  it("reports the unreadable park as unscheduled and names its phase", () => {
    const projection = new RunListProjection([
      run({
        phaseStates: [
          phase({
            phaseId: "phase-malformed",
            parkReason: "provider-usage-limited",
            parkCause: "Spent.",
            autoResumeAt: UNREADABLE_INSTANT,
          }),
        ],
      }),
    ]);
    // The malformed value is the only evidence the engine armed anything.
    expect(projection.rows[0]?.parkedPhases[0]?.schedule).toStrictEqual({
      kind: "unreadable",
      autoResumeAt: UNREADABLE_INSTANT,
    });
  });

  it("negative control: a readable armed resume is neither unscheduled nor named", () => {
    const projection = new RunListProjection([
      run({
        phaseStates: [
          phase({
            parkReason: "provider-usage-limited",
            parkCause: "Spent.",
            autoResumeAt: "2026-09-01T11:30:00.000Z",
          }),
        ],
      }),
    ]);
    expect(projection.rows[0]?.parkedPhases[0]?.schedule).toStrictEqual({
      kind: "armed",
      autoResumeAt: "2026-09-01T11:30:00.000Z",
    });
  });

  it("still sorts a run with an unreadable start last", () => {
    // Descending order puts the run nothing can be said about under every legible start.
    const projection = new RunListProjection([
      run({ workflowRunId: "run-unreadable-start", startedAt: UNREADABLE_INSTANT }),
      run({ workflowRunId: "run-older", startedAt: "2026-09-01T08:00:00.000Z" }),
      run({ workflowRunId: "run-newer", startedAt: "2026-09-01T12:00:00.000Z" }),
    ]);
    expect(projection.rows.map((row) => row.run.workflowRunId)).toStrictEqual([
      "run-newer",
      "run-older",
      "run-unreadable-start",
    ]);
  });
});
