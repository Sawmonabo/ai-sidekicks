// The quiet-period trim: what it takes, what it refuses to take, and when it runs.
//
// Every case drives the real objects — a real `LedgerWindow`, a real
// `RowMeasurementLedger`, the shipped `ManualClock` — because the claim is about what
// those three do together after a quiet period, and a stand-in for any of them would
// be a claim about the stand-in.

import { describe, expect, it } from "vitest";

import { LedgerIdleMemoryTrim } from "./idle-trim.js";
import { LedgerWindow } from "./window-cap.js";
import { RowMeasurementLedger } from "../measurement/index.js";
import { LEDGER_IDLE_TRIM_DWELL_MS } from "../frame-bounds.js";
import { ManualClock } from "../../../core/index.js";
import { PRUNABLE, TOP_LEVEL_ROW_COUNT, loadedWindow } from "./window-cap.test-support.js";

/** A dwell short enough to read in a case, long enough to be advanced past. */
const TEST_DWELL_MS = 1_000;

/** The newest chapter in the shared log — the one end of it the cap never drops. */
const NEWEST_CHAPTER_KEY = `chapter-${String(TOP_LEVEL_ROW_COUNT - 1)}`;

/** A window holding the rows named, each a top-level row of its own. */
function windowWithRows(rowKeys: readonly string[]): LedgerWindow {
  const window = new LedgerWindow();
  window.ingest(rowKeys.map((key) => ({ key, parentKey: undefined, rootCursor: key })));
  return window;
}

interface TrimFixture {
  readonly clock: ManualClock;
  readonly window: LedgerWindow;
  readonly measurements: RowMeasurementLedger;
  readonly trim: LedgerIdleMemoryTrim;
}

function fixture(rowKeys: readonly string[] = ["row-a", "row-b"]): TrimFixture {
  const clock = new ManualClock();
  const window = windowWithRows(rowKeys);
  const measurements = new RowMeasurementLedger();
  const trim = new LedgerIdleMemoryTrim({
    clock,
    window,
    measurements,
    dwellMs: TEST_DWELL_MS,
  });
  return { clock, window, measurements, trim };
}

describe("the trim arms nothing", () => {
  it("leaves the clock empty however much activity it is told about", () => {
    // The property `Spec-023 §Console Design (Meridian)` §The four bars asks for, and
    // the reason this is a measured gap rather than a dwell timer. A first draft armed
    // one and `LedgerViewport.test.tsx`'s settled-frame case caught it.
    const { clock, trim } = fixture();
    for (let beat = 0; beat < 5; beat += 1) {
      trim.noteActivity();
      clock.advance(TEST_DWELL_MS * 2);
    }
    expect(clock.pendingCount).toBe(0);
  });

  it("does nothing when time passes and nothing else happens", () => {
    // The cost this design accepts, stated as a case rather than only in prose: a
    // ledger nobody touches again keeps what it was holding until the frame is
    // disposed, and a disposed frame drops both tables whole.
    const { clock, measurements, trim } = fixture(["row-a"]);
    measurements.acceptedHeight("dropped-row", 80);
    trim.noteActivity();
    clock.advance(TEST_DWELL_MS * 100);

    expect(trim.lastPass).toBeUndefined();
    expect(measurements.measuredRowCount).toBe(1);
  });
});

describe("the trim runs on the first activity after a quiet period", () => {
  it("does not run when activity is closer together than the dwell", () => {
    const { clock, measurements, trim } = fixture(["row-a"]);
    measurements.acceptedHeight("dropped-row", 80);
    trim.noteActivity();
    clock.advance(TEST_DWELL_MS - 1);
    trim.noteActivity();

    expect(trim.lastPass).toBeUndefined();
  });

  it("runs when the gap since the previous activity reaches the dwell", () => {
    const { clock, measurements, trim } = fixture(["row-a"]);
    measurements.acceptedHeight("dropped-row", 80);
    trim.noteActivity();
    clock.advance(TEST_DWELL_MS);
    trim.noteActivity();

    expect(trim.lastPass?.measurementPriors).toBe(1);
    expect(trim.lastPass?.atMs).toBe(TEST_DWELL_MS);
  });

  it("measures the gap against the previous activity and not against the frame's birth", () => {
    // The negative control for where the stamp is taken. A trim that compared against
    // its own construction would fire once, late, on a ledger that had never paused —
    // and then never again.
    const { clock, measurements, trim } = fixture(["row-a"]);
    for (let beat = 0; beat < 10; beat += 1) {
      measurements.acceptedHeight(`dropped-${String(beat)}`, 80);
      trim.noteActivity();
      clock.advance(TEST_DWELL_MS - 1);
    }
    expect(trim.lastPass).toBeUndefined();
  });

  it("does not run on the first activity of a frame's life", () => {
    // A frame just built has been quiet for its whole existence and has nothing yet
    // to give back; comparing against an absent stamp would trim on the first render.
    const clock = new ManualClock();
    clock.advance(TEST_DWELL_MS * 10);
    const measurements = new RowMeasurementLedger();
    measurements.acceptedHeight("dropped-row", 80);
    const trim = new LedgerIdleMemoryTrim({
      clock,
      window: windowWithRows(["row-a"]),
      measurements,
      dwellMs: TEST_DWELL_MS,
    });
    trim.noteActivity();
    expect(trim.lastPass).toBeUndefined();
  });

  it("runs once per quiet period, not on every activity after one", () => {
    const { clock, measurements, trim } = fixture(["row-a"]);
    measurements.acceptedHeight("dropped-row", 80);
    trim.noteActivity();
    clock.advance(TEST_DWELL_MS);
    trim.noteActivity();
    const firstPass = trim.lastPass;
    expect(firstPass).toBeDefined();

    measurements.acceptedHeight("dropped-again", 80);
    trim.noteActivity();
    expect(trim.lastPass).toBe(firstPass);
    expect(measurements.measuredRowCount).toBe(1);
  });
});

