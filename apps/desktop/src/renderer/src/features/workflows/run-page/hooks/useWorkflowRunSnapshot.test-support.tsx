// What the run-snapshot suites share: the probe that mounts the hook and a call that
// answers a run read from the probe fixtures.

import { render } from "@testing-library/react";

import { PROBE_RUNS } from "../../workflows-probe.test-support.js";
import {
  useWorkflowRunSnapshot,
  type WorkflowRunReadCall,
  type WorkflowRunSnapshotState,
} from "./useWorkflowRunSnapshot.js";

/** The round every case but the re-arm ones reads at; the hook reads once per round. */
export const FIRST_ROUND = 0;

/** Mounts the hook and hands every rendered state to `onObserve`. */
export function SnapshotProbe(props: {
  readonly readRun: WorkflowRunReadCall;
  readonly workflowRunId: string | undefined;
  readonly readRound?: number;
  readonly onObserve: (state: WorkflowRunSnapshotState) => void;
}): React.JSX.Element {
  props.onObserve(
    useWorkflowRunSnapshot(props.readRun, props.workflowRunId, props.readRound ?? FIRST_ROUND),
  );
  return <></>;
}

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

/** The probe mounted, with the handle a re-render at another round needs. */
export function observeRounds(readRun: WorkflowRunReadCall): {
  readonly observed: readonly WorkflowRunSnapshotState[];
  readonly renderAtRound: (workflowRunId: string, readRound: number) => void;
} {
  const observed: WorkflowRunSnapshotState[] = [];
  const collect = (state: WorkflowRunSnapshotState): void => {
    observed.push(state);
  };
  let view: ReturnType<typeof render> | undefined;
  return {
    observed,
    renderAtRound: (workflowRunId, readRound) => {
      const element = (
        <SnapshotProbe
          readRun={readRun}
          workflowRunId={workflowRunId}
          readRound={readRound}
          onObserve={collect}
        />
      );
      if (view === undefined) {
        view = render(element);
        return;
      }
      // A re-render, not a second mount: the pane is not remounted when a round advances.
      view.rerender(element);
    },
  };
}
