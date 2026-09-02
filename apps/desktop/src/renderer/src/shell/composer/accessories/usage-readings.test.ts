// The usage fold, asserted where it decides something.
//
// Three claims are worth a unit here, because each one is a place the console could
// quietly start asserting a figure the daemon never sent: a payload missing a member
// yields NO reading rather than a partial one; the newest reading per key wins by
// the stated rule and not by arrival order; and a chip is marked stale only against
// a generation this session actually observed.
//
// Every clean assertion below has a negative control beside it, because a narrowing
// that accepted everything would pass all three.

import { describe, expect, it } from "vitest";

import type { ConsoleSessionEvent } from "../../../console/store/index.js";
import {
  CONTEXT_COMPACTED_EVENT_KIND,
  CONTEXT_WINDOW_EVENT_KIND,
  RATE_LIMIT_EVENT_KIND,
  foldRateLimitReadings,
  newestCompactionBoundarySequence,
  newestContextWindowReading,
  remainingPercentOf,
} from "./usage-readings.js";

const SESSION_ID = "session-under-test";

function event(
  sequence: number,
  kind: string,
  payload: Readonly<Record<string, unknown>>,
): ConsoleSessionEvent {
  return {
    sessionId: SESSION_ID,
    sequence,
    kind,
    occurredAt: "2026-01-01T00:00:00.000Z",
    payload,
  };
}

function rateLimitPayload(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    providerAccountId: "account-one",
    limitId: "weekly",
    accountLabel: "Team",
    limitLabel: "weekly",
    usedPercent: 90,
    observedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("newestContextWindowReading — a partial payload is no reading", () => {
  it("reads a complete payload", () => {
    const reading = newestContextWindowReading([
      event(1, CONTEXT_WINDOW_EVENT_KIND, {
        usagePercent: 62,
        tokenCount: 124_000,
        maxTokens: 200_000,
      }),
    ]);
    expect(reading).toStrictEqual({
      usagePercent: 62,
      tokenCount: 124_000,
      maxTokens: 200_000,
      sequence: 1,
    });
  });

  it("negative control: a payload missing one member yields nothing at all", () => {
    // The same row with `maxTokens` dropped. A narrowing that filled the hole with
    // a default would return a reading here, and the meter would draw a bar out of
    // a denominator the daemon never sent.
    const reading = newestContextWindowReading([
      event(1, CONTEXT_WINDOW_EVENT_KIND, { usagePercent: 62, tokenCount: 124_000 }),
    ]);
    expect(reading).toBeUndefined();
  });

  it("negative control: an out-of-range percent is refused rather than clamped", () => {
    const reading = newestContextWindowReading([
      event(1, CONTEXT_WINDOW_EVENT_KIND, {
        usagePercent: 140,
        tokenCount: 1,
        maxTokens: 2,
      }),
    ]);
    expect(reading).toBeUndefined();
  });

  it("takes the highest sequence, not the last element", () => {
    const reading = newestContextWindowReading([
      event(9, CONTEXT_WINDOW_EVENT_KIND, { usagePercent: 80, tokenCount: 8, maxTokens: 10 }),
      event(2, CONTEXT_WINDOW_EVENT_KIND, { usagePercent: 20, tokenCount: 2, maxTokens: 10 }),
    ]);
    expect(reading?.usagePercent).toBe(80);
  });
});

describe("foldRateLimitReadings — one row per account and limit", () => {
  it("keeps the newest observation for a key and the newest sequence on a tie", () => {
    const folded = foldRateLimitReadings([
      event(1, RATE_LIMIT_EVENT_KIND, rateLimitPayload({ usedPercent: 10 })),
      event(2, RATE_LIMIT_EVENT_KIND, rateLimitPayload({ usedPercent: 55 })),
      // An OLDER observation arriving later. The rule is newest `observedAt`, so
      // this must lose despite being the last row in the timeline.
      event(3, RATE_LIMIT_EVENT_KIND, {
        ...rateLimitPayload({ usedPercent: 99 }),
        observedAt: "2025-12-31T23:00:00.000Z",
      }),
    ]);
    expect(folded).toHaveLength(1);
    const survivor = folded[0];
    if (survivor === undefined) {
      throw new Error("the fold kept no reading for the only key it was given");
    }
    expect(survivor.usedPercent).toBe(55);
    expect(remainingPercentOf(survivor)).toBe(45);
  });

  it("separates two windows of one account", () => {
    const folded = foldRateLimitReadings([
      event(1, RATE_LIMIT_EVENT_KIND, rateLimitPayload({ limitId: "weekly-a", limitLabel: "A" })),
      event(2, RATE_LIMIT_EVENT_KIND, rateLimitPayload({ limitId: "weekly-b", limitLabel: "B" })),
    ]);
    expect(folded.map((reading) => reading.limitId)).toStrictEqual(["weekly-a", "weekly-b"]);
  });

  it("marks a reading stale only when a later generation was observed", () => {
    const folded = foldRateLimitReadings([
      event(
        1,
        RATE_LIMIT_EVENT_KIND,
        rateLimitPayload({ limitId: "weekly-a", limitLabel: "A", credentialGeneration: 1 }),
      ),
      event(
        2,
        RATE_LIMIT_EVENT_KIND,
        rateLimitPayload({ limitId: "weekly-b", limitLabel: "B", credentialGeneration: 4 }),
      ),
    ]);
    expect(folded.map((reading) => reading.isStale)).toStrictEqual([true, false]);
  });

  it("negative control: with no generation on the wire nothing is called stale", () => {
    const folded = foldRateLimitReadings([
      event(1, RATE_LIMIT_EVENT_KIND, rateLimitPayload({ limitId: "weekly-a", limitLabel: "A" })),
      event(2, RATE_LIMIT_EVENT_KIND, rateLimitPayload({ limitId: "weekly-b", limitLabel: "B" })),
    ]);
    expect(folded.every((reading) => !reading.isStale)).toBe(true);
  });

  it("negative control: a payload with no account label produces no chip", () => {
    const folded = foldRateLimitReadings([
      event(1, RATE_LIMIT_EVENT_KIND, rateLimitPayload({ accountLabel: "" })),
    ]);
    expect(folded).toStrictEqual([]);
  });
});

describe("newestCompactionBoundarySequence", () => {
  it("finds the newest boundary row", () => {
    expect(
      newestCompactionBoundarySequence([
        event(4, CONTEXT_COMPACTED_EVENT_KIND, {}),
        event(11, CONTEXT_COMPACTED_EVENT_KIND, {}),
      ]),
    ).toBe(11);
  });

  it("negative control: a timeline with no boundary reports none", () => {
    expect(
      newestCompactionBoundarySequence([
        event(4, CONTEXT_WINDOW_EVENT_KIND, { usagePercent: 1, tokenCount: 1, maxTokens: 2 }),
      ]),
    ).toBeUndefined();
  });
});
