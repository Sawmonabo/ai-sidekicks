// The manual retry for a stopped daemon.
//
// The daemon's own lifecycle controls are not daemon methods: a stopped runtime has no
// server to receive a start, so the act belongs to the main process and the call is
// taken as an argument.

import { useCallback } from "react";

import { useGenerationLatch } from "@renderer/hooks/useGenerationLatch.js";

/**
 * The key one start is in flight under. A key inside the call's own key space rather
 * than an identity, per `store/read/generation-latch.ts`.
 */
const DAEMON_START_KEY = "daemon-start";

/** Asks the main process to start the daemon. Resolves once the request is put. */
export type DaemonStartCall = () => Promise<void>;

/**
 * The manual retry, offered once the supervisor's ladder is spent.
 *
 * Nothing here reports success: the supervisor's next report says whether the runtime
 * came back, and a control that painted "connected" because its own call resolved
 * would be synthesizing the one state this plane may never synthesize.
 *
 * ONE START AT A TIME, DECIDED IN THE TICK. The supervisor's next report arrives several
 * frames after the press, and every click inside that window would otherwise reach the
 * main process and start the same runtime twice. The key is taken synchronously before
 * the call goes out and given back in the `finally`, so a call that rejects leaves the
 * control working. The rejection itself reaches the caller of the returned function.
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
