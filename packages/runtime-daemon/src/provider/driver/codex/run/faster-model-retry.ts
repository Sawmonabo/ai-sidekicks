// Codex's faster-model retry: a turn Codex holds for a safety check is stopped, the conversation
// forked to just before it, and the same message sent again on the faster model, which stays the
// session's model. The run goes on in the new turn under its binding; nothing is drawn twice.

import type { CodexDeliveryDispatch } from "../delivery/dispatch.js";
import { CodexTransportError, normalizeProviderFailureDetail } from "../session/errors.js";
import type { CodexConversationForks } from "../session/fork.js";
import type { CodexSessionSlots } from "../session/slots.js";
import { newestActiveTurnForRun } from "../session/state.js";
import type { FasterModelRetryOutcome, FasterModelRetryParams } from "../../run-control.js";
import type { CodexRunRoutes } from "./routes.js";
import type { CodexRunStart } from "./start.js";
import type { CodexTurnEndWaiters } from "./turn-end-waiters.js";

/** What the retry acts through. */
export interface CodexFasterModelRetryDependencies {
  readonly slots: CodexSessionSlots;
  readonly runRoutes: CodexRunRoutes;
  readonly runStart: CodexRunStart;
  readonly forks: CodexConversationForks;
  readonly turnEnds: CodexTurnEndWaiters;
  readonly dispatch: CodexDeliveryDispatch;
}

/**
 * Retries a held turn on a faster model. Answers `rejected` when the turn is no longer the run's
 * latest or its reply has started. An interrupt that fails while the turn runs on leaves the turn
 * the run's and throws; any later failure ends the run failed. Both throw
 * `Failed to retry with a faster model: <reason>`.
 */
export async function retryCodexTurnOnFasterModel(
  dependencies: CodexFasterModelRetryDependencies,
  params: FasterModelRetryParams,
): Promise<FasterModelRetryOutcome> {
  const { slots, runRoutes, runStart, forks, turnEnds, dispatch } = dependencies;
  const record = slots.require(params.sessionId);
  const turnId = params.expectedTurnId;
  const input = record.turnInputByTurnId.get(turnId);
  const binding = runRoutes.bindingFor(params.runId);
  if (
    newestActiveTurnForRun(record, params.runId) !== turnId ||
    input === undefined ||
    binding === undefined
  ) {
    return { state: "rejected", rejectionReason: "The turn is no longer the run's latest." };
  }
  if (record.delivery.replyStartedTurnIds.has(turnId)) {
    return { state: "rejected", rejectionReason: "The turn's reply has started." };
  }
  // The stopped turn's end is the retry's, so it ends no run and keeps the run's binding. Marked
  // before the interrupt goes out, since the turn's end can follow its answer at once.
  record.delivery.retriedRunIdByTurnId.set(turnId, params.runId);
  runRoutes.retireTurnRoute(record, turnId);
  try {
    await record.service.request("turn/interrupt", { threadId: record.threadId, turnId });
  } catch (cause) {
    if (!record.settledTurnIds.has(turnId)) {
      // Not stopped: the turn runs on as the run's, so the retry is refused and the run is not.
      record.delivery.retriedRunIdByTurnId.delete(turnId);
      record.runIdByActiveTurnId.set(turnId, params.runId);
      runRoutes.bindRun(params.runId, params.sessionId, turnId);
      throw new Error(
        `Failed to retry with a faster model: ${normalizeProviderFailureDetail(cause)}`,
        { cause },
      );
    }
  }
  try {
    if (!(await turnEnds.waitForEnd(record, turnId))) {
      throw new CodexTransportError("The held turn did not stop.", {
        sessionId: params.sessionId,
        turnId,
      });
    }
    // The fork carries the faster model on its default window, and every later start and resume
    // carries it too. The run's own binding is pointed at the fork before the turn is sent, so a
    // resume after a restart finds the fork, never the held turn.
    record.threadSettings = {
      ...record.threadSettings,
      model: params.model,
      modelContextWindow: undefined,
    };
    await slots.claim(
      params.sessionId,
      "establishing",
      async () => await forks.establishFork(record, turnId, binding.bindingId),
    );
    await runStart.startTurn(record, {
      runId: params.runId,
      texts: input.texts,
      clientMessageIds: input.clientMessageIds,
      model: params.model,
      modelContextWindow: undefined,
      outputSpeed: undefined,
      outputSpeedForTurn: input.outputSpeedForTurn,
      outputSchema: undefined,
      level: undefined,
      skill: input.skill,
    });
  } catch (cause) {
    const reason = normalizeProviderFailureDetail(cause);
    void dispatch.send(
      params.sessionId,
      {
        kind: "run_lifecycle",
        bindingId: binding.bindingId,
        change: {
          runId: params.runId,
          newState: "failed",
          failureCategory: "provider failure",
          providerFailureDetail: `Failed to retry with a faster model: ${reason}`,
        },
      },
      null,
    );
    runRoutes.forgetRun(params.runId);
    throw new Error(`Failed to retry with a faster model: ${reason}`, { cause });
  }
  return { state: "applied" };
}
