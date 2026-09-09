// The React binding for the frame coordinator: one coordinator per feed, and the
// hook a composition mints it through.
//
// `frame-coordinator.ts` holds the mechanism — the phases, the coalescing, the
// deferral rule. This module holds the React side of it, on `reveal-binding.ts`' split
// and for the same reason: the coordinator arms work through the clock seam and knows
// nothing about renders.
//
// ONE PER FEED, AND WHY THAT IS THE RIGHT SCOPE. A frame is a paint, and what shares a
// paint is what shares a scroll surface — one feed's rows and one feed's lanes.
// Two feeds on screen are two boxes with two geometries, and ordering
// their writes against each other would be an ordering over nothing: neither one's
// reveal work moves the other's offsets. So the coordinator is minted where the feed
// is and disposed with it, exactly as that feed's reveal engine and viewport are.
//
// THE RE-MINT ARM IS THE SIBLINGS'. A replacement clock means every frame this
// coordinator would arm is armed on a scheduler nothing advances, so the coordinator
// is re-minted with it and the holders that captured one re-mint in turn.

import { useEffect, useState } from "react";

import { type ConsoleClock } from "../../../core/index.js";
import { LedgerFrameCoordinator } from "./frame-coordinator.js";

/** Mint one frame coordinator for a feed, and dispose it with the mount. */
export function useLedgerFrameCoordinator(clock: ConsoleClock): LedgerFrameCoordinator {
  const [frameCoordinator, setFrameCoordinator] = useState<LedgerFrameCoordinator>(
    () => new LedgerFrameCoordinator({ clock }),
  );

  useEffect(() => {
    if (frameCoordinator.isDisposed) {
      // A remount of the same component instance has already run the cleanup, and a
      // disposed coordinator accepts nothing — so the second mount takes a fresh one
      // rather than a corpse whose frames never run.
      setFrameCoordinator(new LedgerFrameCoordinator({ clock }));
      return;
    }
    return () => {
      frameCoordinator.dispose();
    };
  }, [frameCoordinator, clock]);

  return frameCoordinator;
}
