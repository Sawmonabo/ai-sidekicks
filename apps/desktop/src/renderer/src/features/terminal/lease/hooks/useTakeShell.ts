// `Take the shell` and its confirm: whether the confirm is open, whether the take is out, and why
// the last one was refused. The hook never derives the holder; the fold in `state.ts` owns it, so
// a served take closes the confirm and the line moves only when the change reaches the fold. The
// take is always forced, since it is offered only while another device holds the shell, and it is
// bound to the pane's own output subscription to that shell, whose end gives the hold back.
//
// The state is scoped to the shell, that subscription and the device the take would move the shell
// off, so a pane showing another shell, or the same one through a new subscription, starts closed
// and never inherits a disabled control, and a change of holder closes an open confirm rather than
// leave it asking about a device that no longer holds the shell. The single-flight latch is keyed
// on the visit, so a shell visited twice starts free.

import { useCallback } from "react";

import type { SessionTakeControlRequest } from "@ai-sidekicks/contracts/pty";

import { useGenerationLatch } from "#renderer/hooks/useGenerationLatch.js";
import { useSubjectScopedState } from "#renderer/hooks/subject-scoped/useSubjectScopedState.js";
import type { Refusal } from "#renderer/lib/refusal/contract.js";
import { callDaemon } from "#renderer/services/daemon/reply.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";

/** The shell a take is for, and the pane's output subscription the hold is bound to. */
export type TakeShellTarget = Pick<
  SessionTakeControlRequest,
  "sessionId" | "terminalId" | "outputSubscriptionId"
>;

/** Where the take stands, and the presses that move it. */
export interface UseTakeShellResult {
  /** Whether the confirm is open in place of `Take the shell`. */
  readonly isConfirming: boolean;
  /**
   * Whether a take is out; meanwhile the confirm's buttons say they are unavailable, and their
   * presses and Escape change nothing.
   */
  readonly isInFlight: boolean;
  /** Why the last take was refused, said on the line with the confirm still open. */
  readonly refusal: Refusal | undefined;
  readonly openConfirm: () => void;
  readonly cancelConfirm: () => void;
  readonly take: () => void;
}

/** The confirm closed with nothing out, which a shell starts at. */
const CLOSED_TAKE_SHELL: TakeShellPhase = {
  isConfirming: false,
  isInFlight: false,
  refusal: undefined,
};

/** The confirm open with nothing out and nothing refused. */
const CONFIRMING_TAKE_SHELL: TakeShellPhase = {
  isConfirming: true,
  isInFlight: false,
  refusal: undefined,
};

/**
 * Drive `Take the shell`, its confirm and the forced `session.takeControl` it sends, against the
 * shell's holder as the fold read it (`holderDeviceId`, `null` while nobody holds it). A served
 * take closes the confirm and sets no holder: the daemon accepting a take is not this device now
 * holding the shell. A refused take keeps the confirm open with the refusal beside it.
 */
export function useTakeShell(
  bridge: PlatformBridge,
  target: TakeShellTarget,
  holderDeviceId: string | null,
): UseTakeShellResult {
  const { sessionId, terminalId, outputSubscriptionId } = target;
  const { value: phase, publish } = useSubjectScopedState(
    bridge,
    `${sessionId} ${terminalId} ${outputSubscriptionId} ${holderDeviceId ?? ""}`,
    () => CLOSED_TAKE_SHELL,
  );
  // The latch refuses a second claim while one is live, which the disabled `Take it` renders. A
  // press's settlement publishes through its own visit, so it cannot move a later visit's confirm.
  const dispatches = useGenerationLatch();

  const takeShell = useCallback(async (): Promise<void> => {
    // `publish` is the visit key: the holder re-mints it on each re-seed.
    const dispatch = dispatches.claim(publish, terminalId);
    if (dispatch === undefined) {
      return;
    }
    publish({ isConfirming: true, isInFlight: true, refusal: undefined });
    const reply = await callDaemon(bridge, "session.takeControl", {
      sessionId,
      terminalId,
      outputSubscriptionId,
      force: true,
    });
    publish(
      reply.status === "refused"
        ? { isConfirming: true, isInFlight: false, refusal: reply.refusal }
        : CLOSED_TAKE_SHELL,
    );
    dispatch.release();
  }, [bridge, dispatches, outputSubscriptionId, publish, sessionId, terminalId]);

  const take = useCallback(() => {
    void takeShell();
  }, [takeShell]);
  const openConfirm = useCallback(() => {
    publish(CONFIRMING_TAKE_SHELL);
  }, [publish]);
  // A take already out cannot be called back, so the confirm stays open to say how it ended.
  const cancelConfirm = useCallback(() => {
    publish((current) => (current.isInFlight ? current : CLOSED_TAKE_SHELL));
  }, [publish]);

  return { ...phase, openConfirm, cancelConfirm, take };
}

// The held part of the result: the confirm, the call and the refusal, without the presses.
type TakeShellPhase = Pick<UseTakeShellResult, "isConfirming" | "isInFlight" | "refusal">;
