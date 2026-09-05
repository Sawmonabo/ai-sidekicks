// Step in: take the work from an agent in one move.
//
// One control, three acts: pause the run, focus the run's own pane, and focus the
// composer addressed to it. The person presses once; the console does the three
// things they would otherwise do in sequence and then tells them what happened.
//
// THE PAUSE IS `run.pause`, NOT AN INTERVENTION ARM. The registered intervention
// payload is a discriminated union over `steer | interrupt | cancel | rollback`,
// and pause and resume are separate request types by design. A control that sent
// `{ type: "pause" }` through the intervention verb would be sending a shape that
// union has no arm for, and the daemon would refuse it — so the wire's own registry
// decides this, not the sketch.
//
// THE RECEIPT NAMES WHO AND WHEN, and it is composed from the acknowledgment rather
// than from what the console hoped would happen: the daemon echoes the post-
// transition state and the advanced run version, and both are rendered as sent.
//
// IT NEVER TAKES THE TERMINAL LEASE. There is no lease call in this file and no
// prop that could carry one. Where a session's lease matters, the lease glyph says
// who holds it, and stepping in changes nothing about that — a person who has the
// floor still has to ask for the terminal.

import { useCallback, useRef, useState } from "react";
import { RunControlAckSchema, type RunControlAck } from "@ai-sidekicks/contracts";
import { wireRejectionToError } from "../../../../../shared/wire-errors.js";
import { refuse, type ConsoleRefusal } from "../../../console/core/index.js";
import {
  RUN_PAUSE_METHOD,
  callUnregisteredDaemonMethod,
  type ConsoleBridge,
} from "../../../console/bridge/index.js";
import { Glyph, InlineRefusal, WireFigure } from "../../../console/primitives/index.js";

/** The subsystem name every refusal this control raises carries. */
export const STEP_IN_REFUSAL_ORIGIN = "composer-step-in";

export interface StepInProps {
  readonly bridge: ConsoleBridge;
  /** The run to take over, and the version guard the daemon compares against. */
  readonly targetRunId: string;
  readonly expectedRunVersion: number;
  /** Whose work it is, as the session named them. Rendered, never composed. */
  readonly agentLabel: string;
  /**
   * Focus the run's pane and the composer addressed to it.
   *
   * One callback for both moves rather than two, because they are one act from the
   * person's side and because the surface that mounts this control is the only
   * thing that knows where either target is. Called only after the pause settles:
   * moving focus while the request is still in flight would put the cursor in a
   * composer addressed to a run that is still running.
   */
  readonly onTakeTheFloor: () => void;
}

type StepInState =
  | { readonly phase: "idle" }
  | { readonly phase: "pausing" }
  | { readonly phase: "paused"; readonly acknowledgment: RunControlAck }
  | { readonly phase: "refused"; readonly refusal: ConsoleRefusal };

const STEP_IN_GLYPH_SIZE = 12;

export function StepIn(props: StepInProps): React.JSX.Element {
  const [state, setState] = useState<StepInState>({ phase: "idle" });
  const isInFlight = useRef(false);
  const { bridge, targetRunId, expectedRunVersion, onTakeTheFloor } = props;

  const stepIn = useCallback(() => {
    if (isInFlight.current) {
      return;
    }
    isInFlight.current = true;
    setState({ phase: "pausing" });
    void callUnregisteredDaemonMethod(bridge, RUN_PAUSE_METHOD, { targetRunId, expectedRunVersion })
      .then((reply) => {
        isInFlight.current = false;
        const parsed = RunControlAckSchema.safeParse(reply);
        if (!parsed.success) {
          setState({
            phase: "refused",
            refusal: refuse(
              STEP_IN_REFUSAL_ORIGIN,
              "reply-unreadable",
              "The pause reply did not match the registered acknowledgment shape, so the console did not read a transition from it.",
            ),
          });
          return;
        }
        setState({ phase: "paused", acknowledgment: parsed.data });
        onTakeTheFloor();
      })
      .catch((rejection: unknown) => {
        isInFlight.current = false;
        const wireError = wireRejectionToError(rejection, { total: true });
        setState({
          phase: "refused",
          refusal: refuse(STEP_IN_REFUSAL_ORIGIN, wireError.name, wireError.message),
        });
      });
  }, [bridge, targetRunId, expectedRunVersion, onTakeTheFloor]);

  return (
    <div className="meridian-step-in">
      <button
        type="button"
        className="meridian-step-in__action"
        aria-busy={state.phase === "pausing"}
        onClick={stepIn}
      >
        <Glyph name="pause" size={STEP_IN_GLYPH_SIZE} />
        Step in
      </button>
      <StepInReceipt agentLabel={props.agentLabel} state={state} />
    </div>
  );
}

/** What happened, said once, in the daemon's own figures. */
function StepInReceipt(props: {
  readonly agentLabel: string;
  readonly state: StepInState;
}): React.JSX.Element | null {
  const { state } = props;
  if (state.phase === "refused") {
    return <InlineRefusal code={state.refusal.code} detail={state.refusal.detail} />;
  }
  if (state.phase !== "paused") {
    return null;
  }
  return (
    <span className="meridian-step-in__receipt" role="status">
      Paused {props.agentLabel} at <WireFigure value={state.acknowledgment.currentState} />, version{" "}
      <WireFigure value={String(state.acknowledgment.runVersion)} />. You have the floor.
    </span>
  );
}
