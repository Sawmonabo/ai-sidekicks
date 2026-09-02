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

import { useEffect, useState } from "react";

import type { GrowthPort, WorkflowRunSnapshot } from "../../bridge/index.js";
import { settleGrowthRead, type SettledReadRefusal } from "../../workflows/read-settlement.js";

/** What the run pane knows about its run at one moment. */
export type WorkflowRunSnapshotState =
  | { readonly status: "unasked" }
  | { readonly status: "reading" }
  | { readonly status: "served"; readonly snapshot: WorkflowRunSnapshot }
  | { readonly status: "unavailable"; readonly refusal: SettledReadRefusal };

/**
 * Read one run once, for as long as the caller is mounted.
 *
 * Keyed on the port and the run id: the port is minted once per bridge and is
 * therefore stable for the life of a window, so a re-render never re-reads, while a
 * bridge swapped underneath — the fixture's scenario switch — and a pane retargeted
 * at a different run both do.
 */
export function useWorkflowRunSnapshot(
  growth: GrowthPort,
  workflowRunId: string | undefined,
): WorkflowRunSnapshotState {
  const [state, setState] = useState<WorkflowRunSnapshotState>({ status: "unasked" });
  useEffect(() => {
    if (workflowRunId === undefined) {
      setState({ status: "unasked" });
      return;
    }
    // Reset rather than leaving the previous run's snapshot on screen under a fresh
    // subject: a stale run reads as the current one, and nothing about it says
    // otherwise.
    setState({ status: "reading" });
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
  }, [growth, workflowRunId]);
  return state;
}
