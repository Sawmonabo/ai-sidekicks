// A probe that mounts the run-snapshot hook at a chosen refresh, and a call that answers a run read
// from the probe fixtures.

import { render } from "@testing-library/react";

import { PROBE_RUNS } from "../../workflows-probe.test-support.js";
import {
  useWorkflowRunSnapshot,
  type WorkflowRunReadCall,
  type WorkflowRunSnapshotState,
} from "./useWorkflowRunSnapshot.js";

/** The refresh a case first reads at; the hook reads once per refresh. */
export const FIRST_REFRESH = 0;

/** A run read that answers from the probe runs, by id. */
export function runReadingCall(): WorkflowRunReadCall {
  return async ({ workflowRunId }) => {
    const run = PROBE_RUNS.find((candidate) => candidate.workflowRunId === workflowRunId);
    if (run === undefined) {
      throw new Error(`no probe run with id ${workflowRunId}`);
    }
    return run;
  };
}

/** The probe mounted, with the handle a re-render at another refresh needs. */
export function observeRefreshes(readRun: WorkflowRunReadCall): {
  readonly observed: readonly WorkflowRunSnapshotState[];
  readonly renderAtRefresh: (workflowRunId: string, refreshCount: number) => void;
} {
  const observed: WorkflowRunSnapshotState[] = [];
  const collect = (state: WorkflowRunSnapshotState): void => {
    observed.push(state);
  };
  let view: ReturnType<typeof render> | undefined;
  return {
    observed,
    renderAtRefresh: (workflowRunId, refreshCount) => {
      const element = (
        <SnapshotProbe
          readRun={readRun}
          workflowRunId={workflowRunId}
          refreshCount={refreshCount}
          onObserve={collect}
        />
      );
      if (view === undefined) {
        view = render(element);
        return;
      }
      // A re-render, not a second mount: the pane is not remounted when a refresh advances.
      view.rerender(element);
    },
  };
}

function SnapshotProbe(props: {
  readonly readRun: WorkflowRunReadCall;
  readonly workflowRunId: string;
  readonly refreshCount: number;
  readonly onObserve: (state: WorkflowRunSnapshotState) => void;
}): React.JSX.Element {
  props.onObserve(useWorkflowRunSnapshot(props.readRun, props.workflowRunId, props.refreshCount));
  return <></>;
}
