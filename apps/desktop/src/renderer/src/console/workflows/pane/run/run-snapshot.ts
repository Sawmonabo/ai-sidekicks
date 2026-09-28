// One run, as the pane can honestly know it.
//
// THE STATES ARE THREE FACTS AND NO OTHERS — the pane names no run so nothing was
// asked, a read is in flight, or a snapshot came back. The call that reads a run is
// the caller's: this hook keeps the round and subject logic, and a rejected call is not
// caught here.
//
// ONE READ PER ROUND, AND NO POLLING. This hook never re-reads on a timer, which
// would be a console inventing a refresh cadence and holding two answers to one
// question in the meantime. What it does instead is re-read once per ROUND, and the
// round is the caller's — a number that only rises, whose every advance means the run
// this window is showing has moved under the answer in hand.
//
// TWO THINGS ADVANCE IT AND THEY ARE THE SAME CLAIM MADE BY DIFFERENT PARTIES. An
// operator's own act came back served, which the dispatcher counts; or the session's
// timeline carried a frame saying the run moved, which `run-live-rounds.ts` counts —
// the engine advancing a phase, a park arming a resume, a second window's cancel or gate
// resolution. Neither is a cadence: with nobody pressing anything and nothing happening,
// no round advances and no read is put.
//
// AND THE ROUND JOINS THE SUBJECT KEY rather than sitting beside it: the seed rule
// then re-states the read as `reading` for the new round during the render that brings
// it, exactly as it does for a new run, so no frame shows the previous round's
// snapshot as though it were the answer to the new question.

import type { WorkflowRunSnapshot } from "../../../bridge/index.js";
import { subjectReadStart, type SubjectRead } from "../../../store/index.js";
import { useSubjectRead } from "../../subject-read.js";

/** The call that reads one run. Pass a stable function: a new identity re-reads. */
export type WorkflowRunReadCall = (request: {
  readonly workflowRunId: string;
}) => Promise<WorkflowRunSnapshot>;

/**
 * What the run pane knows about its run at one moment.
 *
 * Three states and no others, and the two unsettled ones come from the shared shape in
 * `store/read/subject-read-start.ts` rather than being spelled a third time here — so this
 * hook, the runs directory and the definitions directory cannot drift about which
 * frame is allowed to claim nobody asked, or about which frame is allowed to hold the
 * previous bridge's answer.
 */
export type WorkflowRunSnapshotState = SubjectRead<{
  readonly status: "served";
  readonly snapshot: WorkflowRunSnapshot;
}>;

/**
 * Read one run once, for as long as the caller is mounted.
 *
 * Keyed on the call and the run id: a re-render with the same call never re-reads, while
 * a different call and a pane retargeted at a different run both do.
 *
 * THE STATE IS HELD AGAINST THE CALL AND THE RUN IT IS ABOUT, so either change is
 * settled during the render that brings it rather than in the effect after the commit.
 * An addressed pane therefore never commits a frame of `unasked` over a read it has
 * issued, and a pane moved from run A to run B never shows A's phases or park cards
 * under B's address.
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
 * A DERIVED KEY, which is the shape `subject-scoped-state.ts` names for a subject
 * compared by value rather than by identity — the comparison happens in one place, on
 * a string, and which facts make up the subject is the caller's to decide. Both facts
 * belong: a new run is a different question, and a new round is the same question put
 * again because the run moved under the answer in hand.
 *
 * `undefined` where no run is named, so the seed rule still answers `unasked` rather
 * than `reading` — a round number alone is not a question anyone can put.
 */
function readSubjectKey(workflowRunId: string | undefined, readRound: number): string | undefined {
  return workflowRunId === undefined ? undefined : `${workflowRunId}#${String(readRound)}`;
}
