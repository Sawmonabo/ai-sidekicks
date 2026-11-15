import { useEffect, useState } from "react";

import type { Clock, ScheduledHandle } from "#renderer/lib/clock.js";
import { useLatestRef } from "#renderer/hooks/useLatestRef.js";
import { MOTION_DURATIONS_MS } from "#renderer/styles/motion.js";

/**
 * Whether a note that stays `durationMs` while nothing holds it is fading out. While `isHeld` its
 * time stops, and it goes on with what it had left; once the time has run the note fades for the
 * settle motion's length and `onGone` is called. One timer is armed at a time, and none while held.
 */
export function useIsNoteFading(
  clock: Clock,
  durationMs: number,
  isHeld: boolean,
  onGone: () => void,
): boolean {
  const [isFading, setIsFading] = useState(false);
  const [countdown] = useState(() => new Countdown(clock, durationMs));
  const onGoneRef = useLatestRef(onGone);
  useEffect(() => {
    if (isFading) {
      const handle = clock.scheduleTimeout(() => {
        onGoneRef.current();
      }, MOTION_DURATIONS_MS["motion-settle"]);
      return () => {
        clock.cancel(handle);
      };
    }
    if (isHeld) {
      return undefined;
    }
    countdown.run(() => {
      setIsFading(true);
    });
    return () => {
      countdown.hold();
    };
  }, [clock, countdown, isHeld, isFading, onGoneRef]);
  return isFading;
}

/** The time a note has left, run and held on its clock. */
class Countdown {
  readonly #clock: Clock;
  #remainingMs: number;
  #runningSince = 0;
  #handle: ScheduledHandle | undefined = undefined;

  public constructor(clock: Clock, durationMs: number) {
    this.#clock = clock;
    this.#remainingMs = durationMs;
  }

  /** Runs the time left and calls `onRunOut` once it has run; nothing while it already runs. */
  public run(onRunOut: () => void): void {
    if (this.#handle !== undefined) {
      return;
    }
    this.#runningSince = this.#clock.now();
    this.#handle = this.#clock.scheduleTimeout(() => {
      this.#handle = undefined;
      this.#remainingMs = 0;
      onRunOut();
    }, this.#remainingMs);
  }

  /** Stops the time, keeping what is left; nothing while it is not running. */
  public hold(): void {
    if (this.#handle === undefined) {
      return;
    }
    this.#clock.cancel(this.#handle);
    this.#handle = undefined;
    this.#remainingMs = Math.max(0, this.#remainingMs - (this.#clock.now() - this.#runningSince));
  }
}
