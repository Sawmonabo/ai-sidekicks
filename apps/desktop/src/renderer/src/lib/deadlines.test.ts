import { describe, expect, it } from "vitest";

import { earliestFutureDeadline } from "./deadlines.js";

/** The instant each case is read against; any finite value serves. */
const MOUNTED_AT = 1_000;

describe("earliestFutureDeadline — what is armed for", () => {
  it("takes the soonest deadline still ahead", () => {
    expect(earliestFutureDeadline([5_000, 2_000, 9_000], MOUNTED_AT)).toBe(2_000);
  });

  it("skips a deadline already behind the instant", () => {
    expect(earliestFutureDeadline([500, 2_000], MOUNTED_AT)).toBe(2_000);
    expect(earliestFutureDeadline([500, 900], MOUNTED_AT)).toBeUndefined();
  });

  it("skips a value that is not a finite instant", () => {
    // A timeout scheduled against `NaN` fires immediately and forever, which is the
    // one way this substrate could become the poll it exists to avoid.
    expect(earliestFutureDeadline([Number.NaN, Number.POSITIVE_INFINITY], MOUNTED_AT)).toBe(
      undefined,
    );
    expect(earliestFutureDeadline([Number.NaN, 3_000], MOUNTED_AT)).toBe(3_000);
  });

  it("negative control: the deadline exactly at the instant is behind, not ahead", () => {
    // Without this, an implementation using `<` instead of `<=` would arm a
    // zero-delay timer for a threshold the caller has already crossed.
    expect(earliestFutureDeadline([MOUNTED_AT], MOUNTED_AT)).toBeUndefined();
  });
});
