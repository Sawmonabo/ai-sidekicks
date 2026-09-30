// The phase and run builders every run-list suite shares, so a member added to the wire row is
// defaulted in one place. The unreadable instant and the two-enumeration helper each have one
// reader and stay beside it.

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
