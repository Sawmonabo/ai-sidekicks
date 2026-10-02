// The endurance tier's one way to force a collection in-process and read retained bytes.
// Written once so two copies of a retry-until-stable loop cannot drift into two definitions of
// "settled", with the weaker loop reporting the smaller leak.
//
// `arrayBuffers` is part of the reading: `heapUsed` excludes typed-array backing stores, and
// `@xterm/xterm` keeps its buffer in `Uint32Array`s (twelve bytes per cell, eagerly), so a large
// scrollback sits almost entirely outside it. `retainedBytes` is the sum and the only figure a
// caller compares.
//
// The collector is reached through `v8.setFlagsFromString` because `globalThis.gc` exists only
// under `--expose-gc`, which a Vitest project cannot add to a worker it did not spawn. This
// keeps the capability local rather than putting a flag in a tier's config whose absence would
// turn its assertions into noise. A caller that gets `undefined` is told so and skips.
//
// The resolution is memoized because `setFlagsFromString` mutates process-wide state and would
// flip the flag every sample. The memo is a private field, not a module variable, so one failed
// resolution cannot hide a `globalThis.gc` installed later or narrow another instance.

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
 * Reaches the runtime's collector, or answers `undefined` on one that will not give it up.
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
  } catch (error: unknown) {
    // A runtime that ignored the flag has no `gc` to look up; any other failure is raised.
    if (error instanceof ReferenceError) {
      return undefined;
    }
    throw error;
  } finally {
    // Left off downstream: the flag is needed to compile the accessor, not to hold it, and
    // leaving it on changes how the rest of the run is optimized.
    v8.setFlagsFromString("--no-expose-gc");
  }
}

/**
 * One owner of one resolution attempt: it runs at most once per instance, and its outcome,
 * including a failure, belongs to that instance alone.
 */
class HeapCollector {
  #collect: (() => void) | undefined;
  #hasResolved = false;

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
      this.#collect = resolveExposedCollector();
    }
    return this.#collect;
  }
}

/**
 * How many collect-and-settle rounds a sample runs.
 *
 * Exported because the renderer probe in `heap-instrument.ts` collects over CDP with the same
 * round count; the loops differ but the count must not, or the probe reads a floor this process
 * no longer reaches.
 */
export const SETTLE_ROUNDS = 4;

/**
 * A collector and the settling loop that makes its readings comparable.
 *
 * Built by the case that measures rather than a singleton, so the first tier to resolve does
 * not decide what later ones can measure.
 */
export class HeapSampler {
  readonly #collector: HeapCollector = new HeapCollector();

  /**
   * Whether a heap reading is admissible here: a reading with no collection behind it is noise,
   * and a tier green on noise is worse than one loud about the gap.
   */
  public get isCollectorAvailable(): boolean {
    return this.#collector.available();
  }

  /**
   * Collects, lets pending finalization run, and reads.
   *
   * One collection reclaims only what is unreachable at that instant, and a disposed emulator's
   * listeners are released across a microtask boundary. Four rounds with a macrotask between
   * them was the smallest loop that gave the same number twice on this code.
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
