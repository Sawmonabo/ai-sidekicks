// The React binding for the frame coordinator: one per feed, since a frame is a paint and
// only what shares a scroll container shares a paint. Minted with the feed and disposed with
// it; a replacement clock re-mints it, because frames armed on the old clock never run.

import { useEffect, useState } from "react";

import { type Clock } from "@renderer/lib/clock.js";
import { AnimationFrameCoordinator } from "../animation-frame-coordinator.js";

/** Mint one frame coordinator for a feed, and dispose it with the mount. */
export function useAnimationFrameCoordinator(clock: Clock): AnimationFrameCoordinator {
  const [frameCoordinator, setFrameCoordinator] = useState<AnimationFrameCoordinator>(
    () => new AnimationFrameCoordinator({ clock }),
  );

  useEffect(() => {
    if (frameCoordinator.isDisposed) {
      // A remount of the same instance already ran the cleanup, and a disposed coordinator
      // accepts nothing, so take a fresh one.
      setFrameCoordinator(new AnimationFrameCoordinator({ clock }));
      return;
    }
    return () => {
      frameCoordinator.dispose();
    };
  }, [frameCoordinator, clock]);

  return frameCoordinator;
}
