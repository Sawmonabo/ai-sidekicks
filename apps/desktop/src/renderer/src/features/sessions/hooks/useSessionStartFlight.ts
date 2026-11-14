// One session create at a time. A second press while the first create is in flight would put
// a second durable session beside the first.
//
// The act takes a key from `lib/reads/generation-latch.ts`, whose `claim` decides and takes in
// one act inside the tick. A rendered boolean cannot refuse a second press in the first
// press's own frame, because the handler reads the flag from the render that produced it.
// The taken key refuses; the rendered `isOutstanding` holds the picker's rows.
//
// The key comes back on every settlement, created or refused; released on the created arm
// alone, one refusal would leave the picker's rows held with no reason on screen.

import { useCallback, useMemo, useRef, useState } from "react";

import { useGenerationLatch } from "#renderer/hooks/useGenerationLatch.js";
import { type GenerationClaim } from "#renderer/lib/reads/generation-latch.js";

/**
 * The one act this destination has in flight per bridge: creating a session. A key in the
 * bridge's key space rather than an identity, since one window creates one session at a time.
 */
const SESSION_CREATE_KEY = "session-create";

/** The single-flight key the start act takes, as a control reads and drives it. */
export interface SessionStartFlight {
  /** Whether a create this window put is still running. What holds the picker's rows. */
  readonly isOutstanding: boolean;
  /**
   * Take the key, and answer whether this press may dispatch. `false` is a refusal, not a
   * queue: a press held and applied afterwards would be a second session nobody re-confirmed.
   */
  readonly admit: () => boolean;
  /** Give the key back. Told on every settlement, both arms. */
  readonly settle: () => void;
}

/** Hold one session-create key for the life of a mount, on `subject`'s key space. */
export function useSessionStartFlight(subject: object): SessionStartFlight {
  const latch = useGenerationLatch();
  // The taken key, held so the later settlement gives back the same one. A ref, because the
  // caller reports the settlement one commit or many after the press.
  const outstandingClaim = useRef<GenerationClaim | undefined>(undefined);
  const [isOutstanding, setIsOutstanding] = useState(false);

  const admit = useCallback((): boolean => {
    const claim = latch.claim(subject, SESSION_CREATE_KEY);
    if (claim === undefined) {
      return false;
    }
    outstandingClaim.current = claim;
    setIsOutstanding(true);
    return true;
  }, [latch, subject]);

  const settle = useCallback((): void => {
    const claim = outstandingClaim.current;
    outstandingClaim.current = undefined;
    setIsOutstanding(false);
    // Total and idempotent by the latch's contract, so a superseded round frees nothing else.
    claim?.release();
  }, []);

  return useMemo(() => ({ isOutstanding, admit, settle }), [admit, isOutstanding, settle]);
}
