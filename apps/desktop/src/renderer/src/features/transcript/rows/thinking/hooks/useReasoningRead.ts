// The read a reasoning row makes on demand, and the state it holds.
// It is issued only when a reader asks: one call per rendered reasoning row would put a call on
// every row in a scrolled window. `callDaemon` answers `served` or `refused`; the hook holds
// either, so a refusal can be shown and asked again.

import { useCallback, useState } from "react";

import { callDaemon } from "@renderer/services/daemon/daemon-reply.js";
import { useReadScope } from "@renderer/hooks/useReadScope.js";
import { usePlatformBridge } from "@renderer/services/platform/hooks/usePlatformBridge.js";
import type { RunId } from "@ai-sidekicks/contracts/provider-driver";
import { type ReasoningReading } from "../reasoning-reading.js";

/** The reading a row holds, and the call that advances it. */
export interface ReasoningRead {
  readonly reading: ReasoningReading;
  readonly expand: () => void;
}

/**
 * Hold one row's reasoning reading.
 *
 * `not-asked` until a reader presses the control; a press while a read is in flight is a no-op.
 * A refusal is retryable (its causes include a briefly down transport) and a settled read is not
 * (the answer is on screen and the row holds no continuation cursor). The read runs in a scope
 * keyed on `(bridge, runId)`, so a transport replacement or a row re-addressed at another run
 * drops the outstanding reply, including `callDaemon`'s `read-abandoned` refusal, which is not
 * a failure to offer a retry for.
 */
export function useReasoningRead(runId: RunId | undefined): ReasoningRead {
  const bridge = usePlatformBridge();
  const [reading, setReading] = useState<ReasoningReading>({ status: "not-asked" });
  const readScope = useReadScope(bridge, runId);

  const expand = useCallback(() => {
    // Lists the two refusing states so a new reading arm is retryable by default, not inert.
    if (runId === undefined || reading.status === "reading" || reading.status === "read") {
      return;
    }
    // Opened after the guard: a dropped press must not end the read already in flight.
    const round = readScope.openRound();
    setReading({ status: "reading" });
    void callDaemon(
      bridge,
      "transcript.reasoningSurfaceRead",
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
