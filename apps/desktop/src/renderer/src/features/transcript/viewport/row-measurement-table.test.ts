// The ledger's residuals as arithmetic, with no DOM: a shim answering zero for every rect would
// make each claim pass vacuously. The library's own answers are asserted in
// `viewport-controller.test.ts` and `scroll-chokepoint.test.ts`.

import { describe, expect, it } from "vitest";

import { TRANSCRIPT_ROW_HEIGHT_ESTIMATE_PX } from "./viewport-constants.js";
import { RowMeasurementTable } from "./row-measurement-table.js";

function keys(count: number, prefix = "row"): readonly string[] {
  return Array.from({ length: count }, (_unused, index) => `${prefix}-${String(index)}`);
}

describe("the measurement ledger — accepting a height", () => {
  it("refuses an observation that is not a height, and keeps what it had", () => {
    // An unlaid-out element reports zero; taking it collapses every offset below onto one pixel.
    const ledger = new RowMeasurementTable();
    expect(ledger.acceptedHeight("row-0", 0)).toBe(TRANSCRIPT_ROW_HEIGHT_ESTIMATE_PX);
    expect(ledger.acceptedHeight("row-0", Number.NaN)).toBe(TRANSCRIPT_ROW_HEIGHT_ESTIMATE_PX);
    expect(ledger.measuredRowCount).toBe(0);
    ledger.acceptedHeight("row-0", 240);
    expect(ledger.acceptedHeight("row-0", 0)).toBe(240);
  });

  it("bounds the prior table, evicting the least recently measured", () => {
    const ledger = new RowMeasurementTable({ measurementCap: 3 });
    for (const rowKey of keys(6)) {
      ledger.acceptedHeight(rowKey, 200);
    }
    expect(ledger.measuredRowCount).toBe(3);
    expect(ledger.heightOf("row-0")).toBe(TRANSCRIPT_ROW_HEIGHT_ESTIMATE_PX);
    expect(ledger.heightOf("row-5")).toBe(200);
  });
});

describe("the measurement ledger — the display validity key", () => {
  it("discards every prior when the display changes under it, and says so", () => {
    const ledger = new RowMeasurementTable();
    ledger.setDisplaySettings({ devicePixelRatio: 2, rootFontSizePx: 16 });
    ledger.acceptedHeight("row-0", 240);
    expect(ledger.measuredRowCount).toBe(1);
    expect(ledger.setDisplaySettings({ devicePixelRatio: 2, rootFontSizePx: 18 })).toBe(true);
    expect(ledger.measuredRowCount).toBe(0);
  });
});

describe("the measurement ledger — the idle trim", () => {
  it("forgets every prior but the rows named, answering how many went", () => {
    const ledger = new RowMeasurementTable();
    for (const rowKey of ["row-a", "row-b", "row-c"]) {
      ledger.acceptedHeight(rowKey, 40);
    }
    expect(ledger.forgetAllExcept(["row-b"])).toBe(2);
    expect(ledger.measuredRowCount).toBe(1);
    expect(ledger.heightOf("row-b")).toBe(40);
  });
});
