// The projection's three claims, each with the control that would catch it being
// vacuous.
//
// The park discriminator itself is asserted next door, on the module that owns it
// (`run-list-rows.test.ts`); what is asserted here is what the LIST reads off a set of
// runs — the band a status lands in, the order the bands come out in, the parks a row
// folds, and the frozen pin. The band table is total over the substrate's status set
// by TYPE rather than by count, so a seventh status stops this file compiling instead
// of silently going untested.

import { describe, expect, it } from "vitest";

import { RunListProjection, type WorkflowRunAttentionBand } from "./run-list-projection.js";
import type {
  WorkflowPhaseStateRow,
  WorkflowRunSnapshot,
  WorkflowRunState,
} from "./run-list-rows.js";

function phase(overrides: Partial<WorkflowPhaseStateRow> = {}): WorkflowPhaseStateRow {
  return { phaseId: "phase-1", phaseName: "Draft", state: "running", ...overrides };
}

function run(overrides: Partial<WorkflowRunSnapshot> = {}): WorkflowRunSnapshot {
  return {
    workflowRunId: "run-1",
    state: "running",
    workflowVersionId: "version-1",
    startedAt: "2026-09-01T10:00:00.000Z",
    phaseStates: [phase()],
    definitionName: "Release checklist",
    ...overrides,
  };
}

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

  it("puts parked first, then active, then settled — regardless of input order", () => {
    const projection = new RunListProjection([settled, activeOlder, activeNewer, parked]);
    expect(projection.rows.map((row) => row.run.workflowRunId)).toStrictEqual([
      "run-parked",
      "run-active-newer",
      "run-active-older",
      "run-settled",
    ]);
  });

  it("negative control: the input order is not the output order", () => {
    // The case above would pass over a projection that returned its input untouched
    // if the input happened to arrive sorted. It does not here, and this states so.
    const input = [settled, activeOlder, activeNewer, parked];
    const projection = new RunListProjection(input);
    expect(projection.rows.map((row) => row.run.workflowRunId)).not.toStrictEqual(
      input.map((snapshot) => snapshot.workflowRunId),
    );
  });

  it("bands a `suspended` run as parked even when no phase carries park members", () => {
    // An older daemon emits none of the four; the run status still says something is
    // waiting, and dropping such a run into `active` would hide it under the runs
    // that are actually moving.
    const projection = new RunListProjection([
      run({ workflowRunId: "run-suspended", state: "suspended", phaseStates: [] }),
      activeNewer,
    ]);
    expect(projection.rows[0]?.run.workflowRunId).toBe("run-suspended");
    expect(projection.rows[0]?.parkedPhases).toStrictEqual([]);
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

describe("an instant the console cannot read", () => {
  /**
   * A resume instant no parser accepts.
   *
   * Shaped like a real one on purpose — a daemon that emits a malformed boundary
   * emits something that LOOKS like a timestamp, and a fixture of obvious rubbish
   * would prove the projection handles rubbish rather than the case that happens.
   */
  const UNREADABLE_INSTANT = "2026-09-01T99:99:99.000Z";

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

describe("the frozen-definition state", () => {
  it("is true when the run's pin is not the definition's latest", () => {
    const projection = new RunListProjection([
      run({ workflowVersionId: "version-1", definitionLatestWorkflowVersionId: "version-4" }),
    ]);
    expect(projection.rows[0]?.isPinnedBehindLatestVersion).toBe(true);
    expect(projection.frozenPinCount).toBe(1);
  });

  it("is false when the pin IS the latest", () => {
    const projection = new RunListProjection([
      run({ workflowVersionId: "version-4", definitionLatestWorkflowVersionId: "version-4" }),
    ]);
    expect(projection.rows[0]?.isPinnedBehindLatestVersion).toBe(false);
  });

  it("negative control: unknown latest is not stale", () => {
    // Without the caller's latest there is no comparison to make, and guessing
    // `true` would invite a repair the daemon would refuse. The control matters
    // because `undefined !== "version-1"` is true, which is exactly the shape a
    // careless implementation reports as frozen.
    const projection = new RunListProjection([run({ workflowVersionId: "version-1" })]);
    expect(projection.rows[0]?.isPinnedBehindLatestVersion).toBe(false);
    expect(projection.frozenPinCount).toBe(0);
  });
});
