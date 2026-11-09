// The Sidekicks badge hides while the session dispatched nothing, counts what it dispatched, takes
// the accent while a child waits on an approval, and dims its count while none runs.

import { describe, expect, it } from "vitest";

import { readSidekicksBadge } from "./badge.js";

describe("the strip's Sidekicks badge", () => {
  it("hides, counts, takes the accent and dims as the counts say", () => {
    // Mutation: reading `live` as the count, or `total > 0` as waiting, fails one line each.
    expect(readSidekicksBadge(undefined)).toStrictEqual({ kind: "hidden" });
    expect(readSidekicksBadge({ live: 0, total: 0, waiting: 0 })).toStrictEqual({
      kind: "hidden",
    });
    expect(readSidekicksBadge({ live: 2, total: 3, waiting: 1 })).toStrictEqual({
      kind: "shown",
      count: 3,
      isWaiting: true,
      isCountDimmed: false,
    });
    expect(readSidekicksBadge({ live: 0, total: 3, waiting: 0 })).toStrictEqual({
      kind: "shown",
      count: 3,
      isWaiting: false,
      isCountDimmed: true,
    });
  });
});
