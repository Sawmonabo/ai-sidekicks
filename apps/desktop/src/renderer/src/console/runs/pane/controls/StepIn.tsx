// Step in: take the work from an agent in one move.
//
// One control, three acts: pause the run, put the run's execution root on the deck,
// and address the composer at that run as a steer. The person presses once; the
// console does the three things they would otherwise do in sequence and then tells
// them what happened.
//
// TWO OF THE THREE BELONG TO ANOTHER FAMILY, AND TRAVEL AS A SEAT. Which panes are
// open and which one is focused are facts about the deck, and the composer resolves
// what it is addressed to from the focused pane — so both acts are the workspace's,
// reached through `seats/take-the-floor-seat.ts` rather than through an import a
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
// AND ITS STATE BELONGS TO THE TRANSPORT AND THE RUN, not to the mount. The control
// used to hold a mount-scoped `useState` and a hand-rolled in-flight boolean, and
// `RunControls` keys its children by run — so a bridge replaced while a pause was
// parked left this component mounted, and the retired transport's acknowledgment
// settled into the live render and moved the floor to a run the current connection
// had said nothing about. Both halves now come from the console's own primitives,
// exactly as `compaction-dispatch.ts` takes them: the reading is held under
// `(bridge, targetRunId)` so a replacement drops it, the publisher is the captured
// `settle()` so a settlement measured against a retired visit is dropped rather
// than rendered, and the single-flight rule is one `GenerationLatch` claim per
// `(bridge, runId)` released in the settlement's own `finally`-shaped position.

import { useCallback } from "react";
import { refuse } from "../../../core/index.js";
import { callDaemon, readRunId, type ConsoleBridge } from "../../../bridge/index.js";
import { Glyph } from "../../../primitives/index.js";
import { takeTheFloor } from "../../../seats/index.js";
import { GLYPH_SIZE_ROW } from "../../../tokens/index.js";
import { useGenerationLatch, useSubjectScopedState } from "../../../store/index.js";
import { StepInReceipt } from "./StepInReceipt.js";
import { STEP_IN_REFUSAL_ORIGIN, type StepInState } from "./step-in-state.js";

export interface StepInProps {
  readonly bridge: ConsoleBridge;
  /** The run to take over, and the version guard the daemon compares against. */
  readonly targetRunId: string;
  readonly expectedRunVersion: number;
  /** Whose work it is, as the session named them. Rendered, never composed. */
  readonly agentLabel: string;
  /**
   * Open this run's own detail in the pane that mounts this control.
   *
   * The pane-LOCAL half, and the only half the runs family owns: the deck's two acts
   * travel through the floor seat instead. Called only after the pause settles, for
   * the reason both moves are — disclosing a run's history while the pause is still
   * in flight would show a run that is still running under a control that says it is
   * not.
   */
  readonly onTakeTheFloor: () => void;
}

const IDLE: StepInState = { phase: "idle" };

/** The latch key one step-in round is claimed under, within its bridge. */
function stepInLatchKey(targetRunId: string): string {
  return `step-in:${targetRunId}`;
}

export function StepIn(props: StepInProps): React.JSX.Element {
  const { bridge, targetRunId, expectedRunVersion, onTakeTheFloor } = props;
  const {
    value: state,
    publish: publishState,
    settle: captureVisit,
  } = useSubjectScopedState<StepInState>(bridge, targetRunId, () => IDLE);
  const latch = useGenerationLatch();

  const stepIn = useCallback(() => {
    const parsedRunId = readRunId(targetRunId);
    if (parsedRunId === undefined) {
      publishState({
        phase: "refused",
        refusal: refuse(
          STEP_IN_REFUSAL_ORIGIN,
          "addressed-run-unparseable",
          "The console is holding an identifier for this run that the daemon would not accept, so it asked for no pause. Reopen the session so its identifiers are read again.",
        ),
      });
      return;
    }
    const claim = latch.claim(bridge, stepInLatchKey(targetRunId));
    if (claim === undefined) {
      // A second press while this run's pause is in flight: the no-op the
      // single-flight rule asks for. A press after the transport was replaced is a
      // first press on a new subject's latch and dispatches.
      return;
    }
    // Captured before the call rather than after it, so the publisher names the visit
    // that dispatched: a settlement arriving after the bridge was replaced is dropped
    // by the holder instead of being rendered as this run's live state.
    const publishSettlement = captureVisit();
    publishSettlement({ phase: "pausing" });
    // The door parses both directions and never rejects, so the whole settlement is
    // one branch: a refusal — the daemon's own code, or the door's `reply-unreadable`
    // — renders verbatim, and a served acknowledgment is what the receipt is composed
    // from. The floor moves only on the served arm AND only where the receipt was
    // actually installed: the holder refuses the function form of a publish WITHOUT
    // RUNNING it, so an update that ran is exactly the answer to "is this visit still
    // on screen" — and a retired transport's acknowledgment therefore moves no
    // cursor, which is the half a render-only guard would have left open.
    void callDaemon(bridge, "run.pause", {
      targetRunId: parsedRunId,
      expectedRunVersion,
    }).then(async (reply) => {
      let wasStillAddressed = false;
      claim.settle(() => {
        if (reply.status === "refused") {
          publishSettlement({ phase: "refused", refusal: reply.refusal });
          return;
        }
        publishSettlement(() => {
          wasStillAddressed = true;
          return { phase: "paused", acknowledgment: reply.value, floor: undefined };
        });
        if (wasStillAddressed) {
          onTakeTheFloor();
        }
      });
      // THE DECK MOVES ONLY WHERE THE PAUSE LANDED ON SCREEN. `wasStillAddressed` is
      // the holder's own answer to "is this visit still the live one", so a settlement
      // measured against a retired transport rearranges no panes — the same rule that
      // keeps its receipt off the render.
      if (reply.status === "served" && wasStillAddressed) {
        const floor = await takeTheFloor({ runId: targetRunId });
        claim.settle(() => {
          publishSettlement({ phase: "paused", acknowledgment: reply.value, floor });
        });
      }
      // Released after the deck has answered, not after the pause: a second press
      // while the execution-root read is open would pause an already-paused run and
      // move the deck a second time under the person's hands.
      claim.release();
    });
  }, [bridge, captureVisit, expectedRunVersion, latch, onTakeTheFloor, publishState, targetRunId]);

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
