import { useEffect, useRef, useState } from "react";

import type { ScheduledHandle } from "@renderer/lib/clock.js";
import { TRANSIENT_STATUS_DURATION_MS } from "@renderer/lib/transient-status.js";
import { useClock } from "@renderer/services/platform/hooks/useClock.js";
import { usePlatformBridge } from "@renderer/services/platform/hooks/usePlatformBridge.js";

/** Where a copy control stands: at rest, or showing how its last press ended. */
export type ClipboardCopyStatus = "rest" | "copied" | "failed";

/** A copy control's state and the press that changes it. */
export interface ClipboardCopy {
  readonly status: ClipboardCopyStatus;
  readonly copy: () => void;
}

/**
 * Put `text` on the host clipboard and hold the outcome for one transient-status duration.
 *
 * The host call sits inside the `try` because the shipped bridge throws synchronously
 * where the fixture rejects; both end as `failed`, which the control says in place.
 */
export function useClipboardCopy(text: string): ClipboardCopy {
  const bridge = usePlatformBridge();
  const clock = useClock();
  const [status, setStatus] = useState<ClipboardCopyStatus>("rest");
  const resetHandle = useRef<ScheduledHandle | undefined>(undefined);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (resetHandle.current !== undefined) {
        clock.cancel(resetHandle.current);
        resetHandle.current = undefined;
      }
    };
  }, [clock]);

  // A row scrolled out of the window unmounts while its copy is in flight, so an
  // outcome that lands after that sets nothing and arms nothing.
  const settle = (outcome: Exclude<ClipboardCopyStatus, "rest">): void => {
    if (!mounted.current) {
      return;
    }
    if (resetHandle.current !== undefined) {
      clock.cancel(resetHandle.current);
    }
    setStatus(outcome);
    resetHandle.current = clock.scheduleTimeout(() => {
      resetHandle.current = undefined;
      setStatus("rest");
    }, TRANSIENT_STATUS_DURATION_MS);
  };

  const copy = (): void => {
    try {
      bridge.desktopBridge.native.copyToClipboard(text).then(
        () => {
          settle("copied");
        },
        () => {
          settle("failed");
        },
      );
    } catch {
      settle("failed");
    }
  };

  return { status, copy };
}
