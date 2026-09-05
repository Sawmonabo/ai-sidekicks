// One clock identity for a mount, over a clock the window replaces underneath it.
//
// THE TWO REQUIREMENTS ARE IN TENSION, WHICH IS WHY THIS IS AN OBJECT RATHER THAN A
// CALL. A component that hands a clock to something it renders needs one IDENTITY for
// its whole life: `LiveAnnouncerProvider` pins the clock it is given in `useState` and
// re-mints its announcer when that pin moves, so a clock with a fresh identity per
// render would rebuild the announcer once a render. But the window's clock is not a
// constant either — `SidekicksBridgeProvider` replaces its resolution IN PLACE, with
// no remount of the tree below it, and the replacement carries a different scenario
// engine and therefore a different frozen clock. A pinned reading is then a retired
// engine's time, which is the exact conflation the fixture rule forbids: "the fixture
// clock is the only clock the renderer reads in fixture mode" names the CURRENT
// fixture, not whichever one happened to be live at mount.
//
// So the identity is this object and the readings are the window's. Every method
// forwards to whatever the window's clock is when the method RUNS.
//
// AND `cancel` ROUTES TO THE CLOCK THAT ARMED THE WORK, NEVER TO THE CURRENT ONE.
// `ScheduledHandle` is a number each clock mints for itself, so two clocks hand out
// the same numbers for unrelated work; forwarding a cancel to whichever clock is
// current would cancel a stranger's timer and leave the caller's armed. So this mints
// its own handle sequence and remembers which clock is behind each one. The announcer
// arms a hold deadline and cancels it, across exactly the replacement this exists for,
// and that pairing has to survive it.
//
// WORK STAYS WITH THE CLOCK THAT ARMED IT, and is deliberately not re-armed on the
// replacement. Re-arming would fire twice on the real clock, where the original
// timeout is still coming; it would also invent a deadline the caller never asked
// for. A fixture engine that is disposed while work is armed on its frozen clock
// strands that work — which is the retired engine's own end, and a fact about
// disposing an engine rather than about this seam.

import type { ConsoleClock, ScheduledHandle } from "./clock.js";

/** Which clock is behind one handed-out handle, and what that clock called the work. */
interface ArmedElsewhere {
  readonly clock: ConsoleClock;
  readonly handle: ScheduledHandle;
}

/**
 * A stable `ConsoleClock` over a clock the caller may replace.
 *
 * Constructed once per mount and handed the window's CURRENT clock through
 * {@link holdClock} whenever that changes, rather than closing over a resolver: the
 * caller is a React hook, and a hook writes what it has from the layout phase for the
 * reason the resource substrate next door states — every layout effect for a commit
 * runs before any passive effect for it, so the clock this holds when a consumer's
 * effect reads it is the one that commit resolved.
 */
export class ForwardingConsoleClock implements ConsoleClock {
  #clock: ConsoleClock;
  readonly #armed = new Map<ScheduledHandle, ArmedElsewhere>();
  #nextHandle: ScheduledHandle = 1;

  public constructor(clock: ConsoleClock) {
    this.#clock = clock;
  }

  /**
   * Take the window's clock as it is now, and disturb nothing already armed.
   *
   * Work armed on the previous clock keeps its route home, because the map holds the
   * clock rather than a lookup performed at cancel time.
   */
  public holdClock(clock: ConsoleClock): void {
    this.#clock = clock;
  }

  /** The current clock's reading. Monotonic within one clock, and this is two. */
  public now(): number {
    return this.#clock.now();
  }

  /** Arm on the current clock, and remember which one that was. */
  public scheduleFrame(callback: () => void): ScheduledHandle {
    const clock = this.#clock;
    return this.#arm(clock, (settle) => clock.scheduleFrame(settle), callback);
  }

  /** Arm on the current clock, and remember which one that was. */
  public scheduleTimeout(callback: () => void, delayMs: number): ScheduledHandle {
    const clock = this.#clock;
    return this.#arm(clock, (settle) => clock.scheduleTimeout(settle, delayMs), callback);
  }

  /**
   * Cancel through the clock that armed the work. Idempotent, as the seam requires.
   *
   * A handle this never minted — a stale one, or one a caller read off a clock
   * directly — is not an error and cancels nothing, which is what makes double
   * cancellation and cancellation after firing both harmless.
   */
  public cancel(handle: ScheduledHandle): void {
    const armed = this.#armed.get(handle);
    if (armed === undefined) {
      return;
    }
    this.#armed.delete(handle);
    armed.clock.cancel(armed.handle);
  }

  /**
   * Mint this seam's own handle for work the underlying clock arms.
   *
   * The entry is dropped BEFORE the caller's callback runs, so a callback that arms
   * more work cannot be cancelled through the handle of the work that scheduled it,
   * and a fired handle leaves nothing behind to grow the map.
   */
  #arm(
    clock: ConsoleClock,
    armOn: (settle: () => void) => ScheduledHandle,
    callback: () => void,
  ): ScheduledHandle {
    const handle = this.#nextHandle;
    this.#nextHandle += 1;
    const underlying = armOn(() => {
      this.#armed.delete(handle);
      callback();
    });
    this.#armed.set(handle, { clock, handle: underlying });
    return handle;
  }
}
