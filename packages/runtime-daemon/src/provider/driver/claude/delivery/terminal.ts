// How a Claude Code turn ended, read from its settling `result` frame into the run's move: the
// turn evidence decides a declared failure, `is_error` decides every other failure (the refill
// breaker's `result` reads `success`), and a turn too long to fit even after compaction is marked
// so the driver cuts it back, its failure naming the person's message that goes back to them.

import type { ProviderSpentRetriesSignal } from "@ai-sidekicks/contracts/provider/driver/usage-limit";
import type { RunFailureCause } from "@ai-sidekicks/contracts/run/failure-cause";
import type { RunId } from "@ai-sidekicks/contracts/run/id";

import type { RunTransitionRequest } from "../../../../session/run/engine.js";
import { readNonEmptyString } from "../../../record-readers.js";
import { sanitizeFailureDetail } from "../session/errors.js";
import { classifyClaudeTurnEvidence } from "../turn-evidence.js";

// The `terminal_reason` of a turn that does not fit the context window even after compaction.
const CLAUDE_TOO_LONG_TERMINAL_REASONS: ReadonlySet<unknown> = new Set([
  "prompt_too_long",
  "blocking_limit",
]);

/** The move a settling `result` asks of its run, and whether the turn must be cut back. */
export interface ClaudeTurnEnd {
  readonly change: Extract<RunTransitionRequest, { newState: "completed" | "failed" }>;
  /** The turn did not fit even after compaction, so Claude Code keeps a message turns fail on. */
  readonly isTooLong: boolean;
}

// Claude Code's own words for a failed turn: the `result` text, else its `errors`, else the
// terminal reason.
function describeTurnFailure(frame: Readonly<Record<string, unknown>>): string {
  const errors = frame["errors"];
  const errorText = Array.isArray(errors)
    ? errors.filter((entry): entry is string => typeof entry === "string").join("; ")
    : "";
  return sanitizeFailureDetail(
    readNonEmptyString(frame, "result") ??
      (errorText === "" ? undefined : errorText) ??
      readNonEmptyString(frame, "terminal_reason") ??
      readNonEmptyString(frame, "subtype") ??
      "",
  );
}

/**
 * The move one settling `result` frame asks of `runId`. `spentRetries` is the retry ladder Claude
 * Code reported spent during the turn, the failure's cause when the turn failed; `newestMessageId`
 * is the newest message the session was sent, which a turn too long to fit hands back, and with
 * none known that failure carries no cause.
 */
export function readClaudeTurnEnd(
  frame: Readonly<Record<string, unknown>>,
  runId: RunId,
  spentRetries: ProviderSpentRetriesSignal | undefined,
  newestMessageId: string | undefined,
): ClaudeTurnEnd {
  const evidence = classifyClaudeTurnEvidence(frame);
  const declaredFailure = evidence.observations.includes("declared_turn_failure");
  if (!declaredFailure && frame["is_error"] !== true) {
    return {
      change: { runId, newState: "completed", completionKind: "turn" },
      isTooLong: false,
    };
  }
  const isTooLong = CLAUDE_TOO_LONG_TERMINAL_REASONS.has(frame["terminal_reason"]);
  const failureCause: RunFailureCause | undefined = isTooLong
    ? newestMessageId === undefined
      ? undefined
      : { cause: "context-window-exceeded", origin: "provider", returnedMessageId: newestMessageId }
    : spentRetries === undefined
      ? undefined
      : { ...spentRetries, origin: "provider" };
  return {
    change: {
      runId,
      newState: "failed",
      failureCategory: "provider failure",
      providerFailureDetail: describeTurnFailure(frame),
      ...(failureCause === undefined ? {} : { failureCause }),
    },
    isTooLong,
  };
}
