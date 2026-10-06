/**
 * Reads Claude Code's `api_retry` frame for the end of its own retry ladder. Claude Code retries a
 * rate limit or an overload itself; when the final announced retry fails too, the turn ends with
 * the provider not answering. That is the spent-retries cause, never a spent plan allowance: a plan
 * limit is not retried, so no retry frame announces one.
 */

import { isPositiveFiniteNumber } from "./turn-evidence.js";
import type { ProviderSpentRetriesSignal } from "../contract.js";

/** The `type` of the retry frame. */
const CLAUDE_API_RETRY_FRAME_TYPE = "system" as const;

/** The `subtype` of the retry frame. */
const CLAUDE_API_RETRY_FRAME_SUBTYPE = "api_retry" as const;

/** The `api_retry` error members Claude Code retries until its ladder is spent. */
const CLAUDE_RETRIED_ERROR_MEMBERS: ReadonlySet<unknown> = new Set(["rate_limit", "overloaded"]);

/**
 * Classifies Claude Code's final announced retry of a rate limit or an overload as the
 * spent-retries cause, or `null`. Typed-only: it gates on `type`, `subtype`, the `error` member and
 * the ladder members, so an unfamiliar shape yields `null`.
 */
export function classifyClaudeSpentRetries(frame: unknown): ProviderSpentRetriesSignal | null {
  if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
    return null;
  }
  const record = frame as Record<string, unknown>;
  // `error_status` is never read: a bare `429` says nothing the typed member does not.
  if (
    record["type"] !== CLAUDE_API_RETRY_FRAME_TYPE ||
    record["subtype"] !== CLAUDE_API_RETRY_FRAME_SUBTYPE ||
    !CLAUDE_RETRIED_ERROR_MEMBERS.has(record["error"])
  ) {
    return null;
  }
  // Only the final announced retry counts; a mid-ladder frame is the provider still retrying. The
  // positive-finite reads also reject `max_retries: 0`, which announces no ladder. A final attempt
  // that then succeeds still classifies, so the consumer correlates it with the turn's end.
  const attempt = record["attempt"];
  const maxRetries = record["max_retries"];
  if (!isPositiveFiniteNumber(attempt) || !isPositiveFiniteNumber(maxRetries)) {
    return null;
  }
  if (attempt < maxRetries) {
    return null;
  }
  return { cause: "retries-exhausted" };
}
