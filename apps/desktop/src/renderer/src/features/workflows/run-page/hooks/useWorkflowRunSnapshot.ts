// One run, as the pane can honestly know it: nothing asked, a read in flight, or a snapshot
// served. The call is the caller's and a rejected call is not caught here. The run is re-read
// once per round, never on a timer: the round rises when a served act or a live frame says
// the run moved, and it joins the subject key so no frame shows the last round as current.

import type { WorkflowRunSnapshot } from "@renderer/services/wire-shapes/workflow-projection.js";
import { subjectReadStart, type SubjectRead } from "../../subject-read-start.js";
import { useSubjectRead } from "@renderer/hooks/useSubjectRead.js";

/** The call that reads one run. Pass a stable function: a new identity re-reads. */
export type WorkflowRunReadCall = (request: {
  readonly workflowRunId: string;
}) => Promise<WorkflowRunSnapshot>;

/**
 * What the run pane knows about its run at one moment.
 *
 * Three states and no others. The two unsettled ones come from `subject-read-start.ts`,
 * shared with the runs and definitions directories so they cannot drift.
 */
export type WorkflowRunSnapshotState = SubjectRead<{
  readonly status: "served";
  readonly snapshot: WorkflowRunSnapshot;
}>;

/**
 * Read one run once, for as long as the caller is mounted.
 *
 * Keyed on the call and run id and settled during render, so an addressed pane never commits
 * `unasked` over an issued read and a retarget never shows the old run's phases.
 */
export function useWorkflowRunSnapshot(
  readRun: WorkflowRunReadCall,
  workflowRunId: string | undefined,
  readRound: number,
): WorkflowRunSnapshotState {
  return useSubjectRead<WorkflowRunSnapshot, WorkflowRunSnapshotState>(
    readRun,
    readSubjectKey(workflowRunId, readRound),
    () => (workflowRunId === undefined ? undefined : readRun({ workflowRunId })),
    {
      unsettled: subjectReadStart,
      settled: (snapshot) => ({ status: "served", snapshot }),
    },
  ).value;
}

/**
 * The subject this read is held at: the run, and which round of it is being asked.
 *
 * A derived string, compared by value. `undefined` where no run is named, so the seed rule
 * answers `unasked` rather than `reading`.
 */
function readSubjectKey(workflowRunId: string | undefined, readRound: number): string | undefined {
  return workflowRunId === undefined ? undefined : `${workflowRunId}#${String(readRound)}`;
}
