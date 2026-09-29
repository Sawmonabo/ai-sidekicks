// The Runtime page's two controls: dispatches that must not overlap.

import { useCallback, useMemo, useState } from "react";

import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { useGenerationLatch } from "@renderer/hooks/useGenerationLatch.js";
import type { DaemonOperations } from "./useDaemonStatus.js";

/** Which of the two controls was pressed. Closed, because the page offers two. */
export type DaemonControl = "stop" | "restart";

/** What a dispatched control settled as. */
export interface DaemonControlSettlement {
  readonly control: DaemonControl;
}

/**
 * The single-flight key the two controls share: one destructive act at a time against
 * this machine's runtime, not one of each.
 */
const DAEMON_CONTROL_KEY = "daemon-control";

/** One control in flight, and the way to put one. */
export interface DaemonControlDispatch {
  /** Which control is outstanding, or `undefined` while none is. */
  readonly inFlight: DaemonControl | undefined;
  /**
   * How many dispatches have settled on this visit.
   *
   * A count and not the settlement, because the status read needs the edge: two stops in
   * a row settle to the same value and are two reasons to ask the runtime again.
   */
  readonly settledCount: number;
  /**
   * Put one control. A press arriving while one is outstanding puts nothing.
   *
   * Settles when the call does, and rejects with it: a failed call is the caller's to
   * hear, and the dispatch is released either way.
   */
  readonly put: (control: DaemonControl) => Promise<void>;
}

/**
 * Dispatch one control and report that it was sent.
 *
 * `sent` and not `done`: a stop that was accepted is not a runtime that has stopped, and
 * the supervisor's next report is what says so. Single flight is decided in the tick by
 * the latch's key, taken before the call goes out, because a second press in the same
 * frame reads the flag from the render that produced its handler and finds it idle. The
 * latch is mount-scoped, so a reply arriving after the page is gone installs nothing.
 */
export function useDaemonControl(
  bridge: PlatformBridge,
  operations: DaemonOperations,
  onSettled: (settlement: DaemonControlSettlement) => void,
): DaemonControlDispatch {
  const dispatchLatch = useGenerationLatch();
  const [inFlight, setInFlight] = useState<DaemonControl | undefined>(undefined);
  const [settledCount, setSettledCount] = useState(0);
  const put = useCallback(
    async (control: DaemonControl) => {
      const dispatch = dispatchLatch.claim(bridge, DAEMON_CONTROL_KEY);
      if (dispatch === undefined) {
        return;
      }
      setInFlight(control);
      try {
        await operations[control]();
        dispatch.settle(() => {
          setSettledCount((previous) => previous + 1);
          onSettled({ control });
        });
      } finally {
        dispatch.settle(() => {
          setInFlight(undefined);
        });
        dispatch.release();
      }
    },
    [bridge, dispatchLatch, onSettled, operations],
  );
  return useMemo(() => ({ inFlight, settledCount, put }), [inFlight, settledCount, put]);
}
