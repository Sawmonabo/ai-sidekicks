// Why a Codex turn that failed failed, as the run's failure cause names it: a turn too long for the
// model's window, whose message goes back to the composer; a usage limit only when Codex failed the
// turn on one and the account's readings show it spent; spent retries when the arm is an upstream
// rate limit, which Codex gives up on only after its own retries, or when Codex retried the turn
// before giving up; and no flex capacity for a turn sent on the flex speed.

import type { RunFailureCause } from "@ai-sidekicks/contracts/run/failure-cause";

import type { CodexSessionRecord } from "../session/state.js";
import { classifyCodexUsageLimitSignal } from "../usage-limit-signal.js";

/** The error arm Codex ends a turn with when the turn is too long for the model's window. */
export const CODEX_CONTEXT_WINDOW_EXCEEDED_ERROR = "contextWindowExceeded";
const CODEX_USAGE_LIMIT_EXCEEDED_ERROR = "usageLimitExceeded";
const CODEX_RATE_LIMIT_EXCEEDED_ERROR = "rateLimitExceeded";
// The arm Codex fails a turn with when the flex service tier has no capacity; it does not retry it.
const CODEX_FLEX_UNAVAILABLE_ERROR = "flexUnavailable";

/** The cause of the turn `turnId`'s failure on Codex's error arm `errorKind`; none when unknown. */
export function readCodexTurnFailureCause(
  record: Pick<CodexSessionRecord, "delivery" | "service" | "turnIdByClientMessageId">,
  turnId: string,
  errorKind: string | null,
): RunFailureCause | undefined {
  if (errorKind === CODEX_CONTEXT_WINDOW_EXCEEDED_ERROR) {
    // The person's message that opened the turn goes back to the composer; with none known the
    // failure carries no cause rather than one that returns nothing.
    const returnedMessageId = readTurnMessageId(record, turnId);
    return returnedMessageId === undefined
      ? undefined
      : { cause: "context-window-exceeded", origin: "provider", returnedMessageId };
  }
  if (errorKind === CODEX_FLEX_UNAVAILABLE_ERROR) {
    return { cause: "flex-capacity-unavailable", origin: "provider" };
  }
  if (errorKind === CODEX_USAGE_LIMIT_EXCEEDED_ERROR) {
    const usageLimit = classifyCodexUsageLimitSignal(record.service.rateLimitObservation);
    if (usageLimit !== null) {
      return { ...usageLimit, origin: "provider" };
    }
  }
  const memory = record.delivery;
  return errorKind === CODEX_RATE_LIMIT_EXCEEDED_ERROR ||
    (memory.finalErrorByTurnId.has(turnId) && memory.retriedTurnIds.has(turnId))
    ? { cause: "retries-exhausted", origin: "provider" }
    : undefined;
}

// The id of the person's message that opened a turn, or `undefined` when the turn had none.
function readTurnMessageId(
  record: Pick<CodexSessionRecord, "turnIdByClientMessageId">,
  turnId: string,
): string | undefined {
  for (const [clientMessageId, messageTurnId] of record.turnIdByClientMessageId) {
    if (messageTurnId === turnId) {
      return clientMessageId;
    }
  }
  return undefined;
}
