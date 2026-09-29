// What the dev perf meters promise: bounded retention, an honest percentile, a
// counted refusal rather than an unbounded map, a series bound that counts LIVE
// producers rather than every producer that ever existed, and recording entry points
// that reach the process registry only under the fixture define.

import { describe, expect, it } from "vitest";

import { PERFORMANCE_METER_BOUNDS } from "./performance-meter-bounds.js";
import {
  PERFORMANCE_METER_KINDS,
  PerformanceMeterRegistry,
  developmentPerformanceMeters,
  recordApplyLatency,
  recordFrameTime,
  recordRevealDrain,
  recordStoreSize,
  retireFrameTimeSeries,
  retireRevealDrainSeries,
} from "./performance-meters.js";

describe("perf meter series", () => {
  it("reports the nearest-rank percentile, which is a sample that was observed", () => {
    const registry = new PerformanceMeterRegistry();
    for (const milliseconds of [1, 2, 3, 4, 5, 6, 7, 8, 9, 100]) {
      registry.record("frame-time", "ledger", milliseconds);
    }
    const reading = registry.reading("frame-time", "ledger");
    expect(reading).not.toBeNull();
    expect(reading?.sampleCount).toBe(10);
    expect(reading?.median).toBe(5);
    // Nearest rank at 95 over ten samples is the tenth, so the reading is the worst
    // frame the console actually produced rather than an interpolation between two.
    expect(reading?.upperPercentile).toBe(100);
    expect(reading?.worst).toBe(100);
    expect(reading?.latest).toBe(100);
  });

  it("retains at most the bound and keeps counting past it", () => {
    const registry = new PerformanceMeterRegistry();
    const overflow = PERFORMANCE_METER_BOUNDS.seriesSampleCount + 25;
    for (let sample = 0; sample < overflow; sample += 1) {
      registry.record("apply-latency", "session", sample);
    }
    const reading = registry.reading("apply-latency", "session");
    expect(reading?.sampleCount).toBe(PERFORMANCE_METER_BOUNDS.seriesSampleCount);
    expect(reading?.recordedCount).toBe(overflow);
    // The oldest 25 are gone, so the smallest retained sample is the 25th.
    expect(reading?.median).toBe(
      25 + Math.ceil(PERFORMANCE_METER_BOUNDS.seriesSampleCount / 2) - 1,
    );
    expect(reading?.latest).toBe(overflow - 1);
  });

  it("refuses a series past the series bound and counts the refusal", () => {
    const registry = new PerformanceMeterRegistry();
    for (let lane = 0; lane < PERFORMANCE_METER_BOUNDS.seriesCount + 3; lane += 1) {
      registry.record("store-size", `lane-${lane}`, lane);
    }
    expect(registry.seriesCount).toBe(PERFORMANCE_METER_BOUNDS.seriesCount);
    expect(registry.refusedSeriesCount).toBe(3);
    // The refusal is a refusal and not a silent overwrite: the first series still
    // holds its own reading.
    expect(registry.reading("store-size", "lane-0")?.latest).toBe(0);
  });

  it("retires a series, so a producer that has gone away stops holding the bound", () => {
    const registry = new PerformanceMeterRegistry();
    for (let feed = 0; feed < PERFORMANCE_METER_BOUNDS.seriesCount; feed += 1) {
      registry.record("frame-time", `feed-${String(feed)}`, feed);
    }
    expect(registry.seriesCount).toBe(PERFORMANCE_METER_BOUNDS.seriesCount);

    // The registry is full, so the next key is refused — the state a producer whose
    // key names an instance reaches by mounting and unmounting, over and over.
    registry.record("frame-time", "feed-arriving", 1);
    expect(registry.refusedSeriesCount).toBe(1);

    expect(registry.retire("frame-time", "feed-0")).toBe(true);
    expect(registry.seriesCount).toBe(PERFORMANCE_METER_BOUNDS.seriesCount - 1);
    // The retired series is gone rather than emptied: a reading it could still answer
    // would be a closed feed's p95 presented as a live one's.
    expect(registry.reading("frame-time", "feed-0")).toBeNull();

    registry.record("frame-time", "feed-arriving", 7);
    expect(registry.reading("frame-time", "feed-arriving")?.latest).toBe(7);
    expect(registry.refusedSeriesCount).toBe(1);
  });

  it("negative control: retiring a key it never opened answers false and moves nothing", () => {
    // The underflow this guards: a decrement on a miss makes the open count drift
    // below the truth, and the bound then admits series past its own figure — which
    // reads as a working registry until the map is the size the bound exists to cap.
    const registry = new PerformanceMeterRegistry();
    registry.record("frame-time", "feed-1", 3);

    expect(registry.retire("frame-time", "never-opened")).toBe(false);
    expect(registry.retire("store-size", "feed-1")).toBe(false);
    expect(registry.seriesCount).toBe(1);

    for (let feed = 0; feed < PERFORMANCE_METER_BOUNDS.seriesCount; feed += 1) {
      registry.record("frame-time", `filler-${String(feed)}`, feed);
    }
    expect(registry.seriesCount).toBe(PERFORMANCE_METER_BOUNDS.seriesCount);
    expect(registry.refusedSeriesCount).toBe(1);
  });

  it("retires under the same truncation it opened under", () => {
    // A key past the character bound opens a truncated series, so a retirement that
    // did not truncate would close nothing and leave a series no producer can reach.
    const registry = new PerformanceMeterRegistry();
    const overlongKey = `${"x".repeat(PERFORMANCE_METER_BOUNDS.seriesKeyCharacterCount)}-tail`;
    registry.record("reveal-drain", overlongKey, 12);
    expect(registry.seriesCount).toBe(1);

    expect(registry.retire("reveal-drain", overlongKey)).toBe(true);
    expect(registry.seriesCount).toBe(0);
  });

  it("truncates a series key rather than letting a value become an unbounded one", () => {
    const registry = new PerformanceMeterRegistry();
    const overlongKey = "x".repeat(PERFORMANCE_METER_BOUNDS.seriesKeyCharacterCount + 40);
    registry.record("reveal-drain", overlongKey, 12);
    const reading = registry.reading("reveal-drain", overlongKey);
    expect(reading?.seriesKey.length).toBe(PERFORMANCE_METER_BOUNDS.seriesKeyCharacterCount);
    expect(reading?.latest).toBe(12);
  });

  it("drops a non-finite sample rather than poisoning every percentile with it", () => {
    const registry = new PerformanceMeterRegistry();
    registry.record("frame-time", "ledger", 8);
    registry.record("frame-time", "ledger", Number.NaN);
    registry.record("frame-time", "ledger", Number.POSITIVE_INFINITY);
    const reading = registry.reading("frame-time", "ledger");
    expect(reading?.sampleCount).toBe(1);
    expect(reading?.worst).toBe(8);
  });

  it("keeps the four kinds apart on one series key", () => {
    const registry = new PerformanceMeterRegistry();
    for (const kind of PERFORMANCE_METER_KINDS) {
      registry.record(kind, "ledger", PERFORMANCE_METER_KINDS.indexOf(kind));
    }
    expect(registry.seriesCount).toBe(PERFORMANCE_METER_KINDS.length);
    expect(registry.readings().map((reading) => reading.kind)).toStrictEqual([
      ...PERFORMANCE_METER_KINDS,
    ]);
  });

  it("reads nothing from a series that recorded nothing", () => {
    const registry = new PerformanceMeterRegistry();
    expect(registry.reading("frame-time", "never-used")).toBeNull();
    expect(registry.readings()).toStrictEqual([]);
  });

  it("forgets every sample and refusal on reset", () => {
    const registry = new PerformanceMeterRegistry();
    registry.record("frame-time", "ledger", 4);
    registry.reset();
    expect(registry.seriesCount).toBe(0);
    expect(registry.refusedSeriesCount).toBe(0);
  });
});

