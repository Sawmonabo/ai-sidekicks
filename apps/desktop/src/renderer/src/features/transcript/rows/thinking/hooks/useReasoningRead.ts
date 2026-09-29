// The read a reasoning row makes, and the state it holds.
//
// A READ AND NOTHING ELSE: it runs on a line that ENDS, and it names the round that ends
// it, so its whole relationship with cancellation can be read off its imports.
//
// THE METHOD IS A REGISTERED WIRE, which is why it is reached through `callDaemon`:
// `timeline.reasoningSurfaceRead` has request and response schemas the contracts
// package publishes, so a refusal here is a real refusal from a real parse. It
// additionally answers a CLOSED four-arm discriminant, so there is nothing for a
// component above to narrow by hand — the parse either produces one of the four arms or
// refuses.
//
// NO SUBSCRIPTION, NO POLL, NO PREFETCH. The read is issued when a reader asks for it
// and never before: it is a per-run read whose answer is policy-decided daemon-side,
// and issuing one per rendered row would put a call on every reasoning row in a
// scrolled window for an answer nobody asked to see.
//
// AND IT IS NOT FIRE-AND-FORGET. `callDaemon` answers `served` or `refused` for every
// outcome a transport can have, so a caller that ignored the reply would have decided
// that a refusal looks exactly like a success — a read that was refused offered no way
// to ask again. This hook holds what came back, and the row above renders it.

import { useCallback, useState } from "react";

import { callDaemon } from "@renderer/services/daemon/daemon-reply.js";
import { useReadScope } from "@renderer/hooks/useReadScope.js";
import { usePlatformBridge } from "@renderer/services/platform/hooks/usePlatformBridge.js";
import type { RunId } from "@ai-sidekicks/contracts";
import { type ReasoningReading } from "../reasoning-reading.js";

/** The reading a row holds, and the call that advances it. */
export interface ReasoningRead {
  readonly reading: ReasoningReading;
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
 * row holds no continuation cursor to spend on the bounded page's tail, so a
 * second press would re-ask a question that has an answer. `refused` has no answer at
 * all, and its causes include a transport that was down for the moment the press
 * landed in — so the guard admits it, the refusal stays beside the control, and
 * pressing again issues a second read.
 *
 * AND THE READ IS ON A LINE THE ROW OWNS. A run's reasoning is read because somebody
 * pressed for it, and that somebody can leave the pane or move the transcript to another
 * run before the answer lands — at which point the reply is still parsed against its
 * registered schema and folded into a state nothing renders. The line is addressed at
 * `(bridge, runId)`, which is the pairing this reading is ABOUT: a transport
 * replacement retires every call in flight through it, and a row re-addressed at
 * another run is not asking the question the outstanding read answers. `round.settle`
 * is what replaces the bare publish, so neither a superseded answer nor `callDaemon`'s own
 * `read-abandoned` refusal reaches the control — a departure is not a refusal a reader
 * should be offered a retry for.
 */
export function useReasoningRead(runId: RunId | undefined): ReasoningRead {
  const bridge = usePlatformBridge();
  const [reading, setReading] = useState<ReasoningReading>({ status: "not-asked" });
  const readScope = useReadScope(bridge, runId);

  const expand = useCallback(() => {
    // Stated as the two states that REFUSE a press rather than as the two that admit
    // one, so a fifth reading arm added to the closed discriminant is retryable by
    // default rather than silently inert — the row's own fail-closed edge is that
    // it offers the read and renders whatever came back, never that it withholds one.
    if (runId === undefined || reading.status === "reading" || reading.status === "read") {
      return;
    }
    // OPENING THE ROUND IS THE SUPERSESSION, so it happens after the guard and not
    // before it: a press this hook DROPS must not end the read already in flight,
    // which is exactly what a round opened ahead of the guard would do.
    const round = readScope.openRound();
    setReading({ status: "reading" });
    void callDaemon(
      bridge,
      "timeline.reasoningSurfaceRead",
      { runId },
      { signal: round.signal },
    ).then((reply) => {
      round.settle(() => {
        setReading(
          reply.status === "served"
            ? { status: "read", response: reply.value }
            : { status: "refused", refusal: reply.refusal },
        );
      });
    });
  }, [bridge, readScope, reading.status, runId]);

  return { reading, expand };
}
