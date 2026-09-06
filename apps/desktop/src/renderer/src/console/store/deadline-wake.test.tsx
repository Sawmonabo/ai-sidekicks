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
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RealClock, type ConsoleClock, type ScheduledHandle } from "../core/index.js";
// The unit factors come from the module that declares them rather than through the
// family door: their door specifiers are claimed for the families that will read them
// in production, and a claim a test retires is a claim nothing came to collect.
import { MILLISECONDS_PER_DAY, MILLISECONDS_PER_MINUTE } from "../core/instant.js";
import { earliestFutureDeadline } from "./deadline-wake.js";
import {
  CountingManualClock,
  MOUNTED_AT,
  WakingSurface,
  renderWake,
} from "./deadline-wake.test-support.js";

/**
 * The real clock, instrumented the same way — and the reason this file drives two.
 *
 * `ManualClock` computes a due instant from the delay it is handed, so a delay no
 * platform timer could hold is a number it stores and honours. The defect this
 * subclass is here for lives one layer below that, in `setTimeout` itself, so the
 * clock under it has to be the one the console really runs on.
 */
class RecordingRealClock extends RealClock {
  public readonly armedDelaysMilliseconds: number[] = [];

  public override scheduleTimeout(callback: () => void, delayMs: number): ScheduledHandle {
    this.armedDelaysMilliseconds.push(delayMs);
    return super.scheduleTimeout(callback, delayMs);
  }
}

/** What `setTimeout` holds: anything above it fires on the next tick, not late. */
const MAXIMUM_TIMEOUT_MILLISECONDS = 2_147_483_647;

const SIXTY_DAYS_MILLISECONDS = 60 * MILLISECONDS_PER_DAY;

/**
 * The shape this hook shipped: one reading, taken at mount and never re-taken.
 *
 * Not a stand-in for the hook — it is the cell `useDeadlineWake` held, kept so the
 * claims about a replacement clock are shown to discriminate. It renders what the
 * hook would arm for, which is the whole of what the held instant decides.
 */
function MountLifetimeInstantSurface(props: {
  readonly clock: ConsoleClock;
  readonly deadlines: readonly number[];
}): React.JSX.Element {
  const [wokeAtMilliseconds] = useState(() => props.clock.now());
  const dueAtMilliseconds = earliestFutureDeadline(props.deadlines, wokeAtMilliseconds);
  return <output>{String(dueAtMilliseconds ?? NOTHING_OUTSTANDING)}</output>;
}

/** What a surface with no deadline still ahead of its instant has to arm for. */
const NOTHING_OUTSTANDING = "nothing outstanding";

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

describe("useDeadlineWake — a deadline further out than a timer can hold", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("arms no step longer than the platform ceiling, on the clock the console runs on", () => {
    // The defect as arithmetic, driven against the REAL clock: without the clamp the
    // one armed delay is the whole sixty days, which `setTimeout` truncates into a
    // signed 32-bit integer and fires on the next tick — publishing an instant two
    // months ahead and putting every row in the list past its deadline at mount.
    vi.useFakeTimers();
    vi.setSystemTime(MOUNTED_AT);
    const clock = new RecordingRealClock();
    renderWake(clock, [MOUNTED_AT + SIXTY_DAYS_MILLISECONDS]);
    expect(SIXTY_DAYS_MILLISECONDS).toBeGreaterThan(MAXIMUM_TIMEOUT_MILLISECONDS);
    expect(clock.armedDelaysMilliseconds).toStrictEqual([MAXIMUM_TIMEOUT_MILLISECONDS]);
  });

  it("negative control: a deadline inside the ceiling is armed for in full", () => {
    // Without this the clamp above would also be satisfied by an implementation that
    // chopped every deadline into ceiling-sized steps, which would re-arm a timer
    // for a wake-up that is a minute away.
    vi.useFakeTimers();
    vi.setSystemTime(MOUNTED_AT);
    const clock = new RecordingRealClock();
    renderWake(clock, [MOUNTED_AT + MILLISECONDS_PER_MINUTE]);
    expect(clock.armedDelaysMilliseconds).toStrictEqual([MILLISECONDS_PER_MINUTE]);
  });

  it("walks the deadline in ceiling-sized steps and wakes only when it is reached", () => {
    // The second half of the fix: clamping alone would arm one step and stop, so the
    // wake-up would simply never happen. Driven on the manual clock because it
    // honours the delay it is handed — which is what makes "the step ran and another
    // was armed" observable rather than a claim about `setTimeout`.
    const clock = new CountingManualClock(MOUNTED_AT);
    const deadline = MOUNTED_AT + SIXTY_DAYS_MILLISECONDS;
    const wake = renderWake(clock, [deadline]);
    expect(clock.armCount).toBe(1);

    act(() => {
      clock.advance(MAXIMUM_TIMEOUT_MILLISECONDS);
    });
    // The first step ran; the deadline is still ahead, so nothing was published and
    // the next step is armed.
    expect(wake.instant()).toBe(MOUNTED_AT);
    expect(clock.armCount).toBe(2);
    expect(clock.pendingCount).toBe(1);

    act(() => {
      clock.advance(SIXTY_DAYS_MILLISECONDS - MAXIMUM_TIMEOUT_MILLISECONDS);
    });
    expect(wake.instant()).toBe(deadline);
    // Nothing outstanding, so the chain stops — the same claim the near-deadline
    // case makes, held across a walk of several steps.
    expect(clock.pendingCount).toBe(0);
  });
});

