// Drives the real window, measurement table and ManualClock together; a stand-in would be a claim
// about the stand-in.

import { describe, expect, it } from "vitest";

import { IdleMemoryTrim } from "./idle-trim.js";
import { TranscriptWindow } from "./window-cap.js";
import { RowMeasurementTable } from "./row-measurement-table.js";
import { TRANSCRIPT_IDLE_TRIM_DWELL_MS } from "./constants.js";
import { ManualClock } from "#renderer/lib/clock.js";
import { PRUNABLE, TOP_LEVEL_ROW_COUNT, loadedWindow } from "./window-cap.test-support.js";

/** The newest run group in the shared log — the one end of it the cap never drops. */
const NEWEST_RUN_GROUP_KEY = `run-group-${String(TOP_LEVEL_ROW_COUNT - 1)}`;

/** A window holding the rows named, each a top-level row of its own. */
function windowWithRows(rowKeys: readonly string[]): TranscriptWindow {
  const window = new TranscriptWindow();
  window.ingest(rowKeys.map((key) => ({ key, parentKey: undefined, rootCursor: key })));
  return window;
}

interface TrimFixture {
  readonly clock: ManualClock;
  readonly window: TranscriptWindow;
  readonly measurements: RowMeasurementTable;
  readonly trim: IdleMemoryTrim;
}

function fixture(rowKeys: readonly string[] = ["row-a", "row-b"]): TrimFixture {
  const clock = new ManualClock();
  const window = windowWithRows(rowKeys);
  const measurements = new RowMeasurementTable();
  const trim = new IdleMemoryTrim({
    clock,
    window,
    measurements,
  });
  return { clock, window, measurements, trim };
}

describe("the trim arms nothing", () => {
  it("leaves the clock empty however much activity it is told about", () => {
    // A settled frame must arm nothing, so the trim measures a gap instead of arming a timer.
    const { clock, trim } = fixture();
    for (let beat = 0; beat < 5; beat += 1) {
      trim.noteActivity();
      clock.advance(TRANSCRIPT_IDLE_TRIM_DWELL_MS * 2);
    }
    expect(clock.pendingCount).toBe(0);
  });
});

describe("the trim runs on the first activity after a quiet period", () => {
  it("measures the gap against the previous activity and not against the frame's birth", () => {
    // A trim comparing against its own construction would fire once, late, and never again.
    const { clock, measurements, trim } = fixture(["row-a"]);
    for (let beat = 0; beat < 10; beat += 1) {
      measurements.acceptedHeight(`dropped-${String(beat)}`, 80);
      trim.noteActivity();
      clock.advance(TRANSCRIPT_IDLE_TRIM_DWELL_MS - 1);
    }
    expect(measurements.heightOf("dropped-0")).toBe(80);
  });
});

describe("the trim takes only what the frame cannot reach", () => {
  it("drops the prior of a row the window no longer holds", () => {
    const { clock, measurements, trim } = fixture(["row-a"]);
    measurements.acceptedHeight("row-a", 40);
    measurements.acceptedHeight("dropped-row", 80);
    trim.noteActivity();
    clock.advance(TRANSCRIPT_IDLE_TRIM_DWELL_MS);
    trim.noteActivity();

    expect(measurements.heightOf("dropped-row")).toBe(measurements.heightOf("never-measured"));
    expect(measurements.heightOf("row-a")).toBe(40);
  });

  it("keeps the prior of every row the window still holds", () => {
    // A pass triggered by something not counted as activity still cannot take an on-screen row.
    const { clock, measurements, trim } = fixture(["row-a", "row-b"]);
    measurements.acceptedHeight("row-a", 40);
    measurements.acceptedHeight("row-b", 60);
    trim.noteActivity();
    clock.advance(TRANSCRIPT_IDLE_TRIM_DWELL_MS);
    trim.noteActivity();

    expect(measurements.heightOf("row-a")).toBe(40);
    expect(measurements.heightOf("row-b")).toBe(60);
  });

  it("releases parked states and leaves live ones alone", () => {
    // Parked through the real cap: a retained state is parked because a prune dropped its row.
    const clock = new ManualClock();
    const window = loadedWindow();
    window.setRetainedState("run-group-0", { density: "expanded", innerScrollTopPx: 44 });
    window.setRetainedState(NEWEST_RUN_GROUP_KEY, { density: "expanded", innerScrollTopPx: 30 });
    window.prune(PRUNABLE);
    expect(window.retainedState("run-group-0")).toStrictEqual({
      density: "expanded",
      innerScrollTopPx: 44,
    });

    const trim = new IdleMemoryTrim({
      clock,
      window,
      measurements: new RowMeasurementTable(),
    });
    trim.noteActivity();
    clock.advance(TRANSCRIPT_IDLE_TRIM_DWELL_MS);
    trim.noteActivity();

    expect(window.retainedState("run-group-0")).toBeUndefined();
    expect(window.retainedState(NEWEST_RUN_GROUP_KEY)).toStrictEqual({
      density: "expanded",
      innerScrollTopPx: 30,
    });
  });
});
