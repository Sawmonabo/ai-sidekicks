// The line a move off a gone session raises on the screen it landed on, while it stands: only on
// the route write it stands on, and until the next act anywhere in the window.

import { useMemo } from "react";

import { useUntilNextAct } from "#renderer/hooks/useUntilNextAct.js";
import { goneSessionRaiseOfThisMove, type GoneSessionRaise, type WindowStore } from "../store.js";
import { useWindowStore } from "./useWindowStore.js";

/** A standing raise, with the key its line is announced under. */
export interface StandingGoneSessionRaise extends GoneSessionRaise {
  readonly raisedKey: string;
}

/** The raise of the move that brought this window to its screen, or `undefined` once it goes. */
export function useGoneSessionRaise(frameStore: WindowStore): StandingGoneSessionRaise | undefined {
  const raise = useWindowStore(frameStore, goneSessionRaiseOfThisMove);
  const raisedKey = raise === undefined ? undefined : String(raise.raisedAt);
  const isStanding = useUntilNextAct(raisedKey);
  const standing = isStanding ? raise : undefined;
  // Kept while the raise stands, so a reader handing it on does not change on every render.
  return useMemo(
    () =>
      standing === undefined ? undefined : { ...standing, raisedKey: String(standing.raisedAt) },
    [standing],
  );
}
