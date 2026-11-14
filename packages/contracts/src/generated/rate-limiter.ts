// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The relay's sign-in-route limit as a device reads it: the body of a 429 refusal, and the code a sign-in route refuses with when the relay cannot tell which address a request came from.

import type { WireInstant } from "./internal/wire-scalars.js";

/** The code every 429 refusal of a sign-in route carries. */
export const RELAY_RATE_LIMITED_CODE = "relay.rateLimited" as const;

/**
 * The code of the 400 a sign-in route answers when the request carries no source address the
 * relay can count, so it is refused rather than counted in a bucket other callers share.
 */
export const RELAY_SOURCE_ADDRESS_UNRESOLVABLE_CODE = "relay.sourceAddressUnresolvable" as const;

/**
 * The body of a 429 from a sign-in route. `retryAfter` is whole seconds until a retry is allowed,
 * the same value as the `Retry-After` header; `resetAt` is the instant the oldest counted request
 * leaves the window, when the next request is admitted.
 */
export interface RateLimitResponse {
  /**
   * Always `relay.rateLimited`.
   */
  code: "relay.rateLimited";
  /**
   * Always `resourceExhausted`.
   */
  category: "resourceExhausted";
  /**
   * A sentence for a person.
   */
  message: string;
  /**
   * Whole seconds until a retry is allowed.
   */
  retryAfter: number;
  /**
   * The requests the window admits.
   */
  limit: number;
  /**
   * The requests the window still admits.
   */
  remaining: number;
  /**
   * When the oldest counted request leaves the window.
   */
  resetAt: WireInstant;
}

export { validateRateLimitResponse } from "./checks/rate-limiter.js";
