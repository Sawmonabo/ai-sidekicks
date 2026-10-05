// The measurement table's residuals as arithmetic, with no DOM: a shim answering zero for every
// rect would make each claim pass vacuously. The library's own answers are asserted in
// `viewport-controller.test.ts` and `chokepoint.test.ts`.

import { describe, expect, it } from "vitest";

import { TRANSCRIPT_ROW_HEIGHT_ESTIMATE_PX } from "./constants.js";
import { RowMeasurementTable } from "./row-measurement-table.js";

function keys(count: number, prefix = "row"): readonly string[] {
  return Array.from({ length: count }, (_unused, index) => `${prefix}-${String(index)}`);
}

describe("the measurement table — accepting a height", () => {
  it("refuses an observation that is not a height, and keeps what it had", () => {
    // An unlaid-out element reports zero; taking it collapses every offset below onto one pixel.
    const table = new RowMeasurementTable();
    expect(table.acceptedHeight("row-0", 0)).toBe(TRANSCRIPT_ROW_HEIGHT_ESTIMATE_PX);
    expect(table.acceptedHeight("row-0", Number.NaN)).toBe(TRANSCRIPT_ROW_HEIGHT_ESTIMATE_PX);
    expect(table.heightOf("row-0")).toBe(TRANSCRIPT_ROW_HEIGHT_ESTIMATE_PX);
    table.acceptedHeight("row-0", 240);
    expect(table.acceptedHeight("row-0", 0)).toBe(240);
  });

  it("bounds the prior table, evicting the least recently measured", () => {
    const table = new RowMeasurementTable({ measurementCap: 3 });
    for (const rowKey of keys(6)) {
      table.acceptedHeight(rowKey, 200);
    }
    expect(table.heightOf("row-2")).toBe(TRANSCRIPT_ROW_HEIGHT_ESTIMATE_PX);
    expect(table.heightOf("row-3")).toBe(200);
    expect(table.heightOf("row-5")).toBe(200);
  });
});

describe("the measurement table — the display validity key", () => {
  it("discards every prior when the display changes under it, and says so", () => {
    const table = new RowMeasurementTable();
    table.setDisplaySettings({ devicePixelRatio: 2, rootFontSizePx: 16 });
    table.acceptedHeight("row-0", 240);
    expect(table.heightOf("row-0")).toBe(240);
    expect(table.setDisplaySettings({ devicePixelRatio: 2, rootFontSizePx: 18 })).toBe(true);
    expect(table.heightOf("row-0")).toBe(TRANSCRIPT_ROW_HEIGHT_ESTIMATE_PX);
  });
});

describe("the measurement table — the idle trim", () => {
  it("forgets every prior but the rows named", () => {
    const table = new RowMeasurementTable();
    for (const rowKey of ["row-a", "row-b", "row-c"]) {
      table.acceptedHeight(rowKey, 40);
    }
    table.forgetAllExcept(["row-b"]);
    expect(table.heightOf("row-a")).toBe(TRANSCRIPT_ROW_HEIGHT_ESTIMATE_PX);
    expect(table.heightOf("row-c")).toBe(TRANSCRIPT_ROW_HEIGHT_ESTIMATE_PX);
    expect(table.heightOf("row-b")).toBe(40);
  });
});
