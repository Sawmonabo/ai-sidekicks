// Claude Code's spent retries, read off its retry frame: the final announced retry of a rate limit
// or an overload ends the turn with the provider not answering, never with a spent plan allowance,
// and the reading is typed-only. Frames carry the retry frame's recorded members:
// `{ type: "system", subtype: "api_retry", attempt, max_retries, retry_delay_ms, error_status,
// error }`.

import { describe, expect, it } from "vitest";

import { classifyClaudeSpentRetries } from "../spent-retries-signal.js";

const SPENT_RETRIES = { cause: "retries-exhausted" } as const;

// The default is the ladder's final announced attempt on purpose: the negative controls below
// assert `null` because of the member under test, and a mid-ladder default would let the attempt
// gate produce that `null` instead.
function apiRetryFrame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "system",
    subtype: "api_retry",
    attempt: 10,
    max_retries: 10,
    retry_delay_ms: 60000,
    error_status: 429,
    error: "rate_limit",
    ...overrides,
  };
}

describe("classifyClaudeSpentRetries", () => {
  it.each(["rate_limit", "overloaded"])(
    "ends a turn after the final %s retry as spent retries, only once the ladder is spent",
    (error) => {
      // A plan limit is never retried, so the end of a retry ladder is never a spent allowance.
      for (const attempt of [1, 2, 9]) {
        expect(
          classifyClaudeSpentRetries(apiRetryFrame({ error, attempt, max_retries: 10 })),
        ).toBeNull();
      }
      for (const attempt of [10, 11]) {
        expect(
          classifyClaudeSpentRetries(apiRetryFrame({ error, attempt, max_retries: 10 })),
        ).toStrictEqual(SPENT_RETRIES);
      }
    },
  );

  it("yields nothing when the ladder members are absent, malformed or announce no ladder", () => {
    expect(
      classifyClaudeSpentRetries({ type: "system", subtype: "api_retry", error: "rate_limit" }),
    ).toBeNull();
    const unusableLadders: readonly Record<string, unknown>[] = [
      { attempt: undefined, max_retries: 10 },
      { attempt: 10, max_retries: undefined },
      // `"10" >= "10"` is true, so a comparison without the numeric guard would classify here.
      { attempt: "10", max_retries: "10" },
      { attempt: 10, max_retries: null },
      { attempt: Number.NaN, max_retries: 10 },
      { attempt: 10, max_retries: [10] },
      // `max_retries: 0` announces no ladder; a bare finite check would let `0 >= 0` classify.
      { attempt: 0, max_retries: 0 },
      { attempt: -1, max_retries: -1 },
    ];
    for (const ladder of unusableLadders) {
      expect(classifyClaudeSpentRetries(apiRetryFrame(ladder))).toBeNull();
    }
  });

  it("reads the typed members alone: never prose, a bare 429 or an unfamiliar shape", () => {
    const unrecognized: readonly unknown[] = [
      apiRetryFrame({
        error: "server_error",
        message: "Rate limit exceeded — usage limit reached, retry after 60s",
      }),
      apiRetryFrame({ error: "billing_error", detail: "You have exceeded your plan's limit." }),
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        error_status: 429,
        result: "Claude usage limit reached. Your limit will reset at 3pm.",
      },
      { type: "system", subtype: "api_error", attempt: 10, max_retries: 10, error: "rate_limit" },
      null,
      undefined,
      "api_retry",
      [apiRetryFrame()],
      {},
      apiRetryFrame({ type: "assistant" }),
      apiRetryFrame({ error: undefined }),
      apiRetryFrame({ error: 429 }),
      apiRetryFrame({ error: { type: "rate_limit" } }),
    ];
    for (const frame of unrecognized) {
      expect(classifyClaudeSpentRetries(frame)).toBeNull();
    }
    // The typed member alone is enough; the status is never read.
    const { error_status: _omitted, ...withoutStatus } = apiRetryFrame();
    expect(classifyClaudeSpentRetries(withoutStatus)).toStrictEqual(SPENT_RETRIES);
  });
});
