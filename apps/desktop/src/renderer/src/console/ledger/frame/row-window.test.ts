// The row window's five residuals, driven as arithmetic.
//
// No DOM here on purpose: every claim is about the prefix sum and the priors, and a
// shim that answers zero for every rect would make each of them pass vacuously.

import { describe, expect, it } from "vitest";

import {
  LEDGER_GEOMETRY_EPSILON_PX,
  LEDGER_MAX_ELEMENT_HEIGHT_PX,
  LEDGER_OVERSCAN_ROWS,
  LEDGER_ROW_HEIGHT_ESTIMATE_PX,
} from "./frame-bounds.js";
import { RowWindow } from "./row-window.js";

function keys(count: number, prefix = "row"): readonly string[] {
  return Array.from({ length: count }, (_unused, index) => `${prefix}-${String(index)}`);
}

describe("the row window — offsets and the total", () => {
  it("estimates every unmeasured row, and answers the total from the same array", () => {
    const rowWindow = new RowWindow();
    const rowKeys = keys(100);
    expect(rowWindow.offsetOf(rowKeys, 0)).toBe(0);
    expect(rowWindow.offsetOf(rowKeys, 10)).toBe(10 * LEDGER_ROW_HEIGHT_ESTIMATE_PX);
    expect(rowWindow.rangeFor(rowKeys, 0, 400).totalHeightPx).toBe(
      100 * LEDGER_ROW_HEIGHT_ESTIMATE_PX,
    );
  });

  it("uses a measurement once it has one", () => {
    const rowWindow = new RowWindow();
    const rowKeys = keys(3);
    expect(rowWindow.measure("row-0", 240)).toBe(true);
    expect(rowWindow.offsetOf(rowKeys, 1)).toBe(240);
    expect(rowWindow.rangeFor(rowKeys, 0, 400).totalHeightPx).toBe(
      240 + 2 * LEDGER_ROW_HEIGHT_ESTIMATE_PX,
    );
  });

  it("mounts a slice around the fold, with overscan on both edges", () => {
    const rowWindow = new RowWindow();
    const rowKeys = keys(400);
    const range = rowWindow.rangeFor(rowKeys, 50 * LEDGER_ROW_HEIGHT_ESTIMATE_PX, 300);
    expect(range.startIndex).toBe(50 - LEDGER_OVERSCAN_ROWS);
    expect(range.endIndex).toBeLessThan(60 + LEDGER_OVERSCAN_ROWS);
    expect(range.offsetBeforeStartPx).toBe(range.startIndex * LEDGER_ROW_HEIGHT_ESTIMATE_PX);
  });

  it("negative control: the slice really is a slice", () => {
    // Without this, every range assertion would pass over a window that mounted
    // every row it was handed.
    const rowWindow = new RowWindow();
    const rowKeys = keys(400);
    const range = rowWindow.rangeFor(rowKeys, 0, 300);
    expect(range.endIndex - range.startIndex).toBeLessThan(rowKeys.length);
  });

  it("answers an empty list without inventing a row", () => {
    const range = new RowWindow().rangeFor([], 0, 300);
    expect(range).toMatchObject({ startIndex: 0, endIndex: 0, totalHeightPx: 0 });
  });
});

describe("the row window — the priors", () => {
  it("ignores a measurement inside the epsilon, and takes one outside it", () => {
    const rowWindow = new RowWindow();
    rowWindow.measure("row-0", 240);
    expect(rowWindow.measure("row-0", 240 + LEDGER_GEOMETRY_EPSILON_PX / 2)).toBe(false);
    expect(rowWindow.measure("row-0", 240 + LEDGER_GEOMETRY_EPSILON_PX * 4)).toBe(true);
  });

  it("refuses a measurement that is not a height", () => {
    const rowWindow = new RowWindow();
    expect(rowWindow.measure("row-0", Number.NaN)).toBe(false);
    expect(rowWindow.measure("row-0", -12)).toBe(false);
    expect(rowWindow.measuredRowCount).toBe(0);
  });

  it("bounds the prior table, evicting the least recently measured", () => {
    const rowWindow = new RowWindow({ measurementCap: 3 });
    for (const rowKey of keys(6)) {
      rowWindow.measure(rowKey, 200);
    }
    expect(rowWindow.measuredRowCount).toBe(3);
    // The oldest priors are gone, so those rows fall back to the estimate.
    expect(rowWindow.offsetOf(keys(6), 1)).toBe(LEDGER_ROW_HEIGHT_ESTIMATE_PX);
  });

  it("discards every prior when the display changes under it", () => {
    const rowWindow = new RowWindow();
    rowWindow.setDisplaySettings({ devicePixelRatio: 2, rootFontSizePx: 16 });
    rowWindow.measure("row-0", 240);
    expect(rowWindow.measuredRowCount).toBe(1);
    rowWindow.setDisplaySettings({ devicePixelRatio: 2, rootFontSizePx: 18 });
    expect(rowWindow.measuredRowCount).toBe(0);
  });

  it("negative control: an unchanged display keeps them", () => {
    const rowWindow = new RowWindow();
    rowWindow.setDisplaySettings({ devicePixelRatio: 2, rootFontSizePx: 16 });
    rowWindow.measure("row-0", 240);
    rowWindow.setDisplaySettings({ devicePixelRatio: 2, rootFontSizePx: 16 });
    expect(rowWindow.measuredRowCount).toBe(1);
  });

  it("forgets one row's prior on request, for a row the window pruned", () => {
    const rowWindow = new RowWindow();
    rowWindow.measure("row-0", 240);
    rowWindow.forget("row-0");
    expect(rowWindow.offsetOf(["row-0", "row-1"], 1)).toBe(LEDGER_ROW_HEIGHT_ESTIMATE_PX);
  });
});

describe("the row window — degrading rather than discarding", () => {
  it("renders every row when two share a key, and counts the repeats", () => {
    const rowWindow = new RowWindow();
    rowWindow.measure("row-0", 300);
    const rowKeys = ["row-0", "row-0", "row-1"];
    const range = rowWindow.rangeFor(rowKeys, 0, 1000);
    expect(range.duplicateKeyCount).toBe(1);
    // The window is intact: three rows, the repeat at the estimate rather than
    // borrowing the first one's measurement.
    expect(range.endIndex).toBe(3);
    expect(range.totalHeightPx).toBe(300 + 2 * LEDGER_ROW_HEIGHT_ESTIMATE_PX);
  });

  it("negative control: distinct keys report no repeats", () => {
    const range = new RowWindow().rangeFor(keys(3), 0, 1000);
    expect(range.duplicateKeyCount).toBe(0);
  });

  it("clamps a total past the ceiling a browser can place, and says so", () => {
    // A tall estimate rather than a million rows: the claim is about the clamp, and
    // building the log that would reach it naturally would make the test the cost.
    const estimatedRowHeightPx = 1_000_000;
    const rowWindow = new RowWindow({ estimatedRowHeightPx });
    const rowCount = Math.ceil(LEDGER_MAX_ELEMENT_HEIGHT_PX / estimatedRowHeightPx) + 10;
    const range = rowWindow.rangeFor(keys(rowCount), 0, 300);
    expect(range.isClampedToElementCeiling).toBe(true);
    expect(range.totalHeightPx).toBe(LEDGER_MAX_ELEMENT_HEIGHT_PX);
  });
});
