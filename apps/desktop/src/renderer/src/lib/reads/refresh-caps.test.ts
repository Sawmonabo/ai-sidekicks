// The refresh windows keep the relations their rationales claim; an inversion fails silently.

import { describe, expect, it } from "vitest";

import { APPLY_COALESCE_MS, REFRESH_DEBOUNCE_MS, REFRESH_MAX_WAIT_MS } from "./refresh-caps.js";

describe("refresh caps — the scheduler's two windows", () => {
  it("keeps the trailing debounce strictly inside the absolute deadline", () => {
    // At or above the deadline the debounce always wins the scheduler's `min`, and the
    // starvation guard silently stops working.
    expect(REFRESH_DEBOUNCE_MS).toBeLessThan(REFRESH_MAX_WAIT_MS);
  });

  it("keeps the apply-coalescing window no wider than the debounce", () => {
    // A window wider than the debounce would fold across the read the debounce schedules, so
    // the render the burst caused would show the state before it.
    expect(APPLY_COALESCE_MS).toBeLessThanOrEqual(REFRESH_DEBOUNCE_MS);
  });

  it("keeps every millisecond bound positive", () => {
    expect(REFRESH_DEBOUNCE_MS).toBeGreaterThan(0);
    expect(REFRESH_MAX_WAIT_MS).toBeGreaterThan(0);
    expect(APPLY_COALESCE_MS).toBeGreaterThan(0);
  });
});
