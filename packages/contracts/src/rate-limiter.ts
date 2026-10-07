// The relay's sign-in-route limit as a device reads it: the body of a 429 refusal, and the code a
// sign-in route refuses with when the relay cannot tell which address a request came from.
import { z } from "zod";

import { countSchema, isoDateTimeSchema } from "./internal/wire-scalars.js";

/** Type of {@link RATE_LIMITED_CODE}. */
export type RateLimitedCode = "rate_limited";
/** The code every 429 refusal of a sign-in route carries. */
export const RATE_LIMITED_CODE: RateLimitedCode = "rate_limited";

/** Type of {@link SOURCE_ADDRESS_UNRESOLVABLE_CODE}. */
export type SourceAddressUnresolvableCode = "relay.source_address_unresolvable";
/**
 * The code of the 400 a sign-in route answers when the request carries no source address the relay
 * can count, so it is refused rather than counted in a bucket other callers share.
 */
export const SOURCE_ADDRESS_UNRESOLVABLE_CODE: SourceAddressUnresolvableCode =
  "relay.source_address_unresolvable";

/**
 * The body of a 429 from a sign-in route. `retryAfter` is whole seconds until a retry is allowed,
 * the same value as the `Retry-After` header; `resetAt` is the instant the oldest counted request
 * leaves the window, when the next request is admitted.
 */
export interface RateLimitResponse {
  code: RateLimitedCode;
  retryAfter: number;
  limit: number;
  remaining: number;
  resetAt: string;
}
/** Parses a {@link RateLimitResponse}; every member is required, both timing fields included. */
export const RateLimitResponseSchema: z.ZodType<RateLimitResponse, RateLimitResponse> = z
  .object({
    code: z.literal(RATE_LIMITED_CODE),
    retryAfter: countSchema,
    limit: countSchema,
    remaining: countSchema,
    resetAt: isoDateTimeSchema,
  })
  .strict();
