// `Stop the run` on a run's hold: it stops the holding command, as the command's own `Stop` does,
// and the hold ends with it. The line moves only when the change of holder reaches the fold.

import { useCallback } from "react";

import type { CommandId } from "@ai-sidekicks/contracts/command";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { useSubjectScopedState } from "#renderer/hooks/subject-scoped/useSubjectScopedState.js";
import type { Refusal } from "#renderer/lib/refusal/contract.js";
import { callDaemon } from "#renderer/services/daemon/reply.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";

/** Where a stop stands, and the press that sends it. */
export interface UseStopRunResult {
  /** Whether a stop is out; a press meanwhile sends nothing. */
  readonly isInFlight: boolean;
  /** Why the last stop was refused. */
  readonly refusal: Refusal | undefined;
  readonly stop: () => void;
}

/** Drive `Stop the run` for the holding command, or `undefined` while no run's command holds it. */
export function useStopRun(
  bridge: PlatformBridge,
  sessionId: SessionId,
  holderCommandId: CommandId | undefined,
): UseStopRunResult | undefined {
  const { value, publish } = useSubjectScopedState<StopRunPhase>(
    bridge,
    `${sessionId} ${holderCommandId ?? ""}`,
    () => IDLE_STOP_RUN,
  );
  const { isInFlight } = value;
  const stop = useCallback(() => {
    if (holderCommandId === undefined || isInFlight) {
      return;
    }
    publish({ isInFlight: true, refusal: undefined });
    void callDaemon(bridge, "agent.command.stop", { sessionId, commandId: holderCommandId }).then(
      (reply) => {
        publish({
          isInFlight: false,
          refusal: reply.status === "refused" ? reply.refusal : undefined,
        });
      },
    );
  }, [bridge, holderCommandId, isInFlight, publish, sessionId]);
  return holderCommandId === undefined ? undefined : { ...value, stop };
}

// The held part of the result, without the press.
type StopRunPhase = Pick<UseStopRunResult, "isInFlight" | "refusal">;

const IDLE_STOP_RUN: StopRunPhase = { isInFlight: false, refusal: undefined };
