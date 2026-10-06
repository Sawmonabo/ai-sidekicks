// The React binding for the frame scheduler: one per feed, since a frame is a paint and
// only what shares a scroll container shares a paint. Minted with the feed and disposed with
// it; a replacement clock re-mints it, because frames armed on the old clock never run. A task
// that threw goes to the window's diagnostic capture.

import { useEffect, useState } from "react";

import { type Clock } from "#renderer/lib/clock.js";
import {
  diagnosticStampAt,
  windowDiagnosticCapture,
} from "#renderer/lib/diagnostic-capture/capture.js";
import { AnimationFrameScheduler } from "../animation-frame-scheduler.js";

/** Mint one frame scheduler for a feed, and dispose it with the mount. */
export function useAnimationFrameScheduler(clock: Clock): AnimationFrameScheduler {
  const [frameScheduler, setFrameScheduler] = useState<AnimationFrameScheduler>(
    () => new AnimationFrameScheduler({ clock }),
  );

  useEffect(() => {
    if (frameScheduler.isDisposed) {
      // A remount of the same instance already ran the cleanup, and a disposed scheduler
      // accepts nothing, so take a fresh one.
      setFrameScheduler(new AnimationFrameScheduler({ clock }));
      return;
    }
    return () => {
      frameScheduler.dispose();
    };
  }, [frameScheduler, clock]);

  useEffect(
    () =>
      frameScheduler.subscribeToDiagnostics((diagnostic) => {
        windowDiagnosticCapture.record({
          at: diagnosticStampAt(clock),
          severity: "error",
          source: "features/transcript",
          kind: "frame-task-failed",
          detail: diagnostic.detail,
        });
      }),
    [frameScheduler, clock],
  );

  return frameScheduler;
}
