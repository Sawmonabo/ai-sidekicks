// The clock and the probe component every deadline-wake suite drives.
//
// `useDeadlineWake.test.tsx` and `useDeadlineWake.catch-up.test.ts` share them, so two copies
// of the counting clock or the render harness cannot disagree about what "armed" means.

import { render } from "@testing-library/react";

import { ManualClock, type Clock, type ScheduledHandle } from "@renderer/lib/clock.js";
import { useDeadlineWake } from "./useDeadlineWake.js";

/**
 * The real `ManualClock`, counting every timeout armed.
 *
 * A local fake would prove only the test's own arithmetic.
 */
export class CountingManualClock extends ManualClock {
  public armCount = 0;

  public override scheduleTimeout(callback: () => void, delayMs: number): ScheduledHandle {
    this.armCount += 1;
    return super.scheduleTimeout(callback, delayMs);
  }
}

/** The instant the clock reads when the probe mounts. */
export const MOUNTED_AT = 1_000;

/** What a mounted probe exposes: the rendered instant, and setters for its inputs. */
export interface MountedWake {
  readonly instant: () => number;
  readonly setDeadlines: (next: readonly number[]) => void;
  readonly setClock: (next: Clock) => void;
}

/** Renders the instant `useDeadlineWake` returns for a clock and its deadlines. */
export function DeadlineWakeProbe(props: {
  readonly clock: Clock;
  readonly deadlines: readonly number[];
}): React.JSX.Element {
  const nowMilliseconds = useDeadlineWake(props.clock, props.deadlines);
  return <output>{String(nowMilliseconds)}</output>;
}

/** Mount the probe; the handle reads the instant and swaps the deadlines or the clock. */
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
