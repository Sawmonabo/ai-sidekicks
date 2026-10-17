// The workflows screen's side of a step back off a gone session: the standing line, whether it is
// placed yet, and whether a drawn control has taken it, which leaves the body's top without it.

import { useCallback, useMemo, useState } from "react";

import {
  useGoneSessionRaise,
  type StandingGoneSessionRaise,
} from "#renderer/store/window/hooks/useGoneSessionRaise.js";
import type { WindowStore } from "#renderer/store/window/store.js";
import type { GoneSessionStepBack } from "../gone-session-step-back.js";

/** What the screen hands its controls, and the line the top of its body draws. */
export interface GoneSessionStepBackReading {
  readonly stepBack: GoneSessionStepBack;
  /** The line at the top of the body, once placed there; `undefined` otherwise. */
  readonly bodyTopRaise: StandingGoneSessionRaise | undefined;
}

/**
 * The step back's line on the screen. `awaitsRunPage` holds the line until a run's page settles
 * it; any other view places it at once.
 */
export function useGoneSessionStepBack(
  frameStore: WindowStore,
  awaitsRunPage: boolean,
): GoneSessionStepBackReading {
  const raise = useGoneSessionRaise(frameStore);
  const raisedKey = raise?.raisedKey;
  const [claimCount, setClaimCount] = useState(0);
  const [settledKey, setSettledKey] = useState<string | undefined>(undefined);
  const claim = useCallback(() => {
    setClaimCount((count) => count + 1);
    return () => {
      setClaimCount((count) => count - 1);
    };
  }, []);
  const settle = useCallback(() => {
    setSettledKey(raisedKey);
  }, [raisedKey]);
  const isPlaced = raise !== undefined && (!awaitsRunPage || settledKey === raisedKey);
  const bodyTopRaise = isPlaced && claimCount === 0 ? raise : undefined;
  // Once at the top, a control drawn later leaves it there, so the line is said in one place.
  const controlRaise = bodyTopRaise === undefined ? raise : undefined;
  const stepBack = useMemo(
    () => ({ raise: controlRaise, claim, settle }),
    [controlRaise, claim, settle],
  );
  return { stepBack, bodyTopRaise };
}
