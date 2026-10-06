// The typed provider usage-limit signal, Codex side: read only from typed fields, never from prose
// or an exit code, and absent on any shape it does not know. Snapshot shapes follow the pinned
// generated protocol: `RateLimitSnapshot` carries `rateLimitReachedType` and `primary` /
// `secondary` `RateLimitWindow`s (`usedPercent`, `windowDurationMins`, `resetsAt` in Unix seconds).

import { describe, expect, it } from "vitest";

import { classifyCodexUsageLimitSignal } from "../usage-limit-signal.js";

/** `2026-09-01T00:00:00.000Z`, as the provider states it. */
const SEPTEMBER_RESET_EPOCH_SECONDS = 1788220800;
/** Six hours later, so "latest wins" is distinguishable from "first wins". */
const LATER_RESET_EPOCH_SECONDS = SEPTEMBER_RESET_EPOCH_SECONDS + 21600;

function rateLimitsReadReply(snapshot: Record<string, unknown>): Record<string, unknown> {
  return { rateLimits: snapshot };
}

describe("classifyCodexUsageLimitSignal: typed-only recognition on the account plane", () => {
  it("emits the signal with the reset boundary the spent window names", () => {
    const signal = classifyCodexUsageLimitSignal({
      latestRead: rateLimitsReadReply({
        rateLimitReachedType: "rate_limit_reached",
        limitName: "Weekly limit",
        primary: {
          usedPercent: 100,
          windowDurationMins: 10080,
          resetsAt: SEPTEMBER_RESET_EPOCH_SECONDS,
        },
        secondary: {
          usedPercent: 42,
          windowDurationMins: 300,
          resetsAt: LATER_RESET_EPOCH_SECONDS,
        },
      }),
      rollingUpdate: null,
    });

    expect(signal).toEqual({
      cause: "plan-allowance-exhausted",
      resetBoundary: { resetsAt: "2026-09-01T00:00:00.000Z" },
    });
  });

  it("produces no signal from prose or an exit code a text matcher would accept", () => {
    // Prose and exit codes a text-matching classifier would accept; none is the typed enum, so all
    // four must be silent.
    const proseAndExitCodeCarriers: readonly unknown[] = [
      { exitCode: 429, message: "You have exceeded your usage limit. Resets 2026-09-01." },
      { rateLimits: { limitName: "usage limit reached — try again after the weekly reset" } },
      {
        rateLimits: {
          limitId: "weekly",
          limitName: "Rate limit exceeded",
          planType: "pro",
          spendControlReached: true,
          primary: { usedPercent: 100, resetsAt: SEPTEMBER_RESET_EPOCH_SECONDS },
        },
      },
      { error: { code: -32000, message: "429 Too Many Requests: usage limit reached" } },
    ];

    for (const carrier of proseAndExitCodeCarriers) {
      expect(
        classifyCodexUsageLimitSignal({ latestRead: carrier, rollingUpdate: null }),
      ).toBeNull();
      expect(
        classifyCodexUsageLimitSignal({ latestRead: null, rollingUpdate: carrier }),
      ).toBeNull();
    }
  });

  it("yields no signal, never a default-caused one, on unparseable or absent input", () => {
    const unrecognized: readonly unknown[] = [
      null,
      undefined,
      "account/rateLimits/read",
      42,
      [],
      [{ rateLimits: { rateLimitReachedType: "rate_limit_reached" } }],
      {},
      { rateLimits: null },
      { rateLimits: "rate_limit_reached" },
      { rateLimits: { rateLimitReachedType: "quota_exhausted" } },
      { rateLimits: { rateLimitReachedType: 7 } },
      { rateLimits: { rateLimitReachedType: { kind: "rate_limit_reached" } } },
    ];
    for (const carrier of unrecognized) {
      expect(
        classifyCodexUsageLimitSignal({ latestRead: carrier, rollingUpdate: null }),
      ).toBeNull();
      expect(
        classifyCodexUsageLimitSignal({ latestRead: null, rollingUpdate: carrier }),
      ).toBeNull();
    }
    expect(classifyCodexUsageLimitSignal({ latestRead: null, rollingUpdate: null })).toBeNull();
  });
});
