import { useEffect, useState } from "react";

import { MILLISECONDS_PER_SECOND } from "@renderer/lib/instant.js";
import { dayClockChangesAt } from "@renderer/lib/wire/figures.js";
import { useClock } from "@renderer/services/platform/hooks/useClock.js";
import { partOfDayChangesAt } from "../runs/part-of-day.js";

/** What a view draws against the clock, which decides when its instant must move. */
export interface RunTimesDrawn {
  /** The records drawn; a new one, by identity, reads the clock again. */
  readonly drawn: readonly unknown[];
  /** A going run's time so far is drawn, which moves every second. */
  readonly isTicking: boolean;
  /** A figure names a day, as `Yesterday 7:48 PM` does, which moves at midnight. */
  readonly namesDays: boolean;
  /** `Nothing waiting · you answered 4 runs this morning` names the part of the day. */
  readonly isPartOfDayShown: boolean;
}

/**
 * The instant the Runs tab and a run's page draw their times against, woken only when one of
 * them would read differently: once a second, on the clock's whole second, while a run's time so
 * far is drawn — every going row moves then, rather than each waking the view at its own offset —
 * at local midnight while a figure names a day, and when the part of the day turns over while
 * `Nothing waiting` names it. One timer at most; with nothing drawn against the clock, none.
 */
export function useRunTimesNow(times: RunTimesDrawn): number {
  const { drawn, isTicking, namesDays, isPartOfDayShown } = times;
  const clock = useClock();
  const [reading, setReading] = useState(() => ({ drawn, instant: clock.now() }));
  // New records read the clock again, so a run that started while nothing was ticking is not
  // counted from an instant that went stale while no timer was armed. React's state adjusted in
  // render: this pass is thrown away and rendered again with the new reading.
  if (
    reading.drawn.length !== drawn.length ||
    reading.drawn.some((record, index) => record !== drawn[index])
  ) {
    setReading({ drawn, instant: Math.max(reading.instant, clock.now()) });
  }
  const { instant } = reading;
  const wakeAt = Math.min(
    isTicking ? nextSecondMark(instant) : Number.POSITIVE_INFINITY,
    namesDays ? dayClockChangesAt(instant) : Number.POSITIVE_INFINITY,
    isPartOfDayShown ? partOfDayChangesAt(instant) : Number.POSITIVE_INFINITY,
  );
  useEffect(() => {
    if (wakeAt === Number.POSITIVE_INFINITY) {
      return undefined;
    }
    const handle = clock.scheduleTimeout(
      () => {
        // A whole second, so every going row moves on the same one; the last one passed, so a
        // wake-up that arrives late, after the host slept, catches up in one step.
        const crossed = Math.max(wakeAt, wholeSecondAtOrBefore(clock.now()));
        setReading((current) => ({ ...current, instant: Math.max(current.instant, crossed) }));
      },
      Math.max(0, wakeAt - clock.now()),
    );
    return () => {
      clock.cancel(handle);
    };
  }, [clock, wakeAt]);
  return instant;
}

/** The clock's next whole second after `fromMilliseconds`. */
function nextSecondMark(fromMilliseconds: number): number {
  return wholeSecondAtOrBefore(fromMilliseconds) + MILLISECONDS_PER_SECOND;
}

function wholeSecondAtOrBefore(epochMilliseconds: number): number {
  return Math.floor(epochMilliseconds / MILLISECONDS_PER_SECOND) * MILLISECONDS_PER_SECOND;
}
