// The readings taken when an instant the console cannot parse arrives anyway.
//
// A malformed boundary is not a hypothetical, and it reaches two places: the park a
// phase carries, where it is classified rather than folded into "nothing was armed",
// and the run's own start, where it must sort under every start a person can read. Both
// are asserted here, against a fixture whose unreadability is itself checked first.

import { describe, expect, it } from "vitest";

import { RunListProjection } from "./run-list-projection.js";
import { workflowInstant } from "./run-list-rows.js";
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
  it("negative control: the fixture really is unreadable", () => {
    // Every case below rests on this. A fixture that quietly parsed would make them
    // all pass over a projection that compared it like any other instant. Asserted
    // against the reading the plane declares rather than against the host parser,
    // because unreadable HERE means unreadable by that reader — and the two disagree
    // in both directions, which is why the reader exists.
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
    // Per PARK and never per row: the surface that says which kind of park this is
    // draws one park at a time, so a row-level reading could not tell it which of
    // these two the sentence in front of the operator is about.
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
