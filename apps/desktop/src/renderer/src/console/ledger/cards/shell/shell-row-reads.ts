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

import { useCallback, useState } from "react";

import { callDaemon, useConsoleBridge } from "../../../bridge/index.js";
import type { RunId } from "@ai-sidekicks/contracts";
import type { ReasoningSurfaceReading } from "../bodies/index.js";

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
 */
export function useReasoningSurfaceRead(runId: RunId | undefined): ReasoningSurfaceRead {
  const bridge = useConsoleBridge();
  const [reading, setReading] = useState<ReasoningSurfaceReading>({ status: "not-asked" });

  const expand = useCallback(() => {
    if (runId === undefined || reading.status !== "not-asked") {
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

/**
 * Deliver an answer to a provider-raised ask.
 *
 * The response travels as the `unknown`-typed member the contract declares, so an
 * option's `value` and a participant's free text are one call rather than two paths.
 * The reply is an acknowledgement that the answer reached the driver and is
 * deliberately not stored: the ask's terminal is the `driver_ask.responded` row's to
 * state, and a card that remembered "I answered" would show a settled ask the daemon
 * had not settled.
 */
export function useDriverAskAnswer(
  runId: RunId | undefined,
  askId: string,
): (response: string) => void {
  const bridge = useConsoleBridge();
  return useCallback(
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
      void callDaemon(bridge, "driver.respondToRequest", { runId, requestId: askId, response });
    },
    [askId, bridge, runId],
  );
}
