/**
 * Reads Claude's `api_retry` frame into a usage-limit signal, once the provider's own retry ladder
 * is spent.
 */

import { isPositiveFiniteNumber } from "./turn-evidence.js";
import type { ProviderUsageLimitSignal } from "../provider-driver.js";

/** The `type` of the retry frame. */
const CLAUDE_API_RETRY_FRAME_TYPE = "system" as const;

/** The `subtype` of the retry frame. */
const CLAUDE_API_RETRY_FRAME_SUBTYPE = "api_retry" as const;

/**
 * The one `api_retry` error member that names a spent allowance. `billing_error` is excluded: a
 * human fixes a payment fault, so parking a run on it would wait for a boundary that never comes.
 */
const CLAUDE_USAGE_LIMIT_RETRY_ERROR_MEMBER = "rate_limit" as const;

/**
 * Classifies a Claude `system/api_retry` frame for a spent usage allowance, or `null`. Typed-only:
 * it gates on `type`, `subtype` and the `error` member, so an unfamiliar member yields `null`.
 * A provider that abandons its retry ladder early emits no final attempt and goes unrecognized.
 */
export function classifyClaudeUsageLimitSignal(
  frame: unknown,
  observedAtEpochMs: number,
): ProviderUsageLimitSignal | null {
  if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
    return null;
  }
  const record = frame as Record<string, unknown>;
  // `error_status` is never read: a bare `429` is also emitted for throttling that spends no
  // allowance, and keying on it would park runs the provider would still serve.
  if (
    record["type"] !== CLAUDE_API_RETRY_FRAME_TYPE ||
    record["subtype"] !== CLAUDE_API_RETRY_FRAME_SUBTYPE ||
    record["error"] !== CLAUDE_USAGE_LIMIT_RETRY_ERROR_MEMBER
  ) {
    return null;
  }
  // Only the final announced retry signals; a mid-ladder frame is the provider still retrying. The
  // positive-finite reads also reject `max_retries: 0`, which announces no ladder. A final attempt
  // that then succeeds still signals, so the consumer correlates it with the run's outcome.
  const attempt = record["attempt"];
  const maxRetries = record["max_retries"];
  if (!isPositiveFiniteNumber(attempt) || !isPositiveFiniteNumber(maxRetries)) {
    return null;
  }
  if ((attempt as number) < (maxRetries as number)) {
    return null;
  }

  // `retry_delay_ms` is when the provider retries, not when the allowance resets (no reset field is
  // documented); the provenance member lets a consumer tell this from a stated reset.
  const retryDelayMs = record["retry_delay_ms"];
  if (!isPositiveFiniteNumber(retryDelayMs) || !Number.isFinite(observedAtEpochMs)) {
    return { cause: "plan-allowance-exhausted" };
  }
  const instant = new Date(observedAtEpochMs + (retryDelayMs as number));
  if (Number.isNaN(instant.getTime())) {
    return { cause: "plan-allowance-exhausted" };
  }
  return {
    cause: "plan-allowance-exhausted",
    resetBoundary: { resetsAt: instant.toISOString(), provenance: "runtime-derived" },
  };
}
