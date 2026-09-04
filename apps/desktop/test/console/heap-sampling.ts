// The console tiers' one way to force a collection and read retained bytes.
//
// Two tiers ask heap questions of in-process code — the budget tier asks what one
// terminal instance retains, the endurance tier asks whether a churn of them
// leaves that number where it started — and both answers are only as good as the
// collection that precedes them. Written once here because two copies of a
// retry-until-stable loop drift into two different definitions of "settled", and
// the tier whose loop is weaker then reports the smaller leak.
//
// WHY `arrayBuffers` IS PART OF THE READING AND NOT A DETAIL
//
// `process.memoryUsage().heapUsed` counts the V8 heap and NOT the backing stores
// of typed arrays, which V8 allocates outside it. `@xterm/xterm` stores its buffer
// as `Uint32Array`s — twelve bytes per cell, eagerly, regardless of content — so a
// ten-thousand-line scrollback is almost entirely OUTSIDE `heapUsed`. A gate that
// read `heapUsed` alone would report a terminal at a few per cent of its budget
// and keep reporting it with the buffer arbitrarily large, which is the exact
// shape of the stand-in gate `heap-budget.test.ts` exists to keep retired. So the
// reading is the sum, and `retainedBytes` is the only figure a caller compares.
//
// WHY GC IS REACHED THROUGH `v8.setFlagsFromString` RATHER THAN A RUNNER FLAG
//
// `globalThis.gc` exists only under `--expose-gc`, which a Vitest project cannot
// add to the worker it did not spawn. Enabling the flag at runtime and compiling
// the accessor through `vm.runInNewContext` is the documented way to reach it from
// inside a process that was started without it, and it keeps the capability local
// to this module: no tier's config carries a flag whose absence would silently
// turn its assertions into noise. A caller that gets `undefined` is told so and
// skips rather than measuring garbage.
//
// WHY THE MEMO IS OWNED BY AN OBJECT AND NOT BY THE MODULE
//
// The resolution has to be memoised — `setFlagsFromString` mutates process-wide
// state, and calling it per sample would flip the flag hundreds of times in a run.
// Held in module-level variables that memo became process-global and
// order-dependent: one early failed resolution permanently hid a `globalThis.gc`
// installed afterwards, and the tier that ran second reported "no collector" for a
// reason belonging to the tier that ran first. The memo is a private field, so a
// harness that resolves nothing cannot narrow one built beside it.

import v8 from "node:v8";
import vm from "node:vm";
import process from "node:process";

/** One reading, with the two halves kept so a caller can report which grew. */
export interface HeapSample {
  readonly heapUsedBytes: number;
  readonly arrayBufferBytes: number;
  /** What a budget compares against: the V8 heap plus the backing stores. */
  readonly retainedBytes: number;
}

/**
 * Reach the runtime's collector, or answer `undefined` on one that will not give
 * it up. Pure with respect to this module: everything it remembers is the caller's.
 */
function resolveExposedCollector(): (() => void) | undefined {
  const existing = (globalThis as { gc?: () => void }).gc;
  if (typeof existing === "function") {
    return existing;
  }
  try {
    v8.setFlagsFromString("--expose-gc");
    const compiled: unknown = vm.runInNewContext("gc");
    return typeof compiled === "function" ? (compiled as () => void) : undefined;
  } catch {
    return undefined;
  } finally {
    // Left off for everything downstream of this call: the flag is needed to
    // COMPILE the accessor, not to hold it, and leaving it on changes how the
    // rest of the run is optimised.
    v8.setFlagsFromString("--no-expose-gc");
  }
}

/**
 * One owner of one resolution attempt.
 *
 * The attempt runs at most once per instance — which is what keeps the
 * process-wide flag mutation to one flip per collector however many samples are
 * taken — and its outcome, including a failure, belongs to that instance alone.
 */
export class HeapCollector {
  readonly #resolveCollector: () => (() => void) | undefined;
  #collect: (() => void) | undefined;
  #hasResolved = false;

  /**
   * @param resolveCollector how the collector is reached. The runtime's own way by
   *   default; a caller supplies its own only to drive a runtime this process
   *   cannot produce on demand — one that refuses, and one that hands over a
   *   collector installed later.
   */
  public constructor(resolveCollector: () => (() => void) | undefined = resolveExposedCollector) {
    this.#resolveCollector = resolveCollector;
  }

  /** Whether a collection can be forced at all. A caller that gets `false` skips. */
  public available(): boolean {
    return this.#resolved() !== undefined;
  }

  /** Force a collection, or do nothing on a runtime that gives no collector. */
  public collect(): void {
    this.#resolved()?.();
  }

  #resolved(): (() => void) | undefined {
    if (!this.#hasResolved) {
      this.#hasResolved = true;
      this.#collect = this.#resolveCollector();
    }
    return this.#collect;
  }
}

/** How many collect-and-settle rounds a sample runs. */
const SETTLE_ROUNDS = 4;

/**
 * A collector and the settling loop that makes its readings comparable.
 *
 * Constructed by the tier that measures, beside its own harness. Not a module
 * singleton: a tier's readings are its own, and a shared one would make the first
 * tier to resolve decide what every later one can measure.
 */
export class HeapSampler {
  readonly #collector: HeapCollector;

  public constructor(collector: HeapCollector = new HeapCollector()) {
    this.#collector = collector;
  }

  /**
   * Whether a heap reading is admissible here. A reading with no collection behind
   * it is noise, and a tier that is green because it measured noise is worse than
   * one that is loud about the gap.
   */
  public get isCollectorAvailable(): boolean {
    return this.#collector.available();
  }

  /**
   * Collect, let pending finalisation run, and read.
   *
   * The rounds are what make the reading comparable: one collection reclaims what
   * is unreachable at that instant, and a disposed emulator's listeners are
   * released across a microtask boundary rather than inside the call that disposed
   * it. Four rounds with a macrotask between them is the smallest loop that gave
   * the same number twice on this code; fewer left the second reading below the
   * first.
   */
  public async sample(): Promise<HeapSample> {
    for (let round = 0; round < SETTLE_ROUNDS; round += 1) {
      this.#collector.collect();
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }
    this.#collector.collect();
    const usage = process.memoryUsage();
    return {
      heapUsedBytes: usage.heapUsed,
      arrayBufferBytes: usage.arrayBuffers,
      retainedBytes: usage.heapUsed + usage.arrayBuffers,
    };
  }
}

/** The growth between two samples, floored at zero — a shrink is not a leak. */
export function retainedGrowthBytes(before: HeapSample, after: HeapSample): number {
  return Math.max(0, after.retainedBytes - before.retainedBytes);
}
