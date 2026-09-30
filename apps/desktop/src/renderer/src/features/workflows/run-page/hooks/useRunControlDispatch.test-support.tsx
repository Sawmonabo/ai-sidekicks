// What the run-control dispatch suites share: a probe that mounts the hook, and calls whose
// cancel the case settles by hand.

import { render } from "@testing-library/react";

import {
  useRunControlDispatch,
  type WorkflowRunControlCalls,
  type WorkflowRunControls,
} from "./useRunControlDispatch.js";
import type { WorkflowRunCancelReply } from "../run-controls.js";

/** Two run ids, so a case can retarget a pane from one run to another. */
export const RUN_A = "run-a";
/** The second run id. */
export const RUN_B = "run-b";

/** A served cancel, in the shape the operation's own signature fixes. */
export const CANCELED: WorkflowRunCancelReply = {
  workflowRunId: RUN_A,
  state: "canceled",
  canceledEventId: "evt-cancel-01",
  alreadyCanceled: false,
};

/** Calls whose cancel stays in flight until the case serves it, and what they were asked. */
export interface HeldCancel {
  readonly calls: WorkflowRunControlCalls;
  readonly requests: CancelRequest[];
  readonly resumeRequests: ResumeRequest[];
  readonly serve: () => void;
}

/**
 * Calls whose cancel stays in flight until the case serves it.
 *
 * The window between dispatch and answer is where single flight, the retarget drop and the
 * `dispatching` state live. Resume answers at once.
 */
export function heldCancelCalls(): HeldCancel {
  const requests: CancelRequest[] = [];
  const resumeRequests: ResumeRequest[] = [];
  let serveHeld: (() => void) | undefined;
  const calls: WorkflowRunControlCalls = {
    cancelRun: async (request) => {
      requests.push(request);
      return new Promise((resolve) => {
        serveHeld = () => {
          resolve(CANCELED);
        };
      });
    },
    resumeRun: async (request) => {
      resumeRequests.push(request);
      return { workflowRunId: request.workflowRunId, state: "running" };
    },
  };
  return { calls, requests, resumeRequests, serve: () => serveHeld?.() };
}

/** What a rejecting call fails with, so a case can tell it from any other failure. */
export const CANCEL_FAILURE: Error = new Error("the cancel call failed");

/** Calls whose cancel rejects, and what they were asked. */
export interface RejectingCancel {
  readonly calls: WorkflowRunControlCalls;
  readonly requests: CancelRequest[];
}

/** Calls whose cancel rejects at once; resume is never pressed by the cases that use it. */
export function rejectingCancelCalls(): RejectingCancel {
  const requests: CancelRequest[] = [];
  const calls: WorkflowRunControlCalls = {
    cancelRun: (request) => {
      requests.push(request);
      return Promise.reject(CANCEL_FAILURE);
    },
    resumeRun: () => Promise.reject(CANCEL_FAILURE),
  };
  return { calls, requests };
}

/** The controls as the latest render saw them, plus the handle a retarget needs. */
export function observeControls(
  calls: WorkflowRunControlCalls,
  workflowRunId: string | undefined,
): {
  readonly latest: () => WorkflowRunControls;
  readonly retarget: (next: string) => void;
} {
  const observed: WorkflowRunControls[] = [];
  const collect = (controls: WorkflowRunControls): void => {
    observed.push(controls);
  };
  const view = render(
    <DispatchProbe calls={calls} workflowRunId={workflowRunId} onObserve={collect} />,
  );
  return {
    latest: () => {
      const current = observed.at(-1);
      if (current === undefined) {
        throw new Error("the probe rendered no controls");
      }
      return current;
    },
    retarget: (next) => {
      view.rerender(<DispatchProbe calls={calls} workflowRunId={next} onObserve={collect} />);
    },
  };
}

type CancelRequest = Parameters<WorkflowRunControlCalls["cancelRun"]>[0];

type ResumeRequest = Parameters<WorkflowRunControlCalls["resumeRun"]>[0];

function DispatchProbe(props: {
  readonly calls: WorkflowRunControlCalls;
  readonly workflowRunId: string | undefined;
  readonly onObserve: (controls: WorkflowRunControls) => void;
}): React.JSX.Element {
  props.onObserve(useRunControlDispatch(props.calls, props.workflowRunId));
  return <></>;
}
