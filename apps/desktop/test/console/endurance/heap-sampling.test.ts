// The collector's memo, and the order dependence it used to have.
//
// The subject is `test/console/heap-sampling.ts`, which this tier's terminal cases
// measure through. It lives beside them rather than in a tier of its own because
// its one consumer is here, and because the property under test is the one that
// decides whether a heap assertion in this directory is admissible at all: if the
// collector reports itself unavailable for a reason belonging to some other file,
// every reading beside it is skipped or is noise.
//
// The resolver is injected in every case below. A test cannot make this process
// refuse a collector on demand — `v8.setFlagsFromString("--expose-gc")` succeeds
// here — so a case that drove the real one could only ever exercise the arm that
// works, which is the arm that was never broken.

import { describe, expect, it } from "vitest";

import { HeapCollector, HeapSampler, retainedGrowthBytes } from "../heap-sampling.js";

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

    // The whole reason the resolution is memoised: it mutates a process-wide V8
    // flag, and a sample-time resolution would flip that flag once per round for
    // the length of the run.
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
    // The defect this shape removes. With the memo in module variables, the first
    // resolution to fail was the answer every later caller in the process got —
    // including one that ran after a collector had been installed.
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
    // Without this, the case above would pass against a collector that re-resolved
    // on every call — which would fix the order dependence by removing the memo,
    // and flip the process-wide flag once per sample to do it.
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

    // Four rounds and the final collection. The rounds are what make two readings
    // comparable; a sampler that read straight after one collection would report a
    // disposed instance's bytes as still retained.
    expect(collectionCount).toBe(5);
    expect(sample.retainedBytes).toBe(sample.heapUsedBytes + sample.arrayBufferBytes);
  });

  it("reads on a runtime that gives no collector rather than refusing to read", async () => {
    // The reading is still taken — it is the CALLER that decides a reading with no
    // collection behind it is inadmissible, and it decides that from this flag.
    const sampler = new HeapSampler(new HeapCollector(() => undefined));
    expect(sampler.isCollectorAvailable).toBe(false);
    expect((await sampler.sample()).retainedBytes).toBeGreaterThan(0);
  });

  it("reports the collector this process actually has, by default", () => {
    // The default path, asserted once so the injection above is not the only shape
    // this module is ever driven in. Node gives the accessor up through
    // `v8.setFlagsFromString`, which is the premise every heap case in this tier
    // rests on.
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
