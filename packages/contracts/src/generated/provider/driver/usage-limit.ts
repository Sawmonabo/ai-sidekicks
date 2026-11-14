// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The usage-limit signal and the spent-retries signal a driver hands over with a turn's end, which a failed run's cause carries.

import type { WireInstant } from "../../internal/wire-scalars.js";
import type { CredentialGeneration, ProviderAccountId } from "../account/record.js";

/** Every usage-limit cause. */
export const PROVIDER_USAGE_LIMIT_CAUSES = ["planAllowanceExhausted"] as const;

/**
 * Why a provider refused for spend, on an axis apart from the recovery condition. Only the plan's
 * allowance for a rolling window clears on its own; a spent credit balance, a payment fault or a
 * spending ceiling needs a person, so such a turn ends on the driver's ordinary failure path.
 */
export type ProviderUsageLimitCause = "planAllowanceExhausted";

/**
 * The instant the provider named for the spent window to reset.
 */
export interface ProviderUsageLimitResetBoundary {
  /**
   * When the window resets.
   */
  resetsAt: WireInstant;
}
/**
 * A recognized usage-limit refusal, on the account and credential generation of the conversation
 * that met it. A missing boundary means no reset instant was seen, so no resume is scheduled; it
 * does not mean the provider publishes none.
 */
export interface ProviderUsageLimitSignal {
  /**
   * Why the provider refused.
   */
  cause: ProviderUsageLimitCause;
  /**
   * The account whose allowance is spent: the one the conversation ran on.
   */
  providerAccountId: ProviderAccountId;
  /**
   * The account's credential generation when the limit was met, so a signal from before a
   * sign-in again reads as stale.
   */
  credentialGeneration: CredentialGeneration;
  /**
   * When the spent window resets, where the provider named it.
   */
  resetBoundary?: ProviderUsageLimitResetBoundary;
}
/**
 * A turn that ended because the provider's own retries ran out: the provider did not answer.
 * Nothing clears on its own, so no reset boundary rides it.
 */
export interface ProviderSpentRetriesSignal {
  /**
   * Always `retriesExhausted`.
   */
  cause: "retriesExhausted";
}

export { validateProviderUsageLimitResetBoundary } from "../../checks/provider/driver/usage-limit.js";
