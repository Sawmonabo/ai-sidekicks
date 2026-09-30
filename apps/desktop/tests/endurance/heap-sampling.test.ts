// The collector's memo belongs to the instance that holds it. The subject is `heap-sampling.ts`,
// whose collector decides whether a heap assertion here is admissible at all: a collector
// reported unavailable for another file's reason makes every reading beside it noise.
//
// The resolver is injected throughout: this process cannot be made to refuse a collector
// (`v8.setFlagsFromString("--expose-gc")` succeeds here), so the real one would only exercise
// the arm that was never broken.

import { describe, expect, it } from "vitest";

import { HeapCollector, HeapSampler, retainedGrowthBytes } from "./heap-sampling.js";

/** A resolver that refuses the first time it is asked and hands one over after. */
function resolverRefusingOnce(collector: () => void): () => (() => void) | undefined {
  let hasRefused = false;
  return () => {
    if (!hasRefused) {
      hasRefused = true;
      return undefined;
    }
    return collector;
  };
}

describe("the collector's memo belongs to the instance that holds it", () => {
  it("resolves at most once, however many times it is asked", () => {
    let resolutionCount = 0;
    const collector = new HeapCollector(() => {
      resolutionCount += 1;
      return () => undefined;
    });

    collector.available();
    collector.collect();
    collector.collect();
    collector.available();

    // The memo exists because resolution mutates a process-wide V8 flag; resolving per sample
    // would flip it every round.
    expect(resolutionCount).toBe(1);
  });

  it("remembers a refusal, so a runtime with no collector is asked once", () => {
    let resolutionCount = 0;
    const collector = new HeapCollector(() => {
      resolutionCount += 1;
      return undefined;
    });

    expect(collector.available()).toBe(false);
    collector.collect();
    expect(collector.available()).toBe(false);
    expect(resolutionCount).toBe(1);
  });

  it("does not let one instance's failed resolution narrow another's", () => {
    // With the memo in module variables, the first failed resolution was every later caller's
    // answer, even after a collector had been installed.
    const collections: string[] = [];
    const resolve = resolverRefusingOnce(() => collections.push("collected"));

    const refused = new HeapCollector(resolve);
    expect(refused.available()).toBe(false);

    const served = new HeapCollector(resolve);
    expect(served.available()).toBe(true);
    served.collect();
    expect(collections).toStrictEqual(["collected"]);
  });

  it("negative control: one instance really does keep its own first answer", () => {
    // Without this, the case above would pass against a collector that re-resolved on every
    // call, which fixes the order dependence by removing the memo.
    const refusingThenServing = new HeapCollector(resolverRefusingOnce(() => undefined));
    expect(refusingThenServing.available()).toBe(false);
    expect(refusingThenServing.available()).toBe(false);
  });
});

describe("the sampler, over the collector it was handed", () => {
  it("collects on every settling round and once more before it reads", async () => {
    let collectionCount = 0;
    const sampler = new HeapSampler(
      new HeapCollector(() => () => {
        collectionCount += 1;
      }),
    );

    const sample = await sampler.sample();

    // Four rounds and the final collection. Reading straight after one collection would report
    // a disposed instance's bytes as still retained.
    expect(collectionCount).toBe(5);
    expect(sample.retainedBytes).toBe(sample.heapUsedBytes + sample.arrayBufferBytes);
  });

  it("reads on a runtime that gives no collector rather than refusing to read", async () => {
    // The reading is still taken; the caller decides from this flag that it is inadmissible.
    const sampler = new HeapSampler(new HeapCollector(() => undefined));
    expect(sampler.isCollectorAvailable).toBe(false);
    expect((await sampler.sample()).retainedBytes).toBeGreaterThan(0);
  });

  it("reports the collector this process actually has, by default", () => {
    // The default path, asserted once so injection is not the only shape this module is driven
    // in. Node gives the accessor up through `v8.setFlagsFromString`.
    expect(new HeapSampler().isCollectorAvailable).toBe(true);
  });
});

describe("the growth between two readings", () => {
  it("floors a shrink at zero, because a shrink is not a leak", () => {
    const larger = { heapUsedBytes: 30, arrayBufferBytes: 10, retainedBytes: 40 };
    const smaller = { heapUsedBytes: 10, arrayBufferBytes: 5, retainedBytes: 15 };
    expect(retainedGrowthBytes(larger, smaller)).toBe(0);
  });

  it("negative control: it does report a real growth", () => {
    const smaller = { heapUsedBytes: 10, arrayBufferBytes: 5, retainedBytes: 15 };
    const larger = { heapUsedBytes: 30, arrayBufferBytes: 10, retainedBytes: 40 };
    expect(retainedGrowthBytes(smaller, larger)).toBe(25);
  });
});
