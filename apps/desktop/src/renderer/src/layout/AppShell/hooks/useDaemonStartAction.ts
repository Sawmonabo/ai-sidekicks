// The manual retry for a stopped daemon. A stopped runtime has no server to receive a start, so
// the start is an argument supplied by the main process, not a daemon method.

import { useCallback } from "react";

import { useGenerationLatch } from "#renderer/hooks/useGenerationLatch.js";

/** The key one start is in flight under, inside the call's own key space. */
const DAEMON_START_KEY = "daemon-start";

/** Asks the main process to start the daemon. Resolves once the request is put. */
export type DaemonStartCall = () => Promise<void>;

/**
 * The manual retry, offered once the supervisor's ladder is spent. It never reports success: only
 * the supervisor's next report says whether the runtime came back.
 *
 * One start runs at a time: the key is taken synchronously and released in `finally`, so a
 * rejected call leaves the control working and the rejection reaches the caller.
 */
export function useDaemonStartAction(startDaemon: DaemonStartCall): () => Promise<void> {
  const starts = useGenerationLatch();
  return useCallback(async () => {
    const start = starts.claim(startDaemon, DAEMON_START_KEY);
    if (start === undefined) {
      return;
    }
    try {
      await startDaemon();
    } finally {
      start.release();
    }
  }, [starts, startDaemon]);
}
