import { useEffect, useRef, useState } from "react";

import type {
  ClipboardCopy,
  ClipboardCopyStatus,
} from "#renderer/components/CopyButton/CopyButton.js";
import type { ClipboardContent } from "#shared/preload-api.js";
import type { ScheduledHandle } from "#renderer/lib/clock.js";
import { TRANSIENT_STATUS_DURATION_MS } from "#renderer/lib/transient-status.js";
import { copyOnceBuilt } from "../late-clipboard-copy.js";
import { useClock } from "./useClock.js";
import { usePlatformBridge } from "./usePlatformBridge.js";

/**
 * Put `content` on the system clipboard through main, in one write of its flavors, and hold the
 * outcome for one transient-status duration. A function is called only when the copy is asked
 * for, for content that costs to build, and may answer later, as a picture's encoding does; content
 * that answers later is written only while the clipboard holds what it held when the copy was asked
 * for, so a newer copy made meanwhile, in this app or another, stands and this one settles nothing.
 * A refused copy, or content that could not be built, ends as `failed`, which the control says in
 * place; `onSettled` hears each outcome of a copy whose control is still mounted.
 */
export function useClipboardCopy(
  content: ClipboardContent | (() => ClipboardContent | Promise<ClipboardContent>),
  onSettled?: (outcome: Exclude<ClipboardCopyStatus, "rest">) => void,
): ClipboardCopy {
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
    onSettled?.(outcome);
    resetHandle.current = clock.scheduleTimeout(() => {
      resetHandle.current = undefined;
      setStatus("rest");
    }, TRANSIENT_STATUS_DURATION_MS);
  };

  const copy = (): void => {
    const built = typeof content === "function" ? content() : content;
    // Content ready now is written at once; content still being built is written once it is.
    let written: Promise<boolean>;
    if (built instanceof Promise) {
      written = copyOnceBuilt(bridge, async (write) => write(await built));
    } else {
      written = bridge.native.copyToClipboard(built).then(() => true);
    }
    written.then(
      (isWritten) => {
        if (isWritten) {
          settle("copied");
        }
      },
      () => {
        settle("failed");
      },
    );
  };

  return { status, copy };
}