describe("the trim takes only what the frame cannot reach", () => {
  it("drops the prior of a row the window no longer holds", () => {
    const { clock, measurements, trim } = fixture(["row-a"]);
    measurements.acceptedHeight("row-a", 40);
    measurements.acceptedHeight("dropped-row", 80);
    trim.noteActivity();
    clock.advance(TEST_DWELL_MS);
    trim.noteActivity();

    expect(trim.lastPass?.measurementPriors).toBe(1);
    expect(measurements.measuredRowCount).toBe(1);
  });

  it("keeps the prior of every row the window still holds", () => {
    // The property that makes the activity signal's completeness a non-question: a
    // pass triggered by something nobody counted as activity still cannot take a row
    // on screen.
    const { clock, measurements, trim } = fixture(["row-a", "row-b"]);
    measurements.acceptedHeight("row-a", 40);
    measurements.acceptedHeight("row-b", 60);
    trim.noteActivity();
    clock.advance(TEST_DWELL_MS);
    trim.noteActivity();

    expect(measurements.heightOf("row-a")).toBe(40);
    expect(measurements.heightOf("row-b")).toBe(60);
  });

  it("releases parked leases and leaves live ones alone", () => {
    // Parked through the real cap rather than by hand: a lease is parked because a
    // prune dropped its row, and a case that put one in the table directly would be
    // driving a state the frame cannot actually produce.
    const clock = new ManualClock();
    const window = loadedWindow();
    window.setLease("chapter-0", { density: "expanded", innerScrollTopPx: 44 });
    window.setLease(NEWEST_CHAPTER_KEY, { density: "expanded", innerScrollTopPx: 30 });
    window.prune(PRUNABLE);
    expect(window.lease("chapter-0")).toStrictEqual({ density: "expanded", innerScrollTopPx: 44 });

    const trim = new LedgerIdleMemoryTrim({
      clock,
      window,
      measurements: new RowMeasurementLedger(),
      dwellMs: TEST_DWELL_MS,
    });
    trim.noteActivity();
    clock.advance(TEST_DWELL_MS);
    trim.noteActivity();

    expect(trim.lastPass?.parkedLeases).toBe(1);
    expect(window.lease("chapter-0")).toBeUndefined();
    expect(window.lease(NEWEST_CHAPTER_KEY)).toStrictEqual({
      density: "expanded",
      innerScrollTopPx: 30,
    });
  });
});

describe("the trim records only a pass that returned something", () => {
  it("records nothing when there was nothing to take", () => {
    const { clock, trim } = fixture(["row-a"]);
    trim.noteActivity();
    clock.advance(TEST_DWELL_MS);
    trim.noteActivity();
    expect(trim.lastPass).toBeUndefined();
  });

  it("does not overwrite a real release with a later empty pass", () => {
    const { clock, measurements, trim } = fixture(["row-a"]);
    measurements.acceptedHeight("dropped-row", 80);
    trim.noteActivity();
    clock.advance(TEST_DWELL_MS);
    trim.noteActivity();
    const firstPass = trim.lastPass;
    expect(firstPass?.measurementPriors).toBe(1);

    clock.advance(TEST_DWELL_MS);
    trim.noteActivity();
    expect(trim.lastPass).toBe(firstPass);
  });
});

describe("the shipped dwell is the one the bounds module declares", () => {
  it("defaults to it rather than to a number written here", () => {
    const clock = new ManualClock();
    const measurements = new RowMeasurementLedger();
    measurements.acceptedHeight("dropped-row", 80);
    const trim = new LedgerIdleMemoryTrim({
      clock,
      window: windowWithRows(["row-a"]),
      measurements,
    });
    trim.noteActivity();
    clock.advance(LEDGER_IDLE_TRIM_DWELL_MS - 1);
    trim.noteActivity();
    expect(trim.lastPass).toBeUndefined();

    clock.advance(LEDGER_IDLE_TRIM_DWELL_MS);
    trim.noteActivity();
    expect(trim.lastPass).toBeDefined();
  });
});
