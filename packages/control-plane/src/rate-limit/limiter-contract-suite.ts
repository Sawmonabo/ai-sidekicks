// The behavior both relays' counters must share, run against each of them: the same limit, the same
// sliding window and the same reported reset time. Only `Date` is faked, so the suite runs on Node
// and inside workerd alike; each test counts its own address, so no test meets another's window.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RATE_LIMIT_ENDPOINT_GROUPS } from "./endpoint-groups.js";
import type { RateLimitCheckResponse, RateLimiter } from "./limiter.js";

const { limit, periodSeconds } = RATE_LIMIT_ENDPOINT_GROUPS["auth.endpoint"];
const windowMilliseconds = periodSeconds * 1000;

function isoAt(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function checkAddress(limiter: RateLimiter, identity: string): Promise<RateLimitCheckResponse> {
  return limiter.check({ identity, endpoint: "auth.endpoint" });
}

// Sends `count` requests one millisecond apart, so the first is the oldest counted.
async function checkRepeatedly(
  limiter: RateLimiter,
  identity: string,
  count: number,
): Promise<RateLimitCheckResponse[]> {
  const responses: RateLimitCheckResponse[] = [];
  for (let index = 0; index < count; index += 1) {
    responses.push(await checkAddress(limiter, identity));
    vi.setSystemTime(Date.now() + 1);
  }
  return responses;
}

/**
 * Registers the counter contract against the limiter `makeLimiter` builds, once per test. Every
 * counter of a relay passes it, so the two relays count the sign-in routes alike.
 */
export function describeRateLimiterContract(makeLimiter: () => Promise<RateLimiter>): void {
  describe("RateLimiter contract", () => {
    let limiter: RateLimiter;
    let startMilliseconds: number;

    beforeEach(async () => {
      // A day ahead of the real clock, so a Durable Object alarm armed by a test never comes due
      // while the suite runs.
      startMilliseconds = Date.now() + 86_400_000;
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(startMilliseconds);
      limiter = await makeLimiter();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("counts down to the limit, then refuses; each resets at the oldest's expiry", async () => {
      const responses = await checkRepeatedly(limiter, "192.0.2.1", limit + 1);

      const resetAt = isoAt(startMilliseconds + windowMilliseconds);
      expect(responses).toEqual([
        ...Array.from({ length: limit }, (_, index) => ({
          allowed: true,
          remaining: limit - 1 - index,
          resetAt,
          limit,
        })),
        { allowed: false, remaining: 0, resetAt, limit },
      ]);
    });

    it("frees a slot at exactly the reset time a refusal reports, and not before", async () => {
      const identity = "192.0.2.2";
      await checkRepeatedly(limiter, identity, limit);
      const refusal = await checkAddress(limiter, identity);
      expect(refusal.allowed).toBe(false);
      const resetAtMilliseconds = Date.parse(refusal.resetAt);

      vi.setSystemTime(resetAtMilliseconds - 1);
      expect((await checkAddress(limiter, identity)).allowed).toBe(false);

      vi.setSystemTime(resetAtMilliseconds);
      // The first request has aged out and the second is now the oldest counted.
      expect(await checkAddress(limiter, identity)).toEqual({
        allowed: true,
        remaining: 0,
        resetAt: isoAt(startMilliseconds + 1 + windowMilliseconds),
        limit,
      });
    });

    it("allows the full limit once the window passes, despite refusals within it", async () => {
      const identity = "192.0.2.3";
      for (let index = 0; index < limit; index += 1) await checkAddress(limiter, identity);
      expect((await checkAddress(limiter, identity)).allowed).toBe(false);
      vi.setSystemTime(startMilliseconds + windowMilliseconds / 2);
      expect((await checkAddress(limiter, identity)).allowed).toBe(false);

      vi.setSystemTime(startMilliseconds + windowMilliseconds);
      expect(await checkAddress(limiter, identity)).toEqual({
        allowed: true,
        remaining: limit - 1,
        resetAt: isoAt(startMilliseconds + 2 * windowMilliseconds),
        limit,
      });
    });

    it("counts each address on its own: one at its limit leaves another untouched", async () => {
      const limitedIdentity = "192.0.2.4";
      const otherIdentity = "192.0.2.5";
      await checkRepeatedly(limiter, limitedIdentity, limit);
      expect((await checkAddress(limiter, limitedIdentity)).allowed).toBe(false);

      expect(await checkAddress(limiter, otherIdentity)).toEqual({
        allowed: true,
        remaining: limit - 1,
        resetAt: isoAt(Date.now() + windowMilliseconds),
        limit,
      });
    });
  });
}
