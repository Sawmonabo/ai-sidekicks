import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RATE_LIMIT_ENDPOINT_GROUPS } from "../endpoint-groups.js";
import { createRateLimiterFactory } from "../factory.js";
import { InMemoryRateLimiter } from "../in-memory-limiter.js";
import { describeRateLimiterContract } from "../limiter-contract-suite.js";

const START = Date.parse("2026-01-01T00:00:00.000Z");
const WINDOW_MILLISECONDS = RATE_LIMIT_ENDPOINT_GROUPS["auth.endpoint"].periodSeconds * 1000;

function advanceTo(elapsedMilliseconds: number): void {
  vi.advanceTimersByTime(START + elapsedMilliseconds - Date.now());
}

describe("InMemoryRateLimiter window expiry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops a window once its newest request ages out, and leaves no timer armed", async () => {
    const limiter = new InMemoryRateLimiter();
    const returningAddress = "203.0.113.1";
    // Never checks again, so only the eviction timer can drop its window.
    const departedAddress = "203.0.113.2";

    await limiter.check({ identity: returningAddress, endpoint: "auth.endpoint" });
    advanceTo(10_000);
    await limiter.check({ identity: departedAddress, endpoint: "auth.endpoint" });
    advanceTo(30_000);
    await limiter.check({ identity: returningAddress, endpoint: "auth.endpoint" });

    // The returning address's first request has aged out, but its second still counts.
    advanceTo(10_000 + WINDOW_MILLISECONDS - 1);
    expect(limiter.heldWindowCount).toBe(2);

    advanceTo(10_000 + WINDOW_MILLISECONDS);
    expect(limiter.heldWindowCount).toBe(1);

    advanceTo(30_000 + WINDOW_MILLISECONDS);
    expect(limiter.heldWindowCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describeRateLimiterContract(async () =>
  createRateLimiterFactory({ kind: "node" }).forEndpoint("auth.endpoint"),
);
