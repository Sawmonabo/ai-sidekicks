// Take the shell, and report whether that call is still out. The hook never derives the
// holder; the fold in `lease-model.ts` owns it. The in-flight fact is scoped to the
// `(bridge, sessionId)` subject, so a rebound pane never inherits a disabled control, and the
// single-flight latch is keyed on the visit, so a session visited twice starts free.

import { useCallback } from "react";

import { useGenerationLatch } from "@renderer/hooks/useGenerationLatch.js";
import { useSubjectScopedState } from "@renderer/hooks/subject-scoped/useSubjectScopedState.js";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";

/** Takes the session's one shared shell. */
export type TerminalLeaseCall = (request: { readonly sessionId: string }) => Promise<unknown>;

/** The lease call the take drives. */
export interface TerminalLeaseCalls {
  readonly acquire: TerminalLeaseCall;
}

/** What the take control knows: whether a call is out, and how to make one. */
export interface UseTakeShellResult {
  readonly isInFlight: boolean;
  readonly take: () => void;
}

/** What a subject that has dispatched nothing renders as. */
const IDLE_TERMINAL_LEASE_TAKE = { isInFlight: false };

/**
 * Drive the take call and report whether one is out. A served reply sets no holder: the daemon
 * accepting a take is not this device now holding the shell. A rejected call is not caught; it
 * surfaces as an unhandled rejection.
 */
export function useTakeShell(
  bridge: PlatformBridge,
  sessionId: string,
  calls: TerminalLeaseCalls,
): UseTakeShellResult {
  const { value: reading, publish } = useSubjectScopedState(
    bridge,
    sessionId,
    () => IDLE_TERMINAL_LEASE_TAKE,
  );
  // The latch refuses a second claim while one is live, which the control's disabled state
  // renders. A press's `finally` publishes through its own visit, so it cannot clear the flag
  // a press on a later visit set.
  const dispatches = useGenerationLatch();

  const takeShell = useCallback(async (): Promise<void> => {
    // `publish` is the visit key: the holder re-mints it on each re-seed.
    const dispatch = dispatches.claim(publish, sessionId);
    if (dispatch === undefined) {
      return;
    }
    publish({ isInFlight: true });
    try {
      await calls.acquire({ sessionId });
    } finally {
      publish({ isInFlight: false });
      dispatch.release();
    }
  }, [calls, dispatches, publish, sessionId]);

  const take = useCallback(() => {
    void takeShell();
  }, [takeShell]);

  return { isInFlight: reading.isInFlight, take };
}
