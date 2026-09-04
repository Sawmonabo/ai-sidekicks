// The two rows every run-list suite builds its cases out of.
//
// One home for the phase and the run, because the projection's four suites — the band
// a status lands in, the parks a row folds, the order the rows come out in, and the
// frozen pin — all read the same two shapes and differ only in what they override on
// them. Four copies of a two-line builder is four places a member added to the wire
// row has to be defaulted, and three of them would be found by a failing test rather
// than by the edit.
//
// What is deliberately NOT here is anything one suite reads: the unreadable instant,
// the band table, and the two-enumeration helper each have a single reader and stay
// beside it.

import type { WorkflowPhaseStateRow, WorkflowRunSnapshot } from "./run-list-rows.js";

/** One phase row — running, unparked — in the shape the wire carries. */
export function phase(overrides: Partial<WorkflowPhaseStateRow> = {}): WorkflowPhaseStateRow {
  return { phaseId: "phase-1", phaseName: "Draft", state: "running", ...overrides };
}

/** One run snapshot carrying a single running phase, as the enumeration serves it. */
export function run(overrides: Partial<WorkflowRunSnapshot> = {}): WorkflowRunSnapshot {
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
