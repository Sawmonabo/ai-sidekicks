// A device backs off a sign-in route's 429 by its body, so the body carries both the wait in
// seconds and the instant the window frees; a body missing either is refused.
import { describe, it } from "vitest";

import { RateLimitResponseSchema } from "../rate-limiter.js";
import { accepts, refusesAt } from "./safe-parse.test-support.js";

const REFUSAL = {
  code: "rate_limited",
  retryAfter: 42,
  limit: 20,
  remaining: 0,
  resetAt: "2026-10-07T10:00:42.000Z",
};

describe("RateLimitResponseSchema", () => {
  it("accepts a refusal carrying both timing fields", () => {
    accepts(RateLimitResponseSchema, REFUSAL);
  });

  it("refuses a refusal missing retryAfter", () => {
    const { retryAfter: _retryAfter, ...withoutRetryAfter } = REFUSAL;
    refusesAt(RateLimitResponseSchema, withoutRetryAfter, "retryAfter");
  });

  it("refuses a refusal missing resetAt", () => {
    const { resetAt: _resetAt, ...withoutResetAt } = REFUSAL;
    refusesAt(RateLimitResponseSchema, withoutResetAt, "resetAt");
  });
});
