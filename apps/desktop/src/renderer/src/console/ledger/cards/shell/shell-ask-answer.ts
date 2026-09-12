// The answer an input-ask row delivers, and where that delivery has got to.
//
// A MODULE OF ITS OWN, BESIDE THE READ IT USED TO SIT WITH. `driver.respondToRequest`
// is a run-changing method by the console's own classification, and a durable act that
// reached the daemon has HAPPENED — the console's half of it is not the console's to
// give up on, so a module that dispatches one has no business naming read cancellation
// in any form. `shell-row-reads.ts` next door is a read on a line that ends, and it
// names the round that ends it. The two therefore live apart: the split is what makes
// each module's whole relationship with cancellation readable from its imports, and it
// is what a reviewer holds every dispatcher to.
//
// AND IT DIES WITH THE SHELL. This hook exists so the shell's ask rows are real
// against the fixture scenarios before the timeline subtree's own rows land; the
// change that registers those rows deletes this module with the rest of `shell/`.
//
// THE METHOD IS A REGISTERED WIRE, which is why it is reached through `callDaemon` and
// not through the growth port: `driver.respondToRequest` has request and response
// schemas the contracts package publishes, so a refusal here is a real refusal from a
// real parse rather than the growth port's "no wire exists" refusal.
//
// AND IT IS NOT FIRE-AND-FORGET. `callDaemon` answers `served` or `refused` for every
// outcome a transport can have, so a caller that ignored the reply would have decided
// that a refusal looks exactly like a success — an answer that never reached the
// driver left the run blocked with nothing on screen saying so. This hook holds what
// came back, and the surface above renders it.
//
// AND IT IS SUBJECT TO THE SAME OUTAGE RULE AS EVERY OTHER MUTATING CALL, which it was
// not. `driver.respondToRequest` is a member of `MUTATING_DAEMON_METHODS`, so the
// console's own registration already says a supervisor that is not serving closes this
// control — and this was the one dispatcher on that seam not asking. The two readings
// are the ones `store/shell/shell-mutation-block.ts` names and they answer different
// questions: the SUBSCRIBED block draws the control and rides it as its disabled
// reason, and the block read at the instant of the call decides whether the write is
// put, because a report landing between the render and the press leaves a
// render-captured guard reading `undefined` while the runtime has already stopped.
//
// A CLOSED CONTROL SETTLES AS A REFUSAL AND NOT AS SILENCE, through the same shape
// every other blocked mutation takes: the shell's own words, minted by
// `store/shell/shell-mutation-block.ts` so neither surface spells the origin. The
// user's text is carried on it exactly as a wire refusal carries it, so the
// draft survives and pressing again once the runtime is back IS the retry.

import { useCallback, useState } from "react";

import { callDaemon, useConsoleBridge } from "../../../bridge/index.js";
import type { RunId } from "@ai-sidekicks/contracts";
import {
  currentShellBlock,
  useShellBlockFor,
  shellBlockRefusal,
  type FrameStore,
  type MutatingDaemonMethod,
  type ShellMutationBlock,
} from "../../../store/index.js";
import { ASK_ANSWER_UNSENT, type DriverAskDelivery } from "../bodies/index.js";

/**
 * The wire method an answer travels, named once.
 *
 * The `satisfies` IS the binding:
 * `store/shell/shell-mutation-block.ts` is the console's registration of what a
 * supervisor's condition closes, so an answer that ever left that tuple stops
 * compiling here rather than quietly going back to being dispatchable through a
 * stopped shell.
 */
const ASK_ANSWER_METHOD = "driver.respondToRequest" satisfies MutatingDaemonMethod;

/** Where one ask's answer has got to, and the call that dispatches one. */
export interface DriverAskAnswer {
  readonly delivery: DriverAskDelivery;
  /**
   * Why the shell closes this ask's controls, or `undefined` while nothing does.
   *
   * The RENDER-time answer, subscribed so a supervisor going down or coming back moves
   * the controls. It decides how they are drawn and never whether a press is admitted —
   * see this module's header on why those are two questions.
   */
  readonly block: ShellMutationBlock | undefined;
  /** Deliver an answer, or do nothing where this row has none to deliver. */
  readonly answer: (response: string) => void;
}

