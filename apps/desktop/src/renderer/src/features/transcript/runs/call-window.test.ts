// A long run's window, measured in screens: how much of a run it holds, how far a press on an edge
// moves it, and when it holds the run's newest calls. Driven with a fixed measure, so each case
// reads in rows of a known height.

import { describe, expect, it } from "vitest";

import {
  TRANSCRIPT_RETAINED_SCREEN_HEIGHTS,
  TRANSCRIPT_STRETCH_SCREEN_HEIGHTS,
} from "../viewport/caps.js";
import { TranscriptWindowDerivation, deriveTranscriptWindow } from "../window/transcript-window.js";
import { RunCallWindows, rowBesideRunWindowEdge, type RunWindowMeasure } from "./call-window.js";
import { longRunEvents, onlyRunGroupOf } from "./call-window.test-support.js";
import { type RunGroup } from "./groups.js";

const SCREEN_HEIGHT_PX = 100;

/** A measure over a screen of `SCREEN_HEIGHT_PX`, every row `rowHeightPx` tall. */
function measureOf(rowHeightPx: number): RunWindowMeasure {
  return { screenHeightPx: () => SCREEN_HEIGHT_PX, rowHeightPx: () => rowHeightPx };
}

/** The long run of `eventCount` events, as one group. */
function longRun(eventCount: number): RunGroup {
  return onlyRunGroupOf(deriveTranscriptWindow(longRunEvents(eventCount)));
}

/** How many screens the calls from `firstCallIndex` up to `endCallIndex` fill at `rowHeightPx`. */
function screensBetween(firstCallIndex: number, endCallIndex: number, rowHeightPx: number): number {
  return ((endCallIndex - firstCallIndex) * rowHeightPx) / SCREEN_HEIGHT_PX;
}

describe("a long run's window", () => {
  it("holds about the same screens of a run of tall calls as of one-line calls", () => {
    const runGroup = longRun(400);
    for (const rowHeightPx of [10, 100]) {
      const window = new RunCallWindows().windowOf(runGroup, measureOf(rowHeightPx));
      const screens = screensBetween(window.firstCallIndex, window.endCallIndex, rowHeightPx);
      expect(window.laterCount).toBe(0);
      // Never short of the retained share, and over it by less than one call.
      expect(screens).toBeGreaterThanOrEqual(TRANSCRIPT_RETAINED_SCREEN_HEIGHTS);
      expect(screens).toBeLessThan(
        TRANSCRIPT_RETAINED_SCREEN_HEIGHTS + rowHeightPx / SCREEN_HEIGHT_PX,
      );
    }
  });

  it("steps a stretch of screens per press, keeping the call beside the pressed edge", () => {
    const runGroup = longRun(400);
    const measure = measureOf(10);
    const windows = new RunCallWindows();
    const newest = windows.windowOf(runGroup, measure);

    windows.openStretch(runGroup, "earlier", measure);
    const earlier = windows.windowOf(runGroup, measure);
    expect(screensBetween(earlier.firstCallIndex, newest.firstCallIndex, 10)).toBe(
      TRANSCRIPT_STRETCH_SCREEN_HEIGHTS,
    );
    expect(earlier.endCallIndex).toBeGreaterThan(newest.firstCallIndex);

    windows.openStretch(runGroup, "earlier", measure);
    const earlierStill = windows.windowOf(runGroup, measure);
    windows.openStretch(runGroup, "later", measure);
    const later = windows.windowOf(runGroup, measure);
    expect(screensBetween(earlierStill.endCallIndex, later.endCallIndex, 10)).toBe(
      TRANSCRIPT_STRETCH_SCREEN_HEIGHTS,
    );
    const besideLaterEdge = rowBesideRunWindowEdge(runGroup, earlierStill, "later");
    expect(besideLaterEdge).toBeDefined();
    const besidePosition = runGroup.rowIds.indexOf(besideLaterEdge ?? "");
    expect(besidePosition).toBeGreaterThanOrEqual(later.firstRowPosition);
    expect(besidePosition).toBeLessThanOrEqual(later.lastRowPosition);
  });

  it("holds the run's newest calls again once a later stretch reaches them", () => {
    const events = longRunEvents(460);
    const derivation = new TranscriptWindowDerivation();
    const runGroup = onlyRunGroupOf(derivation.derive(events.slice(0, 400)));
    const measure = measureOf(10);
    const windows = new RunCallWindows();
    windows.windowOf(runGroup, measure);
    windows.openStretch(runGroup, "earlier", measure);
    expect(windows.windowOf(runGroup, measure).laterCount).toBeGreaterThan(0);

    windows.openStretch(runGroup, "later", measure);
    const grown = onlyRunGroupOf(derivation.derive(events));
    const window = windows.windowOf(grown, measure);

    expect(window.laterCount).toBe(0);
    expect(window.endCallIndex).toBe(grown.drawnRowPositions.length);
  });
});
