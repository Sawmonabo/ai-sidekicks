// The readings taken when an instant the console cannot parse arrives anyway.
//
// A malformed boundary is not a hypothetical: the projection compares instants in two
// directions — ascending for the soonest resume, descending for the newest start — and
// a sentinel that satisfies one satisfies the other backwards. So both directions are
// asserted here, against a fixture whose unreadability is itself checked first.

import { describe, expect, it } from "vitest";

import { RunListProjection } from "./run-list-projection.js";
import { phase, run } from "./run-list-projection.test-support.js";

/**
 * A resume instant no parser accepts.
 *
 * Shaped like a real one on purpose — a daemon that emits a malformed boundary
 * emits something that LOOKS like a timestamp, and a fixture of obvious rubbish
 * would prove the projection handles rubbish rather than the case that happens.
 */
const UNREADABLE_INSTANT = "2026-09-01T99:99:99.000Z";

describe("an instant the console cannot read", () => {
  it("negative control: the fixture really is unparseable", () => {
    // Every case below rests on this. A fixture that quietly parsed would make them
    // all pass over a projection that compared it like any other instant.
    expect(Number.isNaN(Date.parse(UNREADABLE_INSTANT))).toBe(true);
  });

  it("picks the valid armed resume when another park armed one it cannot read", () => {
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
    // The shared floor sentinel this replaces sorted an unreadable instant last in
    // the DESCENDING run sort and first in this ASCENDING pick, so the row reported
    // the malformed value as the soonest resume.
    expect(projection.rows[0]?.earliestAutoResumeAt).toBe("2026-09-01T11:30:00.000Z");
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
    expect(projection.rows[0]?.earliestAutoResumeAt).toBeUndefined();
    // Classified `unreadable` rather than folded into `unscheduled`: the malformed
    // value is the only evidence the engine armed anything, and the badge reports it.
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
      atMilliseconds: Date.parse("2026-09-01T11:30:00.000Z"),
    });
  });

  it("still sorts a run with an unreadable start last inside its band", () => {
    // The other direction, and the rule that must not move: descending order puts
    // the run nothing can be said about under every run with a legible start.
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
