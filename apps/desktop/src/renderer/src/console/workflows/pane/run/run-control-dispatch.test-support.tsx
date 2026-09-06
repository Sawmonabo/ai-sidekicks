// What every run-control dispatch suite needs before it can put a press.
//
// TWO SUITES, ONE SET OF SCAFFOLDING. The calls and the refusals are one subject; the
// single flight, the addressing and the re-arm round are another. Both mount the same
// probe against the same held port, so that lives here rather than in whichever file
// was written first with the other deep-importing it.
//
// THE PORTS ARE THE CONSOLE'S OWN — `createRefusingGrowthPort` spread with the one
// operation a case is about — rather than objects shaped like a port. A stand-in would
// agree with whatever the hook did with it, and the refusing arm in particular is only
// meaningful because it is the refusal the real port composes.

import { render } from "@testing-library/react";

import { createRefusingGrowthPort, type GrowthPort } from "../../../bridge/index.js";
import type { WireErrorEnvelope } from "../../../../../../shared/wire-errors.js";
import { useRunControlDispatch, type WorkflowRunControls } from "./run-control-dispatch.js";
import type { WorkflowRunCancelReply } from "./run-controls.js";

export const RUN_A = "run-a";
export const RUN_B = "run-b";

/** A served cancel, in the shape the operation's own signature fixes. */
export const CANCELLED: WorkflowRunCancelReply = {
  workflowRunId: RUN_A,
  state: "cancelled",
  cancelledEventId: "evt-cancel-01",
  alreadyCancelled: false,
};

/** The refusal a scenario scripts as a daemon's, thrown verbatim by the seam. */
export const DAEMON_REFUSAL: WireErrorEnvelope = {
  code: "workflow.run_not_cancellable",
  message: "That run already reached a terminal state.",
};

/** One `workflow.runCancel` the case settles by hand, and what it was asked. */
export interface HeldCancel {
  readonly growth: GrowthPort;
  readonly requests: Parameters<GrowthPort["workflowRunCancel"]>[0][];
  readonly serve: () => void;
  readonly refuseAsDaemon: () => void;
}

/**
 * A port whose cancel stays in flight until the case settles it.
 *
 * The window between dispatch and answer is where single flight, the retarget drop and
 * the `dispatching` state all live, and a port that answered on the calling turn would
 * close it before any of them could be observed.
 */
export function heldCancelPort(): HeldCancel {
  const requests: Parameters<GrowthPort["workflowRunCancel"]>[0][] = [];
  let serveHeld: (() => void) | undefined;
  let refuseHeld: (() => void) | undefined;
  const growth: GrowthPort = {
    ...createRefusingGrowthPort(),
    workflowRunCancel: async (request) => {
      requests.push(request);
      return new Promise((resolve, reject) => {
        serveHeld = () => {
          resolve({ status: "served", value: CANCELLED });
        };
        refuseHeld = () => {
          reject(DAEMON_REFUSAL);
        };
      });
    },
  };
  return {
    growth,
    requests,
    serve: () => serveHeld?.(),
    refuseAsDaemon: () => refuseHeld?.(),
  };
}

function DispatchProbe(props: {
  readonly growth: GrowthPort;
  readonly workflowRunId: string | undefined;
  readonly onObserve: (controls: WorkflowRunControls) => void;
}): React.JSX.Element {
  // No version chain: no registered read maps a run's version id to its chain, so the
  // pane supplies none and the re-pin picker is absent rather than empty. A case that
  // needs one drives `OperatorControls` directly, where the chain is a prop.
  props.onObserve(useRunControlDispatch(props.growth, props.workflowRunId, []));
  return <></>;
}

/** The controls as the latest render saw them, plus the handle a retarget needs. */
export function observeControls(
  growth: GrowthPort,
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
    <DispatchProbe growth={growth} workflowRunId={workflowRunId} onObserve={collect} />,
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
      view.rerender(<DispatchProbe growth={growth} workflowRunId={next} onObserve={collect} />);
    },
  };
}
