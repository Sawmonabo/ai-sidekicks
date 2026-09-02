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
 * The collector, or `undefined` on a runtime that will not give one up.
 *
 * Resolved once and memoised, because `setFlagsFromString` mutates process-wide
 * state and calling it per sample would flip the flag hundreds of times in a run.
 */
let collectGarbage: (() => void) | undefined;
let hasResolvedCollector = false;

export function heapCollectorAvailable(): boolean {
  return resolveCollector() !== undefined;
}

function resolveCollector(): (() => void) | undefined {
  if (hasResolvedCollector) {
    return collectGarbage;
  }
  hasResolvedCollector = true;
  const existing = (globalThis as { gc?: () => void }).gc;
  if (typeof existing === "function") {
    collectGarbage = existing;
    return collectGarbage;
  }
  try {
    v8.setFlagsFromString("--expose-gc");
    const compiled: unknown = vm.runInNewContext("gc");
    collectGarbage = typeof compiled === "function" ? (compiled as () => void) : undefined;
  } catch {
    collectGarbage = undefined;
  } finally {
    // Left off for everything downstream of this call: the flag is needed to
    // COMPILE the accessor, not to hold it, and leaving it on changes how the
    // rest of the run is optimised.
    v8.setFlagsFromString("--no-expose-gc");
  }
  return collectGarbage;
}

/** How many collect-and-settle rounds a sample runs. */
const SETTLE_ROUNDS = 4;

/**
 * Collect, let pending finalisation run, and read.
 *
 * The rounds are what make the reading comparable: one `gc()` reclaims what is
 * unreachable at that instant, and a disposed emulator's listeners are released
 * across a microtask boundary rather than inside the call that disposed it. Four
 * rounds with a macrotask between them is the smallest loop that gave the same
 * number twice on this code; fewer left the second reading below the first.
 */
export async function sampleHeap(): Promise<HeapSample> {
  const collect = resolveCollector();
  for (let round = 0; round < SETTLE_ROUNDS; round += 1) {
    collect?.();
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  collect?.();
  const usage = process.memoryUsage();
  return {
    heapUsedBytes: usage.heapUsed,
    arrayBufferBytes: usage.arrayBuffers,
    retainedBytes: usage.heapUsed + usage.arrayBuffers,
  };
}

/** The growth between two samples, floored at zero — a shrink is not a leak. */
export function retainedGrowthBytes(before: HeapSample, after: HeapSample): number {
  return Math.max(0, after.retainedBytes - before.retainedBytes);
}
