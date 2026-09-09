// One session create at a time, and what a second press meets while one is running.
//
// THE PRESS COUNT WAS THE WHOLE MECHANISM AND IT COULD NOT REFUSE. The sessions
// destination mounts the absorbed probe keyed on how many times Start has been
// pressed, and the probe creates a session from its own mount effect — so a second
// press while the first create was still in flight bumped the key, React unmounted
// the first probe, its cleanup set the `cancelled` flag that suppresses `onCreated`,
// and a durable session was created that no surface ever learned the name of: not
// opened, not recorded, not navigated to, and absent from the all-sessions list until
// the window came down. Meanwhile a SECOND session was created beside it. One press
// too many cost a person two sessions and gave them one.
//
// SO THE ACT TAKES A KEY, AND THE KEY IS THE CONSOLE'S ONE REGISTER.
// `store/read/generation-latch.ts` owns it. A boolean here would be the copy that drifts,
// and — the reason the register exists at all — a rendered boolean cannot refuse the
// second press in the first press's own frame: the handler reads the flag from the
// render that produced it, so both presses find the surface idle. `claim` decides and
// takes in one act, inside the tick, which is what actually refuses.
//
// BOTH HALVES, ON `useDaemonControl`'s PRECEDENT. The taken key is what refuses; the
// rendered `isOutstanding` is what disables the control and names why. They are one
// fact with two audiences and they move together here rather than in a surface.
//
// THE SLOT COMES BACK ON EVERY SETTLEMENT, CREATED OR REFUSED. A create that refused
// produced no session and still ended the act, so the probe's `onSettled` is what
// releases — released on the created arm alone, a single refusal would leave Start
// disabled for the life of the destination with the reason nowhere on screen, which
// is the failure `settings/pages/daemon/daemon-controls.ts` records having shipped
// once already.
//
// AND WHERE NOTHING IS DISPATCHED, NOTHING IS HELD. Under the fixture the probe's
// guard renders an absence and puts no call, so there is no act to single-flight and
// no settlement will ever arrive; a slot taken there would never come back. The
// caller passes `seats/surface/absorbed-surfaces.ts`' own predicate rather than re-deriving
// it, and this hook is a no-op that always admits.

import { useCallback, useMemo, useRef, useState } from "react";

import { useGenerationLatch, type GenerationClaim } from "../../store/index.js";

/**
 * The one act this destination has in flight per bridge: creating a session.
 *
 * A key inside the bridge's own key space rather than an identity, per
 * `store/read/generation-latch.ts`: one window creates one session at a time.
 */
const SESSION_CREATE_KEY = "session-create";

/** What a control carries while a create this window put is still running. */
export const SESSION_CREATE_OUTSTANDING_SENTENCE =
  "A session is being created. The control comes back as soon as the runtime answers, and pressing again would create a second session.";

/** The single-flight slot the start act takes, as a surface reads and drives it. */
export interface SessionStartFlight {
  /** Whether a create this window put is still running. What disables the control. */
  readonly isOutstanding: boolean;
  /**
   * Take the slot, and answer whether this press may dispatch.
   *
   * `false` is a refusal and not a queue: the create already running is the one the
   * person asked for, and a press held and applied afterwards would be a second
   * durable session nobody re-confirmed.
   */
  readonly admit: () => boolean;
  /** Give the slot back. Told on every settlement the probe reports, both arms. */
  readonly settle: () => void;
}

/**
 * Hold one session-create slot for the life of a mount.
 *
 * `putsTheCall` is the caller's answer to whether the mount it drives dispatches
 * anything in this window — `seats/surface/absorbed-surfaces.ts` owns that condition — and a
 * `false` makes every press admissible and holds nothing, because a slot released by
 * a settlement that will never arrive is a control that dies on its first press.
 */
export function useSessionStartFlight(subject: object, putsTheCall: boolean): SessionStartFlight {
  const latch = useGenerationLatch();
  // The taken key, held so the settlement that arrives from the probe can give the
  // same one back. A cell rather than an async closure's local — `useDaemonControl`
  // awaits its own call and needs neither — because the settlement here is reported by
  // a child component, one commit or many after the press that took the key.
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
