// The two calls the fixture shell's rows make, and the state each one holds.
//
// AND IT DIES WITH THE SHELL. Both hooks exist so the shell's rows are real against
// the fixture scenarios before the timeline subtree's own rows land; the change that
// registers those rows deletes this module with the rest of `shell/`.
//
// BOTH METHODS ARE REGISTERED WIRES, which is why they are reached through
// `callDaemon` and not through the growth port: `timeline.reasoningSurfaceRead` and
// `driver.respondToRequest` both have request and response schemas the contracts
// package publishes, so a refusal here is a real refusal from a real parse rather
// than the growth port's "no wire exists" refusal. The reasoning read additionally
// answers a CLOSED four-arm discriminant, so there is nothing for a surface above to
// narrow by hand — the parse either produces one of the four arms or refuses.
//
// NO SUBSCRIPTION, NO POLL, NO PREFETCH. The reasoning read is issued when a reader
// asks for it and never before: it is a per-run read whose answer is policy-decided
// daemon-side, and issuing one per rendered row would put a call on every reasoning
// row in a scrolled window for an answer nobody asked to see.
//
// AND NEITHER CALL IS FIRE-AND-FORGET, which is the property both hooks now share and
// neither had. `callDaemon` answers `served` or `refused` for every outcome a
// transport can have, so a caller that ignores the reply has decided that a refusal
// looks exactly like a success — a reasoning read that was refused offered no way to
// ask again, and an answer that never reached the driver left the run blocked with
// nothing on screen saying so. Each hook holds what came back, and the surface above
// renders it.

import { useCallback, useState } from "react";

import { callDaemon, useConsoleBridge } from "../../../bridge/index.js";
import type { RunId } from "@ai-sidekicks/contracts";
import {
  ASK_ANSWER_UNSENT,
  type DriverAskDelivery,
  type ReasoningSurfaceReading,
} from "../bodies/index.js";

/** The reading a row holds, and the call that advances it. */
export interface ReasoningSurfaceRead {
  readonly reading: ReasoningSurfaceReading;
  readonly expand: () => void;
}

/**
 * Hold one row's reasoning reading.
 *
 * `not-asked` is the initial state and the one a row keeps for its whole life unless
 * a reader presses the control, which is what makes this free for every row that is
 * never expanded. A second press while a read is in flight is a no-op rather than a
 * second call: the guard is on the state the render already branches on, so the
 * control and the guard cannot disagree about whether a read is running.
 *
 * A REFUSAL IS RETRYABLE AND A SETTLED READ IS NOT, and the two are different facts
 * rather than one "already asked". `read` has the daemon's answer on screen and this
 * surface holds no continuation cursor to spend on the bounded page's tail, so a
 * second press would re-ask a question that has an answer. `refused` has no answer at
 * all, and its causes include a transport that was down for the moment the press
 * landed in — so the guard admits it, the refusal stays beside the control, and
 * pressing again issues a second read.
 */
export function useReasoningSurfaceRead(runId: RunId | undefined): ReasoningSurfaceRead {
  const bridge = useConsoleBridge();
  const [reading, setReading] = useState<ReasoningSurfaceReading>({ status: "not-asked" });

  const expand = useCallback(() => {
    // Stated as the two states that REFUSE a press rather than as the two that admit
    // one, so a fifth reading arm added to the closed discriminant is retryable by
    // default rather than silently inert — the surface's own fail-closed edge is that
    // it offers the read and renders whatever came back, never that it withholds one.
    if (runId === undefined || reading.status === "reading" || reading.status === "read") {
      return;
    }
    setReading({ status: "reading" });
    void callDaemon(bridge, "timeline.reasoningSurfaceRead", { runId }).then((reply) => {
      setReading(
        reply.status === "served"
          ? { status: "read", response: reply.value }
          : { status: "refused", refusal: reply.refusal },
      );
    });
  }, [bridge, reading.status, runId]);

  return { reading, expand };
}

/** Where one ask's answer has got to, and the call that dispatches one. */
export interface DriverAskAnswer {
  readonly delivery: DriverAskDelivery;
  /** Deliver an answer, or do nothing where this row has none to deliver. */
  readonly answer: (response: string) => void;
}

/**
 * Deliver an answer to a provider-raised ask, and hold what the wire said about it.
 *
 * The response travels as the `unknown`-typed member the contract declares, so an
 * option's `value` and a participant's free text are one call rather than two paths.
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
export function useDriverAskAnswer(runId: RunId | undefined, askId: string): DriverAskAnswer {
  const bridge = useConsoleBridge();
  const [delivery, setDelivery] = useState<DriverAskDelivery>(ASK_ANSWER_UNSENT);
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
      setDelivery({ status: "delivering", response });
      // NO `catch` ARM ON EITHER CALL IN THIS MODULE, and its absence is the door's
      // contract rather than an omission: `callDaemon` answers `served` or `refused`
      // for every outcome a transport can have — a request the daemon would not
      // accept, a rejected call, a reply the registered schema does not admit — so a
      // `catch` here would be a branch nothing can reach.
      void callDaemon(bridge, "driver.respondToRequest", {
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
    [askId, bridge, delivery.status, runId],
  );

  return { delivery, answer };
}
