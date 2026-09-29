// Take the shell, and report whether that call is still out.
//
// The hook holds one renderer-local fact, and never derives the holder: where the shell
// is held is the fold's in `lease-model.ts`.
//
// The fact is stamped with the `(bridge, sessionId)` subject and compared during render,
// so a pane rebound to another session never inherits the previous session's disabled
// control. The single-flight register is keyed on the visit (the publisher the holder
// re-mints on each re-seed), so a session visited twice starts with a free slot.

import { useCallback } from "react";

import { useGenerationLatch } from "@renderer/hooks/useGenerationLatch.js";
import { useSubjectScopedState } from "@renderer/hooks/subject-scoped/useSubjectScopedState.js";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";

/** Takes the session's one shared shell. */
export type TerminalLeaseCall = (request: { readonly sessionId: string }) => Promise<unknown>;

/** The lease call the claim drives. */
export interface TerminalLeaseCalls {
  readonly acquire: TerminalLeaseCall;
}

/** What the claim control knows: whether a call is out, and how to make one. */
export interface UseTakeShellResult {
  readonly isInFlight: boolean;
  readonly take: () => void;
}

/** What a subject that has dispatched nothing renders as. */
const IDLE_TERMINAL_LEASE_CLAIM = { isInFlight: false };

/**
 * Drive the take call and report whether one is out.
 *
 * A served reply sets no holder: the daemon accepting a claim is not this device now
 * holding the shell, and the fold owns the holder. A rejected call is not caught; it
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
    () => IDLE_TERMINAL_LEASE_CLAIM,
  );
  // The latch refuses a second claim while one is live, which is the rule the control's
  // disabled state renders. Its claim is also the serial a settlement compares against,
  // so an earlier press's `finally` cannot clear the flag a later press set.
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
      dispatch.settle(() => {
        publish({ isInFlight: false });
      });
      dispatch.release();
    }
  }, [calls, dispatches, publish, sessionId]);

  const take = useCallback(() => {
    void takeShell();
  }, [takeShell]);

  return { isInFlight: reading.isInFlight, take };
}
