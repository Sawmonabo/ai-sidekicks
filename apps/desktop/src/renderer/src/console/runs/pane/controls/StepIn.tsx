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
//
// AND IT DISPATCHES THROUGH THE PANE'S ONE SURFACE, WHICH IS THE WHOLE POINT. This
// control used to call `run.pause` itself, holding a `GenerationLatch` claim of its
// own under a `step-in:<runId>` key — and the palette contributes a `pause` row for
// the same run that goes through `RunControlSurface.dispatch` and its
// `<runId>:pause` claim. Two latches over one act admit each other: press the button
// and run the palette row while it is settling and both dispatch, minting two
// idempotency keys against one run version, which the wire reads as two distinct
// mutations rather than replays of one — they race to apply and the loser's stale
// refusal becomes the visible settlement. One dispatcher, one key, one latch is the
// rule `run-control-dispatch.ts` states for the six controls, and this is the sixth
// entry point rather than an exception to it.
//
// WHAT THE CONTROL STILL HOLDS is the token its own dispatch was admitted under, and
// nothing else: the in-flight reading and the settlement record both belong to the
// surface, which already rotates them by bridge. The token is held under
// `(bridge, targetRunId)` so a replaced transport — and a row reused for another run
// — reads that subject's own seed rather than the previous one's answer.

import { useCallback, useEffect } from "react";
import { type ConsoleBridge } from "../../../bridge/index.js";
import { Glyph, useLatestRef } from "../../../primitives/index.js";
import { GLYPH_SIZE_ROW } from "../../../tokens/index.js";
import { useSubjectScopedState } from "../../../store/index.js";
import { StepInReceipt } from "./StepInReceipt.js";
import { readStepInState } from "./step-in-state.js";
import { type RunControlSurface } from "./run-control-surface.js";

export interface StepInProps {
  /** Holds the token this control dispatched under, and rotates it with the transport. */
  readonly bridge: ConsoleBridge;
  /** The pane's one dispatcher and its in-flight latch, shared with the palette row. */
  readonly surface: RunControlSurface;
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

export function StepIn(props: StepInProps): React.JSX.Element {
  const { bridge, surface, targetRunId, expectedRunVersion, onTakeTheFloor } = props;
  const { value: dispatchToken, publish: publishDispatchToken } = useSubjectScopedState<
    string | undefined
  >(bridge, targetRunId, () => undefined);
  const state = readStepInState(surface, targetRunId, dispatchToken);

  const stepIn = useCallback(() => {
    const admission = surface.dispatch(targetRunId, "pause", (dispatcher) =>
      dispatcher.pause({ runId: targetRunId, expectedRunVersion }),
    );
    if (!admission.admitted) {
      // This run's pause is already going — pressed twice, or started from the
      // palette row for the same control. The single-flight rule's no-op, and the
      // button is already showing busy off the same reading that refused it.
      return;
    }
    publishDispatchToken(admission.dispatchToken);
  }, [surface, targetRunId, expectedRunVersion, publishDispatchToken]);

  // The floor moves on THIS control's own acknowledgment and on nothing else. Read
  // through a latest-ref so a re-rendered host handing over a fresh callback does not
  // re-run the effect and move focus a second time for one settlement.
  const takeTheFloor = useLatestRef(onTakeTheFloor);
  const acknowledgedToken = state.phase === "paused" ? dispatchToken : undefined;
  useEffect(() => {
    if (acknowledgedToken === undefined) {
      return;
    }
    takeTheFloor.current();
  }, [acknowledgedToken, takeTheFloor]);

  return (
    <div className="meridian-step-in">
      <button
        type="button"
        className="meridian-step-in__action"
        aria-busy={state.phase === "pausing"}
        onClick={stepIn}
      >
        <Glyph name="pause" size={GLYPH_SIZE_ROW} />
        Step in
      </button>
      <StepInReceipt agentLabel={props.agentLabel} state={state} />
    </div>
  );
}