/**
 * Deliver an answer to a provider-raised ask, and hold what the wire said about it.
 *
 * The response travels as the `unknown`-typed member the contract declares, so an
 * option's `value` and a user's free text are one call rather than two paths.
 *
 * THE ACKNOWLEDGEMENT IS HELD AND THE TERMINAL IS NOT. `DriverAckResult` is an empty
 * envelope, so a served reply means exactly that the answer reached the driver — and
 * that is what `accepted` records. The ask's own terminal stays the
 * `driver_ask.responded` row's to state: this hook settles no ask, and the card reads
 * its state from the row rather than from here.
 *
 * SINGLE-FLIGHT, AND NO SECOND ANSWER AFTER ONE LANDED. A press while a call is in
 * flight is answered with the state already on screen; a press after the driver
 * acknowledged is refused too, because the ask is answered and a second delivery
 * would be a second answer to a question that has one. A REFUSED answer is the case
 * both of those exist to leave open — nothing reached the driver, so pressing again
 * dispatches again.
 */
export function useDriverAskAnswer(
  frameStore: FrameStore,
  runId: RunId | undefined,
  askId: string,
): DriverAskAnswer {
  const bridge = useConsoleBridge();
  const [delivery, setDelivery] = useState<DriverAskDelivery>(ASK_ANSWER_UNSENT);
  // SUBSCRIBED, so a supervisor going down or coming back moves the controls without
  // waiting for a press, and asked per METHOD through the one seam that knows which
  // calls an outage closes.
  const block = useShellBlockFor(frameStore, ASK_ANSWER_METHOD);
  const answer = useCallback(
    (response: string) => {
      // BOTH GUARDS ARE FAIL-CLOSED AND NEITHER IS A CONVENIENCE. A row with no run
      // attribution names no run to answer for, and an empty ask id is what a caller
      // holds when the row it is on is not an ask at all — this hook is armed on every
      // row by the rules of hooks, so the empty id is the ordinary case rather than the
      // exceptional one. Sending either would put a request on the wire naming an ask
      // the daemon has no record of.
      if (runId === undefined || askId.length === 0) {
        return;
      }
      if (delivery.status === "delivering" || delivery.status === "accepted") {
        return;
      }
      // READ NOW AND NOT OFF THE RENDER, which is the whole reason this guard is here
      // rather than only on the control: the block the arms were drawn under is the
      // block of the last COMMITTED render, and a report landing between that render
      // and this press leaves the closure holding `undefined` while the supervisor has
      // already stopped. Settled as the shell's own refusal so the card says why the
      // press did nothing — silence here would look exactly like a driver that never
      // answered.
      const dispatchBlock = currentShellBlock(frameStore, ASK_ANSWER_METHOD);
      if (dispatchBlock !== undefined) {
        setDelivery({
          status: "refused",
          response,
          refusal: shellBlockRefusal(dispatchBlock),
        });
        return;
      }
      setDelivery({ status: "delivering", response });
      // NO `catch` ARM, and its absence is the door's contract rather than an
      // omission: `callDaemon` answers `served` or `refused` for every outcome a
      // transport can have — a request the daemon would not accept, a rejected call,
      // a reply the registered schema does not admit — so a `catch` here would be a
      // branch nothing can reach.
      void callDaemon(bridge, ASK_ANSWER_METHOD, {
        runId,
        requestId: askId,
        response,
      }).then((reply) => {
        setDelivery(
          reply.status === "served"
            ? { status: "accepted", response }
            : { status: "refused", response, refusal: reply.refusal },
        );
      });
    },
    [askId, bridge, delivery.status, frameStore, runId],
  );

  return { block, delivery, answer };
}
