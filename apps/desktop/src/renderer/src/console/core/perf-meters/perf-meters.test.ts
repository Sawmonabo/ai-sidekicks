// What the dev perf meters promise: bounded retention, an honest percentile, a
// counted refusal rather than an unbounded map, and a handle that exists only under
// the fixture define.

import { describe, expect, it } from "vitest";

import { PERF_METER_BOUNDS } from "./perf-meter-bounds.js";
import {
  PERF_METER_KINDS,
  PerfMeterRegistry,
  devPerfMeters,
  recordApplyLatency,
  recordFrameTime,
  recordRevealDrain,
  recordStoreSize,
} from "./perf-meters.js";
import { REACT_SCAN_FIXTURE_GLOBAL } from "../fixture-globals.js";
import { renderScanControl } from "./render-scan-toggle.js";

describe("perf meter series", () => {
  it("reports the nearest-rank percentile, which is a sample that was observed", () => {
    const registry = new PerfMeterRegistry();
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
    const registry = new PerfMeterRegistry();
    const overflow = PERF_METER_BOUNDS.seriesSampleCount + 25;
    for (let sample = 0; sample < overflow; sample += 1) {
      registry.record("apply-latency", "session", sample);
    }
    const reading = registry.reading("apply-latency", "session");
    expect(reading?.sampleCount).toBe(PERF_METER_BOUNDS.seriesSampleCount);
    expect(reading?.recordedCount).toBe(overflow);
    // The oldest 25 are gone, so the smallest retained sample is the 25th.
    expect(reading?.median).toBe(25 + Math.ceil(PERF_METER_BOUNDS.seriesSampleCount / 2) - 1);
    expect(reading?.latest).toBe(overflow - 1);
  });

  it("refuses a series past the series bound and counts the refusal", () => {
    const registry = new PerfMeterRegistry();
    for (let lane = 0; lane < PERF_METER_BOUNDS.seriesCount + 3; lane += 1) {
      registry.record("store-size", `lane-${lane}`, lane);
    }
    expect(registry.seriesCount).toBe(PERF_METER_BOUNDS.seriesCount);
    expect(registry.refusedSeriesCount).toBe(3);
    // The refusal is a refusal and not a silent overwrite: the first series still
    // holds its own reading.
    expect(registry.reading("store-size", "lane-0")?.latest).toBe(0);
  });

  it("truncates a series key rather than letting a value become an unbounded one", () => {
    const registry = new PerfMeterRegistry();
    const overlongKey = "x".repeat(PERF_METER_BOUNDS.seriesKeyCharacterCount + 40);
    registry.record("reveal-drain", overlongKey, 12);
    const reading = registry.reading("reveal-drain", overlongKey);
    expect(reading?.seriesKey.length).toBe(PERF_METER_BOUNDS.seriesKeyCharacterCount);
    expect(reading?.latest).toBe(12);
  });

  it("drops a non-finite sample rather than poisoning every percentile with it", () => {
    const registry = new PerfMeterRegistry();
    registry.record("frame-time", "ledger", 8);
    registry.record("frame-time", "ledger", Number.NaN);
    registry.record("frame-time", "ledger", Number.POSITIVE_INFINITY);
    const reading = registry.reading("frame-time", "ledger");
    expect(reading?.sampleCount).toBe(1);
    expect(reading?.worst).toBe(8);
  });

  it("keeps the four kinds apart on one series key", () => {
    const registry = new PerfMeterRegistry();
    for (const kind of PERF_METER_KINDS) {
      registry.record(kind, "ledger", PERF_METER_KINDS.indexOf(kind));
    }
    expect(registry.seriesCount).toBe(PERF_METER_KINDS.length);
    expect(registry.readings().map((reading) => reading.kind)).toStrictEqual([...PERF_METER_KINDS]);
  });

  it("reads nothing from a series that recorded nothing", () => {
    const registry = new PerfMeterRegistry();
    expect(registry.reading("frame-time", "never-used")).toBeNull();
    expect(registry.readings()).toStrictEqual([]);
  });

  it("forgets every sample and refusal on reset", () => {
    const registry = new PerfMeterRegistry();
    registry.record("frame-time", "ledger", 4);
    registry.reset();
    expect(registry.seriesCount).toBe(0);
    expect(registry.refusedSeriesCount).toBe(0);
  });
});

describe("the four recording entry points", () => {
  it("each reaches the process registry under the fixture define", () => {
    // The unit project compiles with the fixture define true, so the registry exists
    // here. A release build folds the ternary to null and every call below to nothing,
    // which is what the release-absence sweep reads.
    expect(devPerfMeters).not.toBeNull();
    devPerfMeters?.reset();
    recordFrameTime("chapter", 9);
    recordRevealDrain("chapter", 40);
    recordApplyLatency("run", 3);
    recordStoreSize("run", 128);
    expect(devPerfMeters?.reading("frame-time", "chapter")?.latest).toBe(9);
    expect(devPerfMeters?.reading("reveal-drain", "chapter")?.latest).toBe(40);
    expect(devPerfMeters?.reading("apply-latency", "run")?.latest).toBe(3);
    expect(devPerfMeters?.reading("store-size", "run")?.latest).toBe(128);
    devPerfMeters?.reset();
  });
});

describe("the render-scan toggle", () => {
  it("hangs its control on the page under the fixture define and starts disarmed", () => {
    // Importing the module is what installs the handle, so this reads the real
    // installation rather than a reconstruction of it.
    expect((globalThis as Record<string, unknown>)[REACT_SCAN_FIXTURE_GLOBAL]).toBe(
      renderScanControl,
    );
    expect(renderScanControl.isScanning()).toBe(false);
  });

  it("stopping before a start is inert rather than a load", () => {
    renderScanControl.stop();
    expect(renderScanControl.isScanning()).toBe(false);
  });
});
