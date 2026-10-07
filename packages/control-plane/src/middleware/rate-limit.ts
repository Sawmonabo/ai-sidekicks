// Counts a procedure's requests per source address and refuses one over its endpoint group's limit
// with a 429, its `Retry-After` header and the rate-limit body. An admitted request carries no
// rate-limit header.

import {
  RATE_LIMITED_CODE,
  SOURCE_ADDRESS_UNRESOLVABLE_CODE,
  type RateLimitResponse,
} from "@ai-sidekicks/contracts/rate-limiter";
import type { TRPCMiddlewareBuilder } from "@trpc/server";
import ipaddr from "ipaddr.js";

import type { RateLimitCheckResponse, RateLimitEndpointGroup } from "../rate-limit/limiter.js";
import { ControlPlaneRefusal, t, type ControlPlaneContext } from "../server/trpc.js";

const UNRESOLVABLE_ADDRESS_MESSAGE =
  "The request carries no source address the relay can count, so it is refused.";

/**
 * Counts each request of the procedure it wraps against `endpoint`'s limit. Throws a 400 refusal
 * when the request has no address to count and a 429 refusal over the limit; a counter error
 * rejects the request as the counter raised it.
 */
export function rateLimitProcedure(options: {
  readonly endpoint: RateLimitEndpointGroup;
}): TRPCMiddlewareBuilder<ControlPlaneContext, object, object, unknown> {
  return t.middleware(async ({ ctx, next }) => {
    const identity = canonicalIdentityOf(ctx.sourceAddress);
    if (identity === undefined) {
      throw new ControlPlaneRefusal({
        trpcCode: "BAD_REQUEST",
        message: UNRESOLVABLE_ADDRESS_MESSAGE,
        body: { code: SOURCE_ADDRESS_UNRESOLVABLE_CODE, message: UNRESOLVABLE_ADDRESS_MESSAGE },
      });
    }

    const admission = await ctx.checkAdmission({ identity, endpoint: options.endpoint });
    if (!admission.admitted) {
      const refusal = rateLimitResponseFrom(admission.check, Date.now());
      ctx.responseHeaders.set("Retry-After", String(refusal.retryAfter));
      throw new ControlPlaneRefusal({
        trpcCode: "TOO_MANY_REQUESTS",
        message: `Too many requests from this address; retry in ${refusal.retryAfter} seconds.`,
        body: refusal,
      });
    }
    return next();
  });
}

// An IPv4 address counts as itself and an IPv6 address by its /64, so a host cannot step around
// its count across the addresses one network hands it. Undefined when nothing parses as one.
function canonicalIdentityOf(sourceAddress: string | undefined): string | undefined {
  if (sourceAddress === undefined) return undefined;
  // Only the four-part decimal spelling: ipaddr.js also reads shorthand such as `127.1`.
  if (ipaddr.IPv4.isValidFourPartDecimal(sourceAddress)) return sourceAddress;
  if (!ipaddr.IPv6.isValid(sourceAddress)) return undefined;

  const address = ipaddr.IPv6.parse(sourceAddress);
  if (address.isIPv4MappedAddress()) return address.toIPv4Address().toString();
  const network = ipaddr.IPv6.networkAddressFromCIDR(`${address.toRFC5952String()}/64`);
  return `${network.toRFC5952String()}/64`;
}

// The one place `retryAfter` is computed: the body carries it and the header is set from it.
function rateLimitResponseFrom(check: RateLimitCheckResponse, now: number): RateLimitResponse {
  return {
    code: RATE_LIMITED_CODE,
    retryAfter: Math.max(0, Math.ceil((Date.parse(check.resetAt) - now) / 1000)),
    limit: check.limit,
    remaining: check.remaining,
    resetAt: check.resetAt,
  };
}
