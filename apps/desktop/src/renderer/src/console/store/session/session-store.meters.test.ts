// What the apply chokepoint reports to the perf meters, and what it does not.
//
// The chokepoint is the one place a session's state is written, which is what makes
// it the one place the apply cost and the store's size can be read without a second
// path disagreeing. Both readings are behind the fixture define, so this file runs
// under `console-unit` — where the define is `true` — and asserts against the real
// process registry rather than a constructed one, because the registry the producers
// reach is that one and a test over its own instance would prove nothing about the
// wiring.

import { beforeEach, describe, expect, it } from "vitest";

import { devPerfMeters } from "../../core/perf-meters/perf-meters.js";
import { eventAt } from "./failure-modes.test-support.js";
import { SessionStore } from "./session-store.js";

const SESSION_ID = "session-1";

beforeEach(() => {
  devPerfMeters?.reset();
});

describe("the apply chokepoint's perf-meter readings", () => {
  it("records a latency sample and a size gauge for every batch it admits", () => {
    // The registry is `null` only in a release build, where every recording call
    // folds away with it. A null here means this project lost the fixture define,
    // and every assertion below would be vacuous.
    expect(devPerfMeters, "the console-unit project is not compiling the fixture define").not.toBe(
      null,
    );

    const store = new SessionStore({ sessionId: SESSION_ID });
    store.initialise({ cursor: 0, entities: [], userJoinLog: [] });
    store.applyBatch([eventAt(1), eventAt(2)]);

    const latency = devPerfMeters?.reading("apply-latency", SESSION_ID) ?? null;
    expect(
      latency,
      "the apply chokepoint recorded no latency for a batch it admitted",
    ).not.toBeNull();
    // Two applies so far — the initialise drain and this batch — and every one of
    // them is a fold this store performed.
    expect(Number(latency?.recordedCount)).toBeGreaterThan(0);
    expect(Number(latency?.latest)).toBeGreaterThanOrEqual(0);

    const size = devPerfMeters?.reading("store-size", SESSION_ID) ?? null;
    expect(size, "the apply chokepoint recorded no size after admitting a batch").not.toBeNull();
    // A GAUGE: the latest reading is the reading, and it is the timeline the ledger
    // mounts from rather than a count of what this batch happened to carry.
    expect(size?.latest).toBe(store.snapshot().timeline.length);
  });

  it("keys the readings by session, so two stores are two series", () => {
    const first = new SessionStore({ sessionId: SESSION_ID });
    const second = new SessionStore({ sessionId: "session-2" });
    first.initialise({ cursor: 0, entities: [], userJoinLog: [] });
    second.initialise({ cursor: 0, entities: [], userJoinLog: [] });
    first.applyBatch([eventAt(1)]);
    second.applyBatch([{ ...eventAt(1), sessionId: "session-2" }]);

    // Two stores, two series under each kind — what fails here is a producer keying
    // by a constant, which would fold both sessions' costs into one reading.
    expect(devPerfMeters?.reading("apply-latency", SESSION_ID)?.seriesKey).toBe(SESSION_ID);
    expect(devPerfMeters?.reading("apply-latency", "session-2")?.seriesKey).toBe("session-2");
    expect(devPerfMeters?.reading("store-size", SESSION_ID)?.seriesKey).toBe(SESSION_ID);
    expect(devPerfMeters?.reading("store-size", "session-2")?.seriesKey).toBe("session-2");
  });

  it("leaves the size gauge alone when a batch admits nothing", () => {
    const store = new SessionStore({ sessionId: SESSION_ID });
    store.initialise({ cursor: 0, entities: [], userJoinLog: [] });
    store.applyBatch([eventAt(1)]);
    const admittedSize = devPerfMeters?.reading("store-size", SESSION_ID)?.recordedCount ?? 0;

    // Addressed to another session: refused whole, no state written.
    store.applyBatch([eventAt(2, { sessionId: "session-elsewhere" })]);

    // The latency still moved — the fold ran and cost something — while the gauge did
    // not, because nothing it gauges changed.
    expect(devPerfMeters?.reading("store-size", SESSION_ID)?.recordedCount).toBe(admittedSize);
  });
});
