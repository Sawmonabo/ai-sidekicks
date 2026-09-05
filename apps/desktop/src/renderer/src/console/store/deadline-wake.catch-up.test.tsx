// What a wake-up that arrives after several deadlines settles at.
//
// Its own suite because it is a different claim from the timer-and-dependency ones
// next door: those are about what gets ARMED, this is about which instant a late
// wake-up publishes — the difference between one render and one per deadline behind
// the surface. The clock and the render harness are shared through
// `deadline-wake.test-support.tsx`.

import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { earliestFutureDeadline, latestPassedDeadline } from "./deadline-wake.js";
import { CountingManualClock, MOUNTED_AT, renderWake } from "./deadline-wake.test-support.js";

describe("latestPassedDeadline — what a late wake-up settles", () => {
  it("takes the last deadline the clock has already passed", () => {
    expect(latestPassedDeadline([2_000, 5_000, 9_000], 6_000)).toBe(5_000);
  });

  it("counts the deadline exactly at the instant as passed", () => {
    // The mirror of `earliestFutureDeadline`'s own boundary rule, which calls that
    // same instant behind rather than ahead. The two partition the list.
    expect(latestPassedDeadline([5_000], 5_000)).toBe(5_000);
    expect(earliestFutureDeadline([5_000], 5_000)).toBeUndefined();
  });

  it("skips a value that is not a finite instant", () => {
    expect(latestPassedDeadline([Number.NaN, Number.NEGATIVE_INFINITY, 2_000], 6_000)).toBe(2_000);
  });

  it("negative control: a list entirely ahead has settled nothing", () => {
    expect(latestPassedDeadline([9_000], 6_000)).toBeUndefined();
  });
});

describe("useDeadlineWake — a wake-up that arrives after several deadlines", () => {
  it("settles every crossed deadline in one pass rather than one per render", () => {
    // A host that slept, a backgrounded tab, and a scenario advanced by an hour all
    // reach this: many deadlines behind the instant at once. Publishing the earliest
    // of them settles one boundary per render and arms again for the next, which is
    // a re-render chain as long as the list — and past about fifty of them React
    // refuses the update entirely, leaving the figure on screen stale for good.
    const clock = new CountingManualClock(MOUNTED_AT);
    const deadlines = Array.from({ length: 80 }, (_unused, step) => 2_000 + step * 1_000);
    const wake = renderWake(clock, deadlines);
    expect(wake.instant()).toBe(MOUNTED_AT);

    act(() => {
      clock.advance(90_000);
    });

    // The LAST deadline crossed, which is a deadline the caller's own list carries —
    // never the clock's own reading, which corresponds to no threshold in it.
    expect(wake.instant()).toBe(81_000);
    expect(clock.pendingCount).toBe(0);
  });

  it("negative control: one crossed deadline still settles at that deadline", () => {
    // Without this, the case above would hold for a hook that published the clock's
    // reading of now, which is the one instant this module may never put on screen.
    const clock = new CountingManualClock(MOUNTED_AT);
    const wake = renderWake(clock, [2_000, 9_000]);

    act(() => {
      clock.advance(3_000);
    });

    expect(wake.instant()).toBe(2_000);
  });
});
