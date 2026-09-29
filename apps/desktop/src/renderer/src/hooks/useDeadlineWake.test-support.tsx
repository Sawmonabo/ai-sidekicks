// The clock and the probe component every deadline-wake suite drives, in one place.
//
// Two suites read this module — the timer-and-dependency claims in
// `store/subject-scoped/deadline-wake.test.tsx` and the late-wake-up catch-up in
// `store/subject-scoped/deadline-wake.catch-up.test.tsx` — and a second copy of
// either the counting clock or the render harness would be two harnesses that could
// disagree about what "armed" means while both stayed green.

import { render } from "@testing-library/react";

import { ManualClock, type Clock, type ScheduledHandle } from "@renderer/lib/clock.js";
import { useDeadlineWake } from "./useDeadlineWake.js";

/**
 * The real clock, instrumented — not a stand-in for it.
 *
 * A local fake would prove the test's own arithmetic; this subclasses the module the
 * console actually runs on and counts the one call the claims are about.
 */
export class CountingManualClock extends ManualClock {
  public armCount = 0;

  public override scheduleTimeout(callback: () => void, delayMs: number): ScheduledHandle {
    this.armCount += 1;
    return super.scheduleTimeout(callback, delayMs);
  }
}

export const MOUNTED_AT = 1_000;

export interface MountedWake {
  readonly instant: () => number;
  readonly setDeadlines: (next: readonly number[]) => void;
  readonly setClock: (next: Clock) => void;
}

export function DeadlineWakeProbe(props: {
  readonly clock: Clock;
  readonly deadlines: readonly number[];
}): React.JSX.Element {
  const nowMilliseconds = useDeadlineWake(props.clock, props.deadlines);
  return <output>{String(nowMilliseconds)}</output>;
}

export function renderDeadlineWake(clock: Clock, deadlines: readonly number[]): MountedWake {
  const { container, rerender } = render(<DeadlineWakeProbe clock={clock} deadlines={deadlines} />);
  const showing = { clock, deadlines };
  const show = (): void => {
    rerender(<DeadlineWakeProbe clock={showing.clock} deadlines={showing.deadlines} />);
  };
  return {
    instant: () => Number(container.textContent),
    setDeadlines: (next) => {
      showing.deadlines = next;
      show();
    },
    setClock: (next) => {
      showing.clock = next;
      show();
    },
  };
}
