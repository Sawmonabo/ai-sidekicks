import { useEffect } from "react";

import type { DeckActs } from "../pane-layout-acts.js";
import { mountedDeck, type MountedDeckSeat } from "../mounted-pane-layouts.js";

/** Adopt the seat for as long as this deck is mounted. */
export function useMountedDeck(acts: DeckActs, seat: MountedDeckSeat = mountedDeck): void {
  useEffect(() => seat.adopt(acts), [acts, seat]);
}
