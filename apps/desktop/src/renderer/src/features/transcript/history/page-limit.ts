// How many rows one `transcript.read` asks for, and how many a session keeps while off screen. A
// read is sized from a height, never a fixed row count: enough rows that, were each as short as
// the shortest row is estimated, they would fill the height still owed, so one page can finish a
// stretch; and never past the contract's ceiling.

import { TRANSCRIPT_READ_LIMIT_MAX } from "@ai-sidekicks/contracts/transcript/limits";

import { TRANSCRIPT_APPROACH_SCREEN_HEIGHTS } from "../viewport/caps.js";
import { RowMeasurementTable } from "../viewport/row-measurement-table.js";

/**
 * The row limit of a page that owes `owedHeightPx` of rows, given the least height a row is
 * estimated at: at least one row, at most `TRANSCRIPT_READ_LIMIT_MAX`.
 */
export function pageLimitFor(owedHeightPx: number, smallestRowHeightPx: number): number {
  return Math.min(
    TRANSCRIPT_READ_LIMIT_MAX,
    Math.max(1, Math.ceil(owedHeightPx / smallestRowHeightPx)),
  );
}

/**
 * The row limit of the read a session opens with: one screen height of the shortest rows. It is
 * asked before any transcript is laid out, so the screen is the window's own height, which no
 * pane exceeds, and the rows are the seeds' sizes at the window's root font size.
 */
export function transcriptOpeningPageLimit(ownerWindow: Window): number {
  const measurements = new RowMeasurementTable();
  measurements.setDisplaySettings({
    devicePixelRatio: ownerWindow.devicePixelRatio,
    rootFontSizePx: Number.parseFloat(
      ownerWindow.getComputedStyle(ownerWindow.document.documentElement).fontSize,
    ),
  });
  return pageLimitFor(ownerWindow.innerHeight, measurements.smallestEstimatePx);
}

/**
 * The most rows a session keeps while no screen shows it: the opening screen and the two screen
 * heights the opening look-ahead reads above it, in the opening read's rows, so a session shown
 * again opens on as much as a fresh one.
 */
export function transcriptOffScreenRowLimit(ownerWindow: Window): number {
  return (TRANSCRIPT_APPROACH_SCREEN_HEIGHTS + 1) * transcriptOpeningPageLimit(ownerWindow);
}
