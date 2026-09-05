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

import { useEffect } from "react";

import {
  settleGrowthRead,
  type GrowthPort,
  type SettledReadRefusal,
  type WorkflowRunSnapshot,
} from "../../bridge/index.js";
import { subjectReadStart, useSubjectScopedState, type SubjectRead } from "../../store/index.js";

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
  const { value: state, publish } = useSubjectScopedState<WorkflowRunSnapshotState>(
    growth,
    workflowRunId,
    () => subjectReadStart(workflowRunId),
  );
  useEffect(() => {
    if (workflowRunId === undefined) {
      // Nothing to reset: the holder already put this read at `unasked` during the
      // render that dropped the run, which is the honest state for a pane naming none.
      return;
    }
    // No reset here. The holder above covers a port swapped under an unchanged run as
    // well as a retarget, and it covers it during the render rather than one commit
    // later — a reset stated again in this effect would be the same rule in two places,
    // agreeing until one of them moved.
    void settleGrowthRead(growth.workflowRunRead({ workflowRunId })).then((outcome) => {
      // No mount flag beside it. `publish` carries the addressing it was captured
      // under, so an answer arriving after the pane was retargeted — or unmounted —
      // writes nowhere, which is the same disposition the flag stated by hand.
      publish(
        outcome.status === "served"
          ? { status: "served", snapshot: outcome.value }
          : { status: "unavailable", refusal: outcome },
      );
    });
    // `publish` re-identifies exactly when the holder is re-addressed, so it is both the
    // guard on this read's answer and the whole of what tells this effect to run again.
  }, [growth, workflowRunId, publish]);
  return state;
}