describe("useDeadlineWake — the instant belongs to the clock it was read from", () => {
  /** A deadline the later clock is already past and the earlier one has not reached. */
  const DEADLINE_BETWEEN_THE_TWO_CLOCKS = MOUNTED_AT + 5_000;
  const LATER_START = MOUNTED_AT + 10_000;

  it("re-reads the instant from a replacement clock and arms for it", () => {
    // A mounted consumer handed another clock — a fixture scenario switching to one
    // that starts earlier is the ordinary way. The reading taken from the clock it no
    // longer has measures nothing on this one, so holding it put every deadline
    // behind the surface at once: nothing armed, every row expired, until unmount.
    const laterClock = new CountingManualClock(LATER_START);
    const earlierClock = new CountingManualClock(MOUNTED_AT);
    const wake = renderWake(laterClock, [DEADLINE_BETWEEN_THE_TWO_CLOCKS]);
    expect(wake.instant()).toBe(LATER_START);
    expect(laterClock.armCount).toBe(0);

    act(() => {
      wake.setClock(earlierClock);
    });

    expect(wake.instant()).toBe(MOUNTED_AT);
    expect(earlierClock.armCount).toBe(1);
    expect(earlierClock.pendingCount).toBe(1);
    act(() => {
      earlierClock.advance(5_000);
    });
    expect(wake.instant()).toBe(DEADLINE_BETWEEN_THE_TWO_CLOCKS);
  });

  it("negative control: the cell this replaced goes on measuring against the old clock", () => {
    // The identical script against the shape that shipped: its instant is the later
    // clock's, so the deadline the hook above arms for reads as already crossed and
    // nothing is left to wake up for.
    const laterClock = new CountingManualClock(LATER_START);
    const earlierClock = new CountingManualClock(MOUNTED_AT);
    const view = render(
      <MountLifetimeInstantSurface
        clock={laterClock}
        deadlines={[DEADLINE_BETWEEN_THE_TWO_CLOCKS]}
      />,
    );

    view.rerender(
      <MountLifetimeInstantSurface
        clock={earlierClock}
        deadlines={[DEADLINE_BETWEEN_THE_TWO_CLOCKS]}
      />,
    );

    expect(view.container.textContent).toBe(NOTHING_OUTSTANDING);
  });

  it("negative control: a re-render on the SAME clock does not re-read it", () => {
    // Without this, "re-read from the replacement" would also be satisfied by a hook
    // that read the clock on every pass — a render whose output depends on when it
    // ran, which is the impurity the frozen clock exists to remove.
    const clock = new CountingManualClock(MOUNTED_AT);
    const wake = renderWake(clock, [DEADLINE_BETWEEN_THE_TWO_CLOCKS]);
    act(() => {
      clock.advance(2_000);
    });

    act(() => {
      wake.setDeadlines([DEADLINE_BETWEEN_THE_TWO_CLOCKS]);
    });

    expect(wake.instant()).toBe(MOUNTED_AT);
  });

  it("negative control: a replacement clock already past the deadline arms nothing", () => {
    // The other direction, so the claim is about reading the replacement rather than
    // about arming on every clock change — and the timer on the clock the consumer
    // left is cancelled rather than carried.
    const earlierClock = new CountingManualClock(MOUNTED_AT);
    const laterClock = new CountingManualClock(LATER_START);
    const wake = renderWake(earlierClock, [DEADLINE_BETWEEN_THE_TWO_CLOCKS]);
    expect(earlierClock.armCount).toBe(1);

    act(() => {
      wake.setClock(laterClock);
    });

    expect(wake.instant()).toBe(LATER_START);
    expect(laterClock.armCount).toBe(0);
    expect(laterClock.pendingCount).toBe(0);
    expect(earlierClock.pendingCount).toBe(0);
  });
});
