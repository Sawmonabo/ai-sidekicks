// Step in: take the work from an agent in one move.
//
// One control, three acts: pause the run, put the run's execution root on the deck,
// and open this run's own detail in the pane that mounts the control. The person
// presses once; the console does the three things they would otherwise do in sequence
// and then tells them what happened.
//
// ONE OF THE THREE BELONGS TO ANOTHER FAMILY, AND TRAVELS AS A SEAT. Which panes are
// open and which one is focused are facts about the deck, and the composer resolves
// what it is addressed to from the focused pane — so that act is the workspace's,
// reached through `seats/slots/take-the-floor-seat.ts` rather than through an import a
// sibling view family may not make. An unfilled seat means no deck is mounted in this
// window, which the receipt states rather than swallowing.
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
// WHAT THE CONTROL STILL HOLDS is the token its own dispatch was admitted under and
// the deck's answer to the act that token settled, and nothing else: the in-flight
// reading and the settlement record both belong to the surface, which already rotates
// them by bridge. Both are held under `(bridge, targetRunId)` so a replaced transport
// — and a row reused for another run — reads that subject's own seed rather than the
// previous one's answer.

import { useCallback, useEffect } from "react";
import { type ConsoleBridge } from "../../../bridge/index.js";
import { Glyph, useLatestRef } from "../../../primitives/index.js";
import { takeTheFloor, type TakeTheFloorOutcome } from "../../../seats/index.js";
import { GLYPH_SIZE_ROW } from "../../../tokens/index.js";
import { useSubjectScopedState } from "../../../store/index.js";
import { StepInReceipt } from "./StepInReceipt.js";
import { readStepInState } from "./step-in-state.js";
import { type RunControlSurface } from "./run-control-surface.js";

/** The deck's answer, kept beside the token whose settlement asked for it. */
interface SettledFloor {
  readonly dispatchToken: string;
  readonly outcome: TakeTheFloorOutcome;
}

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
   * Open this run's own detail in the pane that mounts this control.
   *
   * The pane-LOCAL half, and the only half the runs family owns: the deck's act
   * travels through the floor seat instead. Called only after the pause settles, for
   * the reason that act is — disclosing a run's history while the pause is still in
   * flight would show a run that is still running under a control that says it is not.
   */
  readonly onTakeTheFloor: () => void;
}

export function StepIn(props: StepInProps): React.JSX.Element {
  const { bridge, surface, targetRunId, expectedRunVersion, onTakeTheFloor } = props;
  const { value: dispatchToken, publish: publishDispatchToken } = useSubjectScopedState<
    string | undefined
  >(bridge, targetRunId, () => undefined);
  const { value: settledFloor, publish: publishSettledFloor } = useSubjectScopedState<
    SettledFloor | undefined
  >(bridge, targetRunId, () => undefined);
  const state = readStepInState(
    surface,
    targetRunId,
    dispatchToken,
    // Read back only for the token that ASKED for it. A row reused for a second
    // step-in on the same subject would otherwise draw the previous pause's checkout
    // sentence beside the new pause's figures.
    settledFloor?.dispatchToken === dispatchToken ? settledFloor?.outcome : undefined,
  );

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
  const takeTheFloorHandler = useLatestRef(onTakeTheFloor);
  const acknowledgedToken = state.phase === "paused" ? dispatchToken : undefined;
  useEffect(() => {
    if (acknowledgedToken === undefined) {
      return;
    }
    takeTheFloorHandler.current();
    // THE DECK'S ANSWER LANDS ONLY WHERE THE PAUSE DID. The publisher was captured at
    // the render that dispatched, so a settlement measured against a retired transport
    // or a re-addressed row is dropped rather than drawn — the same rule that keeps a
    // stale receipt off the render.
    let stillMounted = true;
    void takeTheFloor({ runId: targetRunId }).then((outcome) => {
      if (!stillMounted) {
        return;
      }
      publishSettledFloor({ dispatchToken: acknowledgedToken, outcome });
    });
    return () => {
      stillMounted = false;
    };
  }, [acknowledgedToken, publishSettledFloor, takeTheFloorHandler, targetRunId]);

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
