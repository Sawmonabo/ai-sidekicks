// What one row reads: whether it is parked, and the parks it folds. The park discriminator itself
// is asserted in `run-list-rows.test.ts`.

import { describe, expect, it } from "vitest";

import { RunListProjection } from "./run-list-projection.js";
import { phase, run } from "./run-list-projection.test-support.js";

describe("whether a run is parked", () => {
  it("is parked by a phase's park, whatever the run's status says", () => {
    // A phase's `state` never says parked; its park members do.
    const projection = new RunListProjection([
      run({
        state: "running",
        phaseStates: [phase({ parkReason: "waiting-human", parkCause: "Sign-off needed." })],
      }),
    ]);
    expect(projection.rows[0]?.isParked).toBe(true);
  });
});

describe("what a row reads off its parks", () => {
  it("classifies every park of a run that armed two readable boundaries", () => {
    const projection = new RunListProjection([
      run({
        phaseStates: [
          phase({
            phaseId: "phase-late",
            parkReason: "provider-usage-limited",
            parkCause: "Spent.",
            autoResumeAt: "2026-09-01T13:00:00.000Z",
          }),
          phase({
            phaseId: "phase-early",
            parkReason: "provider-usage-limited",
            parkCause: "Spent.",
            autoResumeAt: "2026-09-01T11:30:00.000Z",
          }),
        ],
      }),
    ]);
    expect(projection.rows[0]?.parkedPhases.map((parked) => parked.schedule.kind)).toStrictEqual([
      "armed",
      "armed",
    ]);
  });

  it("keeps an unscheduled park unscheduled beside one that armed a boundary", () => {
    const projection = new RunListProjection([
      run({
        phaseStates: [
          phase({ parkReason: "waiting-human", parkCause: "Sign-off needed." }),
          phase({
            phaseId: "phase-2",
            parkReason: "provider-usage-limited",
            parkCause: "Spent.",
            autoResumeAt: "2026-09-01T13:00:00.000Z",
          }),
        ],
      }),
    ]);
    // The classification is per park: the badge draws one park at a time.
    expect(projection.rows[0]?.parkedPhases.map((parked) => parked.schedule.kind)).toStrictEqual([
      "unscheduled",
      "armed",
    ]);
  });

  it("counts the runs that hold a park", () => {
    const projection = new RunListProjection([
      run({ workflowRunId: "run-clean" }),
      run({
        workflowRunId: "run-parked",
        phaseStates: [phase({ parkReason: "waiting-human", parkCause: "Sign-off needed." })],
      }),
    ]);
    expect(projection.parkedRunCount).toBe(1);
  });

  it("counts a suspended run with no park members, which the row already shows as parked", () => {
    // A `suspended` run has no park members and is parked on its status alone; the count reads
    // the row's own flag.
    const projection = new RunListProjection([
      run({ workflowRunId: "run-suspended", state: "suspended", phaseStates: [phase()] }),
    ]);
    expect(projection.rows[0]?.isParked).toBe(true);
    expect(projection.rows[0]?.parkedPhases).toStrictEqual([]);
    expect(projection.parkedRunCount).toBe(1);
  });

  it("negative control: a settled run with no parks is not parked and is not counted", () => {
    // Guards against a count that answered `rows.length`, which agrees only on a one-run list.
    const projection = new RunListProjection([
      run({ workflowRunId: "run-done", state: "completed", phaseStates: [phase()] }),
      run({ workflowRunId: "run-suspended", state: "suspended", phaseStates: [phase()] }),
    ]);
    expect(projection.rows.map((row) => row.isParked)).toStrictEqual([false, true]);
    expect(projection.parkedRunCount).toBe(1);
  });
});
