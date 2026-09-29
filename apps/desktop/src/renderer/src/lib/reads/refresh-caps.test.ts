// The refresh scheduler's windows, held to the relations their rationales claim. When one of
// these inverts, the mechanism does not fail loudly; it quietly stops existing.

import { describe, expect, it } from "vitest";

import { APPLY_COALESCE_MS, REFRESH_DEBOUNCE_MS, REFRESH_MAX_WAIT_MS } from "./refresh-caps.js";

describe("refresh caps — the scheduler's two windows", () => {
  it("keeps the trailing debounce strictly inside the absolute deadline", () => {
    // The scheduler fires at `min(lastEvent + DEBOUNCE, firstEvent + MAX_WAIT)`. At
    // or above the deadline the debounce always wins that `min`, and the starvation
    // guard the deadline exists to be stops existing without any code changing.
    expect(REFRESH_DEBOUNCE_MS).toBeLessThan(REFRESH_MAX_WAIT_MS);
  });

  it("keeps the apply-coalescing window no wider than the debounce", () => {
    // Coalescing folds a burst into one notification for the read the debounce then
    // schedules. A window wider than the debounce would fold across that read, so
    // the render the burst caused would show the state before it.
    expect(APPLY_COALESCE_MS).toBeLessThanOrEqual(REFRESH_DEBOUNCE_MS);
  });

  it("keeps every millisecond bound positive", () => {
    expect(REFRESH_DEBOUNCE_MS).toBeGreaterThan(0);
    expect(REFRESH_MAX_WAIT_MS).toBeGreaterThan(0);
    expect(APPLY_COALESCE_MS).toBeGreaterThan(0);
  });
});
