// Whether a line raised for one moment still stands. It goes at the next act anywhere in its
// window (a press, a key, a wheel turn or a touch drag), never on a timer, and a new key raises it
// again, so the same line said of another subject comes back.

import { useEffect, useState } from "react";

import { NEXT_ACT_EVENTS } from "#renderer/lib/next-act-events.js";
import { useOwnerWindow } from "./useOwnerWindow.js";

/**
 * Whether the line raised under `raisedKey` still stands: `undefined` raises nothing, and each new
 * key raises it once more. The next press, key, wheel turn or touch drag in the window puts it
 * away.
 */
export function useUntilNextAct(raisedKey: string | undefined): boolean {
  const ownerDocument = useOwnerWindow().document;
  const [putAwayKey, setPutAwayKey] = useState<string | undefined>(undefined);
  const isStanding = raisedKey !== undefined && putAwayKey !== raisedKey;
  useEffect(() => {
    if (!isStanding) {
      return undefined;
    }
    const putAway = (): void => {
      setPutAwayKey(raisedKey);
    };
    const options = { capture: true, passive: true } as const;
    for (const eventName of NEXT_ACT_EVENTS) {
      ownerDocument.addEventListener(eventName, putAway, options);
    }
    return () => {
      for (const eventName of NEXT_ACT_EVENTS) {
        ownerDocument.removeEventListener(eventName, putAway, options);
      }
    };
  }, [isStanding, raisedKey, ownerDocument]);
  return isStanding;
}
