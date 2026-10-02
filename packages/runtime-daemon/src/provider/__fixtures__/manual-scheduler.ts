// A timer scheduler whose timers fire only when a test says so, for code that takes an injected
// one-shot scheduler (`(callback, delayMs) => cancel`).

/** One armed timer and what has happened to it. */
interface ManualTimer {
  readonly callback: () => void;
  readonly delayMs: number;
  canceled: boolean;
  fired: boolean;
}

/** The scheduler a test injects, and the reads and triggers it drives the timers with. */
export interface ManualScheduler {
  readonly schedule: (callback: () => void, delayMs: number) => () => void;
  /** Fires every timer neither fired nor canceled; stands in for every bound elapsing. */
  fireAll(): void;
  /**
   * Fires only the pending timers armed at `delayMs` and returns how many ran, for asserting one
   * deadline while others (a transport request deadline, say) stay armed.
   */
  fireDelay(delayMs: number): number;
  /** Every delay ever armed, in arming order, whatever became of its timer. */
  scheduledDelays(): readonly number[];
  /** The delays of timers neither fired nor canceled. */
  pendingDelays(): readonly number[];
  pendingCount(): number;
  /**
   * The delays that actually ran. A settled wait and an expired one both leave no pending timer,
   * so "settled without any timer firing" needs this record.
   */
  firedDelays(): readonly number[];
  /** How many timers were canceled through their canceler, fired or not. */
  canceledCount(): number;
}

/** A {@link ManualScheduler} with no timers armed. */
export function makeManualScheduler(): ManualScheduler {
  const timers: ManualTimer[] = [];
  const fired: number[] = [];
  const fire = (timer: ManualTimer): void => {
    timer.fired = true;
    fired.push(timer.delayMs);
    timer.callback();
  };
  const isPending = (timer: ManualTimer): boolean => !timer.canceled && !timer.fired;
  return {
    schedule: (callback, delayMs) => {
      const timer: ManualTimer = { callback, delayMs, canceled: false, fired: false };
      timers.push(timer);
      return () => {
        timer.canceled = true;
      };
    },
    // Both walk the live list, so a timer a callback arms during the pass fires in that pass too.
    fireAll: () => {
      for (const timer of timers) {
        if (isPending(timer)) {
          fire(timer);
        }
      }
    },
    fireDelay: (delayMs) => {
      let firedHere = 0;
      for (const timer of timers) {
        if (isPending(timer) && timer.delayMs === delayMs) {
          fire(timer);
          firedHere += 1;
        }
      }
      return firedHere;
    },
    scheduledDelays: () => timers.map((timer) => timer.delayMs),
    pendingDelays: () => timers.filter(isPending).map((timer) => timer.delayMs),
    pendingCount: () => timers.filter(isPending).length,
    firedDelays: () => fired,
    canceledCount: () => timers.filter((timer) => timer.canceled).length,
  };
}
