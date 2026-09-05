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
// `bridge/read-settlement.ts` owns that settlement and is reached through the bridge
// door, which is where it lives: it settles a promise the growth port returned and
// knows nothing about a run.
//
// ONE READ PER MOUNT, AND NO POLLING. `Spec-017`'s run lifecycle is evented, and the
// event types that would carry it are registered nowhere yet, so this hook reads
// once and says so rather than re-reading on a timer — which would be a console
// inventing a refresh cadence for a stream it will later subscribe to, and holding
// two answers to one question in the meantime.

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
): WorkflowRunSnapshotState {
  return useSettledGrowthRead<
    Awaited<ReturnType<GrowthPort["workflowRunRead"]>>,
    WorkflowRunSnapshotState
  >(growth, workflowRunId, (subject) => readRun(growth, subject), {
    unsettled: subjectReadStart,
    settled: (settlement) =>
      settlement.status === "served"
        ? { status: "served", snapshot: settlement.value }
        : { status: "unavailable", refusal: settlement },
  }).value;
}

/**
 * The run read, or no question at all.
 *
 * The request carries a required run id, so a pane naming none has nothing to ask —
 * the `unasked` state — and the absence is answered here, where the request is built.
 */
function readRun(
  growth: GrowthPort,
  workflowRunId: string | undefined,
): ReturnType<GrowthPort["workflowRunRead"]> | undefined {
  return workflowRunId === undefined ? undefined : growth.workflowRunRead({ workflowRunId });
}
