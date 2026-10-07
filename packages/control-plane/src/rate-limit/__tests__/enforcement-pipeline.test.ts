// The admission check decides by the counter alone, and a counter failure reaches the caller
// unchanged, so the request fails rather than slipping through uncounted.

import { describe, expect, it, vi } from "vitest";

import { createAdmissionCheck } from "../enforcement-pipeline.js";
import type {
  RateLimitCheckRequest,
  RateLimitCheckResponse,
  RateLimitEndpointGroup,
  RateLimiter,
} from "../limiter.js";

const REQUEST: RateLimitCheckRequest = { identity: "203.0.113.7", endpoint: "auth.endpoint" };

// One counter whose `check` answers as given, and spies on which counter was asked and with what.
function limiterAnswering(check: RateLimiter["check"]) {
  const checkSpy = vi.fn(check);
  const limiterFor = vi.fn(
    (_endpoint: RateLimitEndpointGroup): RateLimiter => ({
      check: checkSpy,
    }),
  );
  return { limiterFor, check: checkSpy };
}

describe("createAdmissionCheck", () => {
  const rows: readonly { readonly label: string; readonly check: RateLimitCheckResponse }[] = [
    {
      label: "admits a request the window has room for",
      check: { allowed: true, remaining: 19, resetAt: "2026-10-07T12:01:00.000Z", limit: 20 },
    },
    {
      label: "refuses a request over the limit, carrying the window the 429 is built from",
      check: { allowed: false, remaining: 0, resetAt: "2026-10-07T12:00:42.000Z", limit: 20 },
    },
  ];

  for (const row of rows) {
    it(row.label, async () => {
      const limiter = limiterAnswering(async () => row.check);
      const checkAdmission = createAdmissionCheck({ limiterFor: limiter.limiterFor });

      const admission = await checkAdmission(REQUEST);

      expect(admission.admitted).toBe(row.check.allowed);
      expect(admission.check).toBe(row.check);
      expect(limiter.limiterFor).toHaveBeenCalledWith("auth.endpoint");
      expect(limiter.check).toHaveBeenCalledWith(REQUEST);
    });
  }

  it("rejects with the counter's own error when the counter fails", async () => {
    const counterFailure = new Error("rate-limit counter unreachable");
    const limiter = limiterAnswering(async () => {
      throw counterFailure;
    });
    const checkAdmission = createAdmissionCheck({ limiterFor: limiter.limiterFor });

    await expect(checkAdmission(REQUEST)).rejects.toBe(counterFailure);
  });
});