describe("the recording and retiring entry points", () => {
  it("the retiring pair reaches the same process registry the recorders do", () => {
    expect(developmentPerformanceMeters).not.toBeNull();
    developmentPerformanceMeters?.reset();
    recordFrameTime("transcript-frame#900", 9);
    recordRevealDrain("transcript-frame#900/transcript-reveal-drain#1", 40);
    expect(developmentPerformanceMeters?.seriesCount).toBe(2);

    retireFrameTimeSeries("transcript-frame#900");
    retireRevealDrainSeries("transcript-frame#900/transcript-reveal-drain#1");

    expect(developmentPerformanceMeters?.seriesCount).toBe(0);
    expect(developmentPerformanceMeters?.reading("frame-time", "transcript-frame#900")).toBeNull();
    developmentPerformanceMeters?.reset();
  });

  it("each reaches the process registry under the fixture define", () => {
    // The unit project compiles with the fixture define true, so the registry exists
    // here. A release build folds the ternary to null and every call below to nothing,
    // which is what the release-absence sweep reads.
    expect(developmentPerformanceMeters).not.toBeNull();
    developmentPerformanceMeters?.reset();
    recordFrameTime("chapter", 9);
    recordRevealDrain("chapter", 40);
    recordApplyLatency("run", 3);
    recordStoreSize("run", 128);
    expect(developmentPerformanceMeters?.reading("frame-time", "chapter")?.latest).toBe(9);
    expect(developmentPerformanceMeters?.reading("reveal-drain", "chapter")?.latest).toBe(40);
    expect(developmentPerformanceMeters?.reading("apply-latency", "run")?.latest).toBe(3);
    expect(developmentPerformanceMeters?.reading("store-size", "run")?.latest).toBe(128);
    developmentPerformanceMeters?.reset();
  });
});
