// One run, as the pane can honestly know it.
//
// The run pane's whole subject is a run, and until this hook it had no way to ask
// for one: the run read is a growth operation, the growth port is reached from the
// bridge, and the pane rendered the same "not checked" line whether or not anything
// could have answered. That line was true and is now only true when it is — the read
// is put, and what comes back is what the pane shows.
//
// THE FOUR STATES ARE FOUR FACTS AND NO OTHERS — the pane names no run so nothing
// was asked, a read is in flight, a snapshot came back, or the read refused. A
// refused read is NOT an empty run: rendering it as one would assert that the run
// has no phases, which is a claim about the daemon that nothing established.
//
// THE READ IS SETTLED RATHER THAN MERELY AWAITED. A growth call can also REJECT — a
// scenario that scripts a daemon refusal throws it verbatim, and the live seam will
// throw the same shape once the wire lands — so a fulfilment handler alone left the
// rejection unhandled and this pane spinning on an answer that had already arrived.
// `bridge/readings/read-settlement.ts` owns that settlement and is reached through the bridge
// door, which is where it lives: it settles a promise the growth port returned and
// knows nothing about a run.
//
// ONE READ PER ROUND, AND NO POLLING. `Spec-017`'s run lifecycle is evented, and
// `packages/contracts` registers none of those event types — so there is no stream to
// subscribe to and no seam that re-reads on one. This hook therefore never re-reads on
// a timer, which would be a console inventing a refresh cadence for a stream it will
// later subscribe to and holding two answers to one question in the meantime.
//
// WHAT IT DOES DO is re-read once per ROUND, and a round advances for one reason: an
// operator's own act came back served, so the run this window is showing has changed
// and the caller says so by handing the next round. That is a re-arm and not a
// cadence — bounded by acts a person performed, zero of them if nobody presses
// anything — and it is why the round joins the SUBJECT KEY rather than sitting beside
// it: the seed rule then re-states the read as `reading` for the new round during the
// render that brings it, exactly as it does for a new run, so no frame shows the
// previous round's snapshot as though it were the answer to the new question.

import {
  useSettledGrowthRead,
  type GrowthPort,
  type SettledReadRefusal,
  type WorkflowRunSnapshot,
} from "../../../bridge/index.js";
import { subjectReadStart, type SubjectRead } from "../../../store/index.js";

/** What this read looks like once it has an answer, either kind. */
type SettledRunSnapshot =
  | { readonly status: "served"; readonly snapshot: WorkflowRunSnapshot }
  | { readonly status: "unavailable"; readonly refusal: SettledReadRefusal };

/**
 * What the run pane knows about its run at one moment.
 *
 * Four states and no others, and the two unsettled ones come from the shared shape in
 * `store/subject-read-start.ts` rather than being spelled a third time here — so this
 * hook, the runs directory and the definitions directory cannot drift about which
 * frame is allowed to claim nobody asked, or about which frame is allowed to hold the
 * previous bridge's answer.
 */
export type WorkflowRunSnapshotState = SubjectRead<SettledRunSnapshot>;

/**
 * Read one run once, for as long as the caller is mounted.
 *
 * Keyed on the port and the run id: the port is minted once per bridge and is
 * therefore stable for the life of a window, so a re-render never re-reads, while a
 * bridge swapped underneath — the fixture's scenario switch — and a pane retargeted
 * at a different run both do.
 *
 * THE STATE IS HELD AGAINST THE PORT AND THE RUN IT IS ABOUT, so either change is
 * settled during the render that brings it rather than in the effect after the commit.
 * Before that, an addressed pane committed one frame reading "This run has not been read
 * in this window" over a read it had already issued, and a pane moved from run A to run
 * B kept A's phases and A's park cards renderable under B's address. The port is the
 * subject because the fixture's scenario switch replaces the bridge and keeps the run
 * id, so a run-only holder committed the previous scenario's phases under the new one.
 */
export function useWorkflowRunSnapshot(
  growth: GrowthPort,
  workflowRunId: string | undefined,
  readRound: number,
): WorkflowRunSnapshotState {
  return useSettledGrowthRead<
    Awaited<ReturnType<GrowthPort["workflowRunRead"]>>,
    WorkflowRunSnapshotState
  >(growth, readSubjectKey(workflowRunId, readRound), () => readRun(growth, workflowRunId), {
    unsettled: subjectReadStart,
    settled: (settlement) =>
      settlement.status === "served"
        ? { status: "served", snapshot: settlement.value }
        : { status: "unavailable", refusal: settlement },
  }).value;
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

/**
 * The run read, or no question at all.
 *
 * The request carries a required run id, so a pane naming none has nothing to ask —
 * the `unasked` state — and the absence is answered here, where the request is built.
 * Taken from the caller's own argument rather than off the subject key, because that
 * key carries the round as well and a request built from it would address a run id
 * that does not exist.
 */
function readRun(
  growth: GrowthPort,
  workflowRunId: string | undefined,
): ReturnType<GrowthPort["workflowRunRead"]> | undefined {
  return workflowRunId === undefined ? undefined : growth.workflowRunRead({ workflowRunId });
}
