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
// `read-settlement.ts` is reached deep and intra-family, as this family's own barrel
// licenses: `panes/workflow-run/` and `workflows/` are one family under one task.
//
// ONE READ PER MOUNT, AND NO POLLING. `Spec-017`'s run lifecycle is evented, and the
// event types that would carry it are registered nowhere yet, so this hook reads
// once and says so rather than re-reading on a timer — which would be a console
// inventing a refresh cadence for a stream it will later subscribe to, and holding
// two answers to one question in the meantime.

import { useEffect } from "react";

import type { GrowthPort, WorkflowRunSnapshot } from "../../bridge/index.js";
import {
  subjectReadStart,
  useSubjectStampedRead,
  type SubjectStampedRead,
} from "../../store/index.js";
import { settleGrowthRead, type SettledReadRefusal } from "../../workflows/read-settlement.js";

/** What this read looks like once it has an answer, either kind. */
type SettledRunSnapshot =
  | { readonly status: "served"; readonly snapshot: WorkflowRunSnapshot }
  | { readonly status: "unavailable"; readonly refusal: SettledReadRefusal };

/**
 * What the run pane knows about its run at one moment.
 *
 * Four states and no others, and the two unsettled ones come from the shared shape in
 * `store/subject-stamped-state.ts` rather than being spelled a third time here — so
 * this hook, the runs directory and the definitions directory cannot drift about
 * which frame is allowed to claim nobody asked.
 */
export type WorkflowRunSnapshotState = SubjectStampedRead<SettledRunSnapshot>;

/**
 * Read one run once, for as long as the caller is mounted.
 *
 * Keyed on the port and the run id: the port is minted once per bridge and is
 * therefore stable for the life of a window, so a re-render never re-reads, while a
 * bridge swapped underneath — the fixture's scenario switch — and a pane retargeted
 * at a different run both do.
 *
 * THE STATE IS STAMPED WITH THE RUN IT IS ABOUT, so a retarget is settled during the
 * render that brings the new run rather than in the effect after the commit. Before
 * that, an addressed pane committed one frame reading "This run has not been read in
 * this window" over a read it had already issued, and a pane moved from run A to run
 * B kept A's phases and A's park cards renderable under B's address.
 */
export function useWorkflowRunSnapshot(
  growth: GrowthPort,
  workflowRunId: string | undefined,
): WorkflowRunSnapshotState {
  const [state, setState] = useSubjectStampedRead<SettledRunSnapshot>(workflowRunId);
  useEffect(() => {
    if (workflowRunId === undefined) {
      // Nothing to reset: the stamp already put this read at `unasked` during the
      // render that dropped the run, which is the honest state for a pane naming none.
      return;
    }
    // The PORT can change under an unchanged run — the fixture's scenario switch swaps
    // the bridge — and the subject stamp does not see that, so the reset is stated
    // here for exactly that case, through the same rule rather than beside it.
    setState(subjectReadStart(workflowRunId));
    let isMounted = true;
    void settleGrowthRead(growth.workflowRunRead({ workflowRunId })).then((outcome) => {
      if (!isMounted) {
        // The unmount already happened; dropping the answer is the point. A
        // `setState` on an unmounted caller is the leak the endurance tier exists to
        // catch, and a read outliving its pane by one navigation is ordinary.
        return;
      }
      setState(
        outcome.status === "served"
          ? { status: "served", snapshot: outcome.value }
          : { status: "unavailable", refusal: outcome },
      );
    });
    return () => {
      isMounted = false;
    };
    // `setState` is the stamped read's own setter and is stable for the life of the
    // hook; it is named so the dependency list is the whole of what this effect uses.
  }, [growth, workflowRunId, setState]);
  return state;
}
