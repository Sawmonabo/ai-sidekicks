// The projection's three claims, each with the control that would catch it being
// vacuous.
//
// The claim that matters most is the one that cannot be seen by looking at a screen:
// a park is read from `parkReason` and never from a phase's `state`. So the fixtures
// below deliberately put a park on a `running` phase and a `parkCause` on a phase
// with no reason — the two shapes a `state`-reading projection gets wrong in
// opposite directions.

import { describe, expect, it } from "vitest";

import {
  RunListProjection,
  WORKFLOW_PHASE_RUN_STATES,
  WORKFLOW_RUN_STATES,
  phasePark,
  type WorkflowPhaseStateRow,
  type WorkflowRunSnapshot,
} from "./run-list-projection.js";

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

describe("the phase-run status union", () => {
  it("stays at five values, so the park never gets a status arm of its own", () => {
    expect(WORKFLOW_PHASE_RUN_STATES).toHaveLength(5);
    expect([...WORKFLOW_PHASE_RUN_STATES]).not.toContain("suspended");
  });

  it("negative control: the RUN status union does carry `suspended`", () => {
    // Without this the case above would pass over a membership check that was
    // simply always false — a misspelled needle, or a set that held nothing.
    expect([...WORKFLOW_RUN_STATES]).toContain("suspended");
    expect(WORKFLOW_RUN_STATES).toHaveLength(6);
  });
});

describe("the park discriminator", () => {
  it("reads a park off `parkReason` even on a phase whose state says running", () => {
    const park = phasePark(
      phase({ state: "running", parkReason: "waiting-human", parkCause: "Approval needed." }),
    );
    expect(park?.parkReason).toBe("waiting-human");
  });

  it("negative control: a phase carrying a cause and no reason is not parked", () => {
    // A projection that keyed on any of the other three members would call this
    // parked. `parkCause` is the trap, because the producer emits it whenever it
    // emits a reason, so it looks interchangeable and is not.
    expect(phasePark(phase({ parkCause: "Approval needed." }))).toBeUndefined();
  });

  it("negative control: a phase with no park members at all is not parked", () => {
    expect(phasePark(phase({ state: "pending" }))).toBeUndefined();
  });

  it("carries the armed schedule and the attention key through untouched", () => {
    const park = phasePark(
      phase({
        parkReason: "provider-usage-limited",
        parkCause: "Account allowance spent until 11:30.",
        autoResumeAt: "2026-09-01T11:30:00.000Z",
        parkAttentionKey: "account-7",
      }),
    );
    expect(park?.autoResumeAt).toBe("2026-09-01T11:30:00.000Z");
    expect(park?.parkAttentionKey).toBe("account-7");
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
    expect(projection.rows[0]?.hasUnscheduledPark).toBe(false);
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
    expect(projection.rows[0]?.hasUnscheduledPark).toBe(true);
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
