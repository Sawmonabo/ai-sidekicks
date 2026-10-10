/**
 * Reads Codex's account rate-limit notifications and a failed turn's reached-limit type into a
 * usage-limit signal with the reset boundary the provider reported.
 */

import type { ProviderUsageLimitSignal } from "@ai-sidekicks/contracts/provider/driver/usage-limit";

import { isPlainObject } from "../../record-readers.js";

/**
 * The `account/rateLimits/read` method, the pull carrier of a rate-limit snapshot (a reply).
 *
 * @consumedBy the Codex driver's account rate-limit reads
 */
export const CODEX_ACCOUNT_RATE_LIMITS_READ_METHOD = "account/rateLimits/read" as const;

/** The `account/rateLimits/updated` method, the push carrier of a rate-limit snapshot. */
export const CODEX_ACCOUNT_RATE_LIMITS_UPDATED_METHOD = "account/rateLimits/updated" as const;

// Arms meaning a rolling allowance is spent; it clears when the window turns over. The
// credits-depleted arms produce no signal on purpose: a purchase restores credits, not a window
// turning over, so there is no reset instant to park a run against.
const CODEX_PLAN_ALLOWANCE_REACHED_TYPES: ReadonlySet<string> = new Set([
  "rate_limit_reached",
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached",
]);

/**
 * The two readings a usage-limit classification is made from; the push is a sparse update whose
 * absent members do not clear earlier values, so both are needed. A present `rollingUpdate` value
 * always wins, so a caller that refetches `latestRead` must set `rollingUpdate` back to `null`.
 */
export interface CodexRateLimitObservation {
  /** The `account/rateLimits/read` REPLY body, or `null` if none has landed. */
  readonly latestRead: unknown;
  /** The `account/rateLimits/updated` NOTIFICATION params, or `null`. */
  readonly rollingUpdate: unknown;
}

interface CodexMergedRateLimitReading {
  readonly rateLimitReachedType: unknown;
  readonly primary: unknown;
  readonly secondary: unknown;
}

function readCodexRateLimitSnapshot(carrier: unknown): Record<string, unknown> | null {
  if (!isPlainObject(carrier)) {
    return null;
  }
  const rateLimits = carrier["rateLimits"];
  return isPlainObject(rateLimits) ? rateLimits : null;
}

// The vendor's merge: a value present in the sparse update wins, else the last full read. Members
// are copied one by one so provider-chosen keys never land on a new object.
function mergeCodexRateLimitReading(
  latestRead: Record<string, unknown> | null,
  rollingUpdate: Record<string, unknown> | null,
): CodexMergedRateLimitReading {
  return {
    rateLimitReachedType:
      rollingUpdate?.["rateLimitReachedType"] ?? latestRead?.["rateLimitReachedType"],
    primary: rollingUpdate?.["primary"] ?? latestRead?.["primary"],
    secondary: rollingUpdate?.["secondary"] ?? latestRead?.["secondary"],
  };
}

// The reset instant, only when the provider marks that window spent (`usedPercent` at least 100).
// Any finite number is accepted because `usedPercent` is `f64` in the core protocol type and `i32`
// in the app-server struct at the pin.
function readCodexSpentWindowResetEpochSeconds(window: unknown): number | null {
  if (!isPlainObject(window)) {
    return null;
  }
  const usedPercent = window["usedPercent"];
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 100) {
    return null;
  }
  const resetsAt = window["resetsAt"];
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) {
    return null;
  }
  return resetsAt;
}

// `resetsAt` is documented as seconds since epoch; reading it as milliseconds would place every
// boundary decades early.
function codexEpochSecondsToRfc3339Utc(epochSeconds: number): string | null {
  const instant = new Date(epochSeconds * 1000);
  return Number.isNaN(instant.getTime()) ? null : instant.toISOString();
}

/**
 * The observation after one more `account/rateLimits/updated` push: the readings so far, merged
 * the vendor's way, become the base the new sparse push is read over.
 */
export function observeCodexRateLimitUpdate(
  previous: CodexRateLimitObservation,
  update: unknown,
): CodexRateLimitObservation {
  const merged = mergeCodexRateLimitReading(
    readCodexRateLimitSnapshot(previous.latestRead),
    readCodexRateLimitSnapshot(previous.rollingUpdate),
  );
  return { latestRead: { rateLimits: merged }, rollingUpdate: update };
}

/**
 * Classifies the account-plane rate-limit readings for a spent usage allowance, or `null`, which
 * means "not known to be limited". Only the `rateLimitReachedType` enum recognizes one, never
 * prose, `usedPercent` alone, or `TurnError.codexErrorInfo` (it carries no reset boundary).
 */
export function classifyCodexUsageLimitSignal(
  observation: CodexRateLimitObservation,
): ProviderUsageLimitSignal | null {
  const reading = mergeCodexRateLimitReading(
    readCodexRateLimitSnapshot(observation.latestRead),
    readCodexRateLimitSnapshot(observation.rollingUpdate),
  );
  const reachedType = reading.rateLimitReachedType;
  if (typeof reachedType !== "string" || !CODEX_PLAN_ALLOWANCE_REACHED_TYPES.has(reachedType)) {
    // Arms the person can remedy, unrecognized arms and absent arms all emit nothing rather than a
    // default signal. `spendControlReached` is not read: it is an administrative budget state.
    return null;
  }

  // The LATEST spent window: the earliest would schedule a resume the other window still refuses.
  const spentResets = [reading.primary, reading.secondary]
    .map(readCodexSpentWindowResetEpochSeconds)
    .filter((epochSeconds): epochSeconds is number => epochSeconds !== null);
  if (spentResets.length === 0) {
    return { cause: "plan-allowance-exhausted" };
  }
  const resetsAt = codexEpochSecondsToRfc3339Utc(Math.max(...spentResets));
  if (resetsAt === null) {
    return { cause: "plan-allowance-exhausted" };
  }
  return {
    cause: "plan-allowance-exhausted",
    resetBoundary: { resetsAt },
  };
}
