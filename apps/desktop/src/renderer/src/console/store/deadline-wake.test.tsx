// One timer, at the earliest deadline, and none when nothing is outstanding.
//
// Every claim here is checked by COUNTING armed work on the clock seam rather than by
// asserting it, which is the whole reason the seam exists: `ManualClock.pendingCount`
// answers "does anything still have a timer armed?", and a counting subclass answers
// the second question a re-arming chain raises — "how many times was one armed?".
// That second number is what separates a hook whose effect depends on the earliest
// deadline from one that depends on the caller's array identity, and the two are
// indistinguishable from `pendingCount` alone.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ManualClock, type ScheduledHandle } from "../core/index.js";
import { earliestFutureDeadline, useDeadlineWake } from "./deadline-wake.js";

/**
 * The real clock, instrumented — not a stand-in for it.
 *
 * A local fake would prove the test's own arithmetic; this subclasses the module the
 * console actually runs on and counts the one call the claims are about.
 */
class CountingManualClock extends ManualClock {
  public armCount = 0;

  public override scheduleTimeout(callback: () => void, delayMs: number): ScheduledHandle {
    this.armCount += 1;
    return super.scheduleTimeout(callback, delayMs);
  }
}

const MOUNTED_AT = 1_000;

function WakingSurface(props: {
  readonly clock: ManualClock;
  readonly deadlines: readonly number[];
}): React.JSX.Element {
  const nowMilliseconds = useDeadlineWake(props.clock, props.deadlines);
  return <output>{String(nowMilliseconds)}</output>;
}

function renderWake(
  clock: ManualClock,
  deadlines: readonly number[],
): { readonly instant: () => number; readonly setDeadlines: (next: readonly number[]) => void } {
  const { container, rerender } = render(<WakingSurface clock={clock} deadlines={deadlines} />);
  return {
    instant: () => Number(container.textContent),
    setDeadlines: (next) => {
      rerender(<WakingSurface clock={clock} deadlines={next} />);
    },
  };
}

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

describe("useDeadlineWake — one timer, at the earliest deadline", () => {
  it("arms exactly one timer for a set of deadlines", () => {
    const clock = new CountingManualClock(MOUNTED_AT);
    renderWake(clock, [9_000, 2_000, 5_000]);
    expect(clock.pendingCount).toBe(1);
  });

  it("arms one timer for a thousand deadlines", () => {
    const clock = new CountingManualClock(MOUNTED_AT);
    const deadlines = Array.from({ length: 1_000 }, (unused, offset) => MOUNTED_AT + offset + 1);
    renderWake(clock, deadlines);
    expect(clock.pendingCount).toBe(1);
    expect(clock.armCount).toBe(1);
  });

  it("arms nothing when no deadline is in the future", () => {
    const clock = new CountingManualClock(MOUNTED_AT);
    renderWake(clock, []);
    expect(clock.pendingCount).toBe(0);
    renderWake(clock, [MOUNTED_AT - 1, 500]);
    expect(clock.pendingCount).toBe(0);
    expect(clock.armCount).toBe(0);
  });

  it("wakes at the earliest deadline and not before", () => {
    const clock = new CountingManualClock(MOUNTED_AT);
    const wake = renderWake(clock, [9_000, 2_000, 5_000]);
    expect(wake.instant()).toBe(MOUNTED_AT);
    act(() => {
      clock.advance(999);
    });
    expect(wake.instant()).toBe(MOUNTED_AT);
    act(() => {
      clock.advance(1);
    });
    expect(wake.instant()).toBe(2_000);
  });

  it("re-arms for the next deadline once one has been crossed", () => {
    const clock = new CountingManualClock(MOUNTED_AT);
    const wake = renderWake(clock, [5_000, 2_000]);
    act(() => {
      clock.advance(1_000);
    });
    expect(wake.instant()).toBe(2_000);
    expect(clock.pendingCount).toBe(1);
    act(() => {
      clock.advance(3_000);
    });
    expect(wake.instant()).toBe(5_000);
    // Nothing outstanding, so nothing armed: the chain stops on its own.
    expect(clock.pendingCount).toBe(0);
  });

  it("re-arms when the set changes to an earlier deadline", () => {
    const clock = new CountingManualClock(MOUNTED_AT);
    const wake = renderWake(clock, [9_000]);
    expect(clock.armCount).toBe(1);
    act(() => {
      wake.setDeadlines([9_000, 3_000]);
    });
    expect(clock.armCount).toBe(2);
    expect(clock.pendingCount).toBe(1);
    act(() => {
      clock.advance(2_000);
    });
    expect(wake.instant()).toBe(3_000);
  });

  it("drops its timer when the consumer unmounts", () => {
    const clock = new CountingManualClock(MOUNTED_AT);
    const { unmount } = render(<WakingSurface clock={clock} deadlines={[5_000]} />);
    expect(clock.pendingCount).toBe(1);
    unmount();
    expect(clock.pendingCount).toBe(0);
  });
});

describe("useDeadlineWake — the dependency is the deadline, not the array", () => {
  it("re-arms nothing when the caller rebuilds an equal array", () => {
    // The defect this hook is hoisted to remove: a caller mapping a store selection
    // into deadlines hands a fresh array every render, and an effect keyed on that
    // array cancels and re-arms a timer on every single one.
    const clock = new CountingManualClock(MOUNTED_AT);
    const wake = renderWake(clock, [5_000, 9_000]);
    expect(clock.armCount).toBe(1);
    for (let renderPass = 0; renderPass < 5; renderPass += 1) {
      act(() => {
        wake.setDeadlines([5_000, 9_000]);
      });
    }
    expect(clock.armCount).toBe(1);
  });

  it("negative control: a changed earliest deadline does re-arm", () => {
    // Without this the assertion above would also be satisfied by a hook that armed
    // once and never again, which is a wake-up that stops working the moment the
    // rows change.
    const clock = new CountingManualClock(MOUNTED_AT);
    const wake = renderWake(clock, [5_000]);
    expect(clock.armCount).toBe(1);
    act(() => {
      wake.setDeadlines([4_000]);
    });
    expect(clock.armCount).toBe(2);
  });

  it("re-arms nothing when a LATER deadline changes under an unchanged earliest", () => {
    // The earliest is what is armed for, so a set whose tail moved has not changed
    // what this hook has to do.
    const clock = new CountingManualClock(MOUNTED_AT);
    const wake = renderWake(clock, [5_000, 9_000]);
    act(() => {
      wake.setDeadlines([5_000, 12_000]);
    });
    expect(clock.armCount).toBe(1);
  });
});
