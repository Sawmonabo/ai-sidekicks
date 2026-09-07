// Frames a scenario declares against the frozen clock: which are due, and one walk
// that releases them no faster than the clock reaches them.
//
// WHY IT IS HERE AND NOT IN `scenarios/`. A scenario is DATA — `scenario.ts` says so
// — and the one thing a scenario module cannot reach is the engine: a computed reply
// is handed the request and nothing else, so a script has no clock to schedule
// against and a stream it built would drain as fast as its consumer pulled. The
// fixture is built WITH the engine in hand, which is why every frame reading in this
// directory lives on this side of the seam.
//
// TWO READINGS OVER ONE RULE. Frames are declared in tick order, so what has fallen
// due at an elapsed tick is the CONTIGUOUS PREFIX whose ticks the clock has reached:
// {@link framesDueThrough} answers which ones a walk has not released yet, and
// {@link frameDueAt} — hoisted out of `fixture-shell-status.ts`, which declared it
// privately until the provider-import feed needed the same rule — answers which
// single one is current. The second is the last element of the first, stated that way
// rather than as a second loop, because two loops over one rule are two rules the day
// either is edited.
//
// `fixture-runtime-node-roster.ts` KEEPS ITS OWN and is not folded in here. Its reader
// is deliberately order-independent — a `reduce` that takes the latest due `atMs`
// whatever position it sits at — and its own comment argues for that against the
// prefix rule this module states. Two rules, two homes; folding them would silently
// give one consumer the other's answer for an unsorted script.
//
// AND THE WALK PARKS, IT NEVER TIMES. The frozen clock moves only when a caller
// advances the engine, so waiting for a tick means parking on the engine's own held
// -reply queue — the same queue a scripted latency parks on — and being released when
// the clock passes the tick. There is no timer here, no interval, and no second
// scheduler: an engine that is torn down while a walk is parked releases it as
// `abandoned`, and the walk ends rather than hanging for the life of the window.

import type { GrowthStream } from "../growth-port/growth-outcome.js";
import type { ScenarioEngine } from "../scenario-runtime/index.js";

/** What every scenario frame carries: the tick, measured from scenario start. */
export interface ScenarioDueFrame {
  readonly atMs: number;
}

/**
 * The frames from `fromIndex` onwards that have fallen due at `elapsedMs`.
 *
 * Stops at the first frame that is not yet due rather than filtering, which is the
 * engine's own rule for a due beat prefix: a filter picks up a later entry that
 * happens to be due while leaving an earlier one in front of it undelivered, and a
 * caller advancing an index past that gap skips the entry it stepped over.
 */
export function framesDueThrough<TFrame extends ScenarioDueFrame>(
  frames: readonly TFrame[],
  fromIndex: number,
  elapsedMs: number,
): readonly TFrame[] {
  const remaining = frames.slice(Math.max(0, fromIndex));
  const firstNotYetDue = remaining.findIndex((frame) => frame.atMs > elapsedMs);
  return firstNotYetDue === -1 ? remaining : remaining.slice(0, firstNotYetDue);
}

/**
 * The frame current at an elapsed tick, or `undefined` before the first is due.
 *
 * A scenario whose first frame lands at tick 200 has an UNANSWERED reading until
 * then rather than a fabricated one — which is the whole reason the absent arm is a
 * value a caller has to handle rather than a default this module invents.
 */
export function frameDueAt<TFrame extends ScenarioDueFrame>(
  frames: readonly TFrame[],
  elapsedMs: number,
): TFrame | undefined {
  return framesDueThrough(frames, 0, elapsedMs).at(-1);
}

/**
 * Release a scripted feed's values no faster than the frozen clock reaches their
 * ticks.
 *
 * THE VALUES ARE THE SCRIPT'S AND THE SCHEDULE IS THE FIXTURE'S, which is the split
 * this whole module exists for. `source` is whatever the scenario answered the
 * subscription with — it knows the frames and cannot pace them — and `dueFrames`
 * carries the tick each of those values falls due at, positionally. The two come from
 * ONE declaration in the scenario module, so they cannot disagree about how many
 * frames there are; a value past the last declared tick is released as it arrives,
 * because a walk that parked on a tick nobody declared would never release it at all.
 *
 * `close()` is terminal and reaches both halves: the walk stops at the frame it has
 * got to and the source is closed under it, so a consumer that unmounts mid-feed
 * leaves no producer running and receives no later frame.
 */
export function paceGrowthStreamOnScenarioClock<TValue>(
  engine: ScenarioEngine,
  source: GrowthStream<TValue>,
  dueFrames: readonly ScenarioDueFrame[],
): GrowthStream<TValue> {
  return new ClockPacedGrowthStream(engine, source, dueFrames);
}

/**
 * One consumer's paced view of a scripted feed.
 *
 * A class rather than a bare async generator because it owns two things a generator
 * cannot: the closed flag both the walk and `close()` read, and the wake that lets a
 * cancellation end a walk parked on a tick the clock has not reached. The shell
 * feed's own stream next door is the same shape for the same reason.
 */
class ClockPacedGrowthStream<TValue> implements GrowthStream<TValue> {
  readonly #engine: ScenarioEngine;
  readonly #source: GrowthStream<TValue>;
  readonly #dueFrames: readonly ScenarioDueFrame[];
  #releasedCount = 0;
  #closed = false;
  #closeWake: (() => void) | undefined;

  public constructor(
    engine: ScenarioEngine,
    source: GrowthStream<TValue>,
    dueFrames: readonly ScenarioDueFrame[],
  ) {
    this.#engine = engine;
    this.#source = source;
    this.#dueFrames = dueFrames;
  }

  public get events(): AsyncIterable<TValue> {
    return this.#iterate();
  }

  /** Terminal. Ends the walk, wakes it if it is parked, and closes the source. */
  public close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#closeWake?.();
    this.#closeWake = undefined;
    this.#source.close();
  }

  async *#iterate(): AsyncGenerator<TValue> {
    for await (const value of this.#source.events) {
      if (this.#closed || !(await this.#waitUntilDue())) {
        return;
      }
      this.#releasedCount += 1;
      yield value;
    }
  }

  /**
   * Park until the next frame's tick has been reached. `false` means give up.
   *
   * A walk gives up on exactly two things and neither is a timeout: the consumer
   * closed the stream, or the engine was torn down under it and released the park as
   * `abandoned`. Both end the iteration, which reaches the consumer as a feed that
   * finished — the honest reading, since no later frame is coming.
   *
   * A close RACES the park rather than cancelling it, because the engine's queue
   * takes no cancellation. What outlives a cancelled walk is one parked entry that
   * settles into a resolved race nobody reads, released by the next advance or by
   * teardown: it counts against `pendingReplyCount` until then and holds no surface,
   * where waiting for it would have left the consumer's walk running instead.
   */
  async #waitUntilDue(): Promise<boolean> {
    while (
      framesDueThrough(this.#dueFrames, this.#releasedCount, this.#engine.progress.elapsedMs)
        .length === 0
    ) {
      const next = this.#dueFrames[this.#releasedCount];
      if (next === undefined) {
        // Past the last declared tick: nothing says when this value is due, so it is
        // due now. Parking here would hold a frame the scenario never scheduled.
        return true;
      }
      const closed = new Promise<"closed">((resolve) => {
        this.#closeWake = () => {
          resolve("closed");
        };
      });
      const outcome = await Promise.race([
        this.#engine.holdReply(next.atMs - this.#engine.progress.elapsedMs),
        closed,
      ]);
      this.#closeWake = undefined;
      if (outcome !== "due") {
        return false;
      }
    }
    return !this.#closed;
  }
}
