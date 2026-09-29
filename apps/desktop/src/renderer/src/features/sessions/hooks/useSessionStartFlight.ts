// One session create at a time, and what a second press meets while one is running.
//
// A SECOND PRESS HAS TO BE REFUSED. A press while the first create is still in flight
// would put a second durable session beside the first: one press too many would cost
// a person two sessions and give them one.
//
// SO THE ACT TAKES A KEY, AND THE KEY IS THE CONSOLE'S ONE REGISTER.
// `lib/reads/generation-latch.ts` owns it. A boolean here would be the copy that drifts,
// and — the reason the register exists at all — a rendered boolean cannot refuse the
// second press in the first press's own frame: the handler reads the flag from the
// render that produced it, so both presses find the control idle. `claim` decides and
// takes in one act, inside the tick, which is what actually refuses.
//
// BOTH HALVES, ON `useDaemonControl`'s PRECEDENT. The taken key is what refuses; the
// rendered `isOutstanding` is what disables the control and names why. They are one
// fact with two audiences and they move together here rather than in a component.
//
// THE KEY COMES BACK ON EVERY SETTLEMENT, CREATED OR REFUSED. A create that refused
// produced no session and still ended the act, so every settlement releases —
// released on the created arm alone, a single refusal would leave Start disabled for
// the life of the destination with the reason nowhere on screen.
//
// AND WHERE NOTHING IS DISPATCHED, NOTHING IS HELD. When the caller's mount puts no
// call there is no act to single-flight and no settlement will ever arrive; a key
// taken there would never come back. The caller says so with `putsTheCall`, and this
// hook is then a no-op that always admits.

import { useCallback, useMemo, useRef, useState } from "react";

import { useGenerationLatch } from "@renderer/hooks/useGenerationLatch.js";
import { type GenerationClaim } from "@renderer/lib/reads/generation-latch.js";

/**
 * The one act this destination has in flight per bridge: creating a session.
 *
 * A key inside the bridge's own key space rather than an identity, per
 * `lib/reads/generation-latch.ts`: one window creates one session at a time.
 */
const SESSION_CREATE_KEY = "session-create";

/** The single-flight key the start act takes, as a control reads and drives it. */
export interface SessionStartFlight {
  /** Whether a create this window put is still running. What disables the control. */
  readonly isOutstanding: boolean;
  /**
   * Take the key, and answer whether this press may dispatch.
   *
   * `false` is a refusal and not a queue: the create already running is the one the
   * person asked for, and a press held and applied afterwards would be a second
   * durable session nobody re-confirmed.
   */
  readonly admit: () => boolean;
  /** Give the key back. Told on every settlement, both arms. */
  readonly settle: () => void;
}

/**
 * Hold one session-create key for the life of a mount.
 *
 * `putsTheCall` is the caller's answer to whether the mount it drives dispatches
 * anything in this window, and a `false` makes every press admissible and holds
 * nothing, because a key released by a settlement that will never arrive is a control
 * that dies on its first press.
 */
export function useSessionStartFlight(subject: object, putsTheCall: boolean): SessionStartFlight {
  const latch = useGenerationLatch();
  // The taken key, held so the settlement that arrives later can give the same one
  // back. A cell rather than an async closure's local — `useDaemonControl` awaits its
  // own call and needs neither — because the settlement here is reported by the
  // caller, one commit or many after the press that took the key.
  const outstandingClaim = useRef<GenerationClaim | undefined>(undefined);
  const [isOutstanding, setIsOutstanding] = useState(false);

  const admit = useCallback((): boolean => {
    if (!putsTheCall) {
      return true;
    }
    const claim = latch.claim(subject, SESSION_CREATE_KEY);
    if (claim === undefined) {
      return false;
    }
    outstandingClaim.current = claim;
    setIsOutstanding(true);
    return true;
  }, [latch, putsTheCall, subject]);

  const settle = useCallback((): void => {
    const claim = outstandingClaim.current;
    outstandingClaim.current = undefined;
    setIsOutstanding(false);
    // Total and idempotent by the register's own contract, so a settlement arriving
    // for a round something else has superseded frees nothing that is not its own.
    claim?.release();
  }, []);

  return useMemo(
    () => ({ isOutstanding: putsTheCall && isOutstanding, admit, settle }),
    [admit, isOutstanding, putsTheCall, settle],
  );
}
