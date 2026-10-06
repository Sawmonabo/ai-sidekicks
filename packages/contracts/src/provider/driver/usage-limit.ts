// The provider usage-limit signal and the spent-retries signal a driver hands over with a turn's
// end, which a failed run's `failureCause` carries.
//
// A driver emits a usage-limit signal only when a structured provider event it can name says the
// allowance is spent. Prose, an exit code or a bare HTTP status are never inputs, since the
// provider may reword or reuse them; an unrecognized shape emits nothing, which reads "not known
// to be limited". There is no capability flag: recognition is required of every driver.
import { z } from "zod";

import { isoDateTimeSchema } from "../../internal/wire-scalars.js";

/**
 * Why a provider refused for spend, on an axis separate from `RecoveryCondition`: only
 * `plan-allowance-exhausted`, the subscription allowance for a rolling window, clears on its own.
 * A depleted credit balance, a payment fault and a spend-control ceiling need a person, so a turn
 * refused for one of them settles on the driver's ordinary turn-failure path.
 */
export const PROVIDER_USAGE_LIMIT_CAUSES = ["plan-allowance-exhausted"] as const;

/** One member of {@link PROVIDER_USAGE_LIMIT_CAUSES}. */
export type ProviderUsageLimitCause = (typeof PROVIDER_USAGE_LIMIT_CAUSES)[number];

/** Parses a {@link ProviderUsageLimitCause}. */
export const ProviderUsageLimitCauseSchema: z.ZodType<
  ProviderUsageLimitCause,
  ProviderUsageLimitCause
> = z.enum(PROVIDER_USAGE_LIMIT_CAUSES);

/** The instant the provider named for the spent window to reset. */
export interface ProviderUsageLimitResetBoundary {
  // RFC 3339 UTC.
  resetsAt: string;
}

/** Parses a {@link ProviderUsageLimitResetBoundary}. */
export const ProviderUsageLimitResetBoundarySchema: z.ZodType<ProviderUsageLimitResetBoundary> = z
  .object({ resetsAt: isoDateTimeSchema })
  .strict();

/**
 * A recognized provider usage-limit refusal. A missing boundary only means no reset instant was
 * observed, so no resume is scheduled; it does not mean the provider publishes none.
 */
export interface ProviderUsageLimitSignal {
  cause: ProviderUsageLimitCause;
  resetBoundary?: ProviderUsageLimitResetBoundary | undefined;
}

/**
 * A turn that ended because the provider's own retries ran out: the provider did not answer.
 * Nothing clears on its own, so no reset boundary rides it.
 */
export interface ProviderSpentRetriesSignal {
  cause: "retries-exhausted";
}
