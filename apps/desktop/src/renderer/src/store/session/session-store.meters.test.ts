// What the apply chokepoint reports to the perf meters, and what it does not. The chokepoint is
// the one place state is written, so it is the one place apply cost and store size can be read
// without a second path disagreeing. Both readings sit behind the fixture define, so this runs
// under `console-unit` (where it is `true`) against the real process registry, since a test over
// its own instance would prove nothing about the wiring.

import { beforeEach, describe, expect, it } from "vitest";

import { developmentPerformanceMeters } from "@renderer/lib/performance-meters/performance-meters.js";
import { eventAt } from "./session-store.test-support.js";
import { SessionStore } from "./session-store.js";

const SESSION_ID = "session-1";

beforeEach(() => {
  developmentPerformanceMeters?.reset();
});

describe("the apply chokepoint's perf-meter readings", () => {
  it("records a latency sample and a size gauge for every batch it admits", () => {
    // The registry is `null` only in a release build; null here means the define was lost.
    expect(
      developmentPerformanceMeters,
      "the console-unit project is not compiling the fixture define",
    ).not.toBe(null);

    const store = new SessionStore({ sessionId: SESSION_ID });
    store.initialize({ cursor: 0, entities: [] });
    store.applyBatch([eventAt(1), eventAt(2)]);

    const latency = developmentPerformanceMeters?.reading("apply-latency", SESSION_ID) ?? null;
    expect(
      latency,
      "the apply chokepoint recorded no latency for a batch it admitted",
    ).not.toBeNull();
    // Every recorded apply is a fold this store performed.
    expect(Number(latency?.recordedCount)).toBeGreaterThan(0);
    expect(Number(latency?.latest)).toBeGreaterThanOrEqual(0);

    const size = developmentPerformanceMeters?.reading("store-size", SESSION_ID) ?? null;
    expect(size, "the apply chokepoint recorded no size after admitting a batch").not.toBeNull();
    // A gauge: the latest reading is the timeline the transcript mounts from, not the batch size.
    expect(size?.latest).toBe(store.snapshot().timeline.length);
  });

  it("keys the readings by session, so two stores are two series", () => {
    const first = new SessionStore({ sessionId: SESSION_ID });
    const second = new SessionStore({ sessionId: "session-2" });
    first.initialize({ cursor: 0, entities: [] });
    second.initialize({ cursor: 0, entities: [] });
    first.applyBatch([eventAt(1)]);
    second.applyBatch([{ ...eventAt(1), sessionId: "session-2" }]);

    // Fails if a producer keys by a constant, folding both sessions into one reading.
    expect(developmentPerformanceMeters?.reading("apply-latency", SESSION_ID)?.seriesKey).toBe(
      SESSION_ID,
    );
    expect(developmentPerformanceMeters?.reading("apply-latency", "session-2")?.seriesKey).toBe(
      "session-2",
    );
    expect(developmentPerformanceMeters?.reading("store-size", SESSION_ID)?.seriesKey).toBe(
      SESSION_ID,
    );
    expect(developmentPerformanceMeters?.reading("store-size", "session-2")?.seriesKey).toBe(
      "session-2",
    );
  });

  it("leaves the size gauge alone when a batch admits nothing", () => {
    const store = new SessionStore({ sessionId: SESSION_ID });
    store.initialize({ cursor: 0, entities: [] });
    store.applyBatch([eventAt(1)]);
    const admittedSize =
      developmentPerformanceMeters?.reading("store-size", SESSION_ID)?.recordedCount ?? 0;

    // Addressed to another session: refused whole, no state written.
    store.applyBatch([eventAt(2, { sessionId: "session-elsewhere" })]);

    // The latency still moved (the fold ran) while the gauge did not: nothing it gauges changed.
    expect(developmentPerformanceMeters?.reading("store-size", SESSION_ID)?.recordedCount).toBe(
      admittedSize,
    );
  });
});
