// What one row reads: the band its status lands in, and the parks it folds.
//
// The park discriminator itself is asserted next door, on the module that owns it
// (`run-list-rows.test.ts`); what is asserted here is what the LIST reads off a set of
// runs. The band table is total over the substrate's status set by TYPE rather than by
// count, so a seventh status stops this file compiling instead of silently going
// untested.

import { describe, expect, it } from "vitest";

import { RunListProjection, type WorkflowRunAttentionBand } from "./run-list-projection.js";
import { phase, run } from "./run-list-projection.test-support.js";
import type { WorkflowRunState } from "./run-list-rows.js";

describe("the band a run status lands in", () => {
  /**
   * The expected band per status, as a TOTAL record.
   *
   * `Record<WorkflowRunState, …>` and not a list of the interesting cases: the type
   * is the control. A status added to `bridge/workflow-projection.ts` fails to
   * compile here — and in the projection's own table — rather than quietly reaching
   * neither.
   */
  const BAND_BY_RUN_STATE: Readonly<Record<WorkflowRunState, WorkflowRunAttentionBand>> = {
    pending: "active",
    running: "active",
    suspended: "parked",
    completed: "settled",
    failed: "settled",
    cancelled: "settled",
  };

  /**
   * The record's keys, typed.
   *
   * `Object.keys` widens to `string[]` by design, because an object may carry keys
   * its type does not name. This one cannot: the literal above IS the whole set, so
   * the narrowing states a fact about this value rather than a hope about it.
   */
  const RUN_STATES = Object.keys(BAND_BY_RUN_STATE) as readonly WorkflowRunState[];

  it.each(RUN_STATES)("bands a `%s` run with no parks by its status alone", (state) => {
    const projection = new RunListProjection([run({ state, phaseStates: [] })]);
    expect(projection.rows[0]?.attentionBand).toBe(BAND_BY_RUN_STATE[state]);
  });

  it("negative control: a park overrides the status band", () => {
    // Without this, every case above would pass over a projection that read only the
    // status and never looked at a phase — which is the reading `Spec-017` keeps the
    // status union coarse to prevent.
    const projection = new RunListProjection([
      run({
        state: "running",
        phaseStates: [phase({ parkReason: "waiting-human", parkCause: "Sign-off needed." })],
      }),
    ]);
    expect(projection.rows[0]?.attentionBand).toBe("parked");
  });
});

describe("what a row reads off its parks", () => {
  it("takes the earliest armed resume, verbatim, across a run's parks", () => {
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
    expect(projection.rows[0]?.earliestAutoResumeAt).toBe("2026-09-01T11:30:00.000Z");
    expect(projection.rows[0]?.parkedPhases.map((parked) => parked.schedule.kind)).toStrictEqual([
      "armed",
      "armed",
    ]);
  });

  it("reports no armed resume and an unscheduled park where nothing was armed", () => {
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
    // One park armed a schedule and one did not: the run still needs a person, and
    // reporting only the armed one would say it resumes itself.
    expect(projection.rows[0]?.earliestAutoResumeAt).toBe("2026-09-01T13:00:00.000Z");
    // The classification is per PARK, because the badge that draws it draws one park
    // at a time: a row-level "something here is unscheduled" cannot say which.
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

  it("counts a suspended run with no park members, which the band already shows", () => {
    // An older daemon emits none of the four live park members, so this run has no
    // parked phase and still bands `parked` on its status alone. Counting phases
    // reported nothing parked while the list drew this row under the parked heading;
    // the count and the band are one derivation now.
    const projection = new RunListProjection([
      run({ workflowRunId: "run-suspended", state: "suspended", phaseStates: [phase()] }),
    ]);
    expect(projection.rows[0]?.attentionBand).toBe("parked");
    expect(projection.rows[0]?.parkedPhases).toStrictEqual([]);
    expect(projection.parkedRunCount).toBe(1);
  });

  it("negative control: a settled run with no parks is counted by neither reading", () => {
    // Without this the case above would pass over a count that answered `rows.length`
    // — which agrees with the band on a one-run list and on nothing else.
    const projection = new RunListProjection([
      run({ workflowRunId: "run-done", state: "completed", phaseStates: [phase()] }),
      run({ workflowRunId: "run-suspended", state: "suspended", phaseStates: [phase()] }),
    ]);
    expect(projection.parkedRunCount).toBe(1);
  });
});
