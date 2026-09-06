// The four residuals the adopted virtualizer does not cover, driven as arithmetic.
//
// No DOM here on purpose: every claim is about the priors and the key projection, and
// a shim that answers zero for every rect would make each of them pass vacuously. The
// two residuals the LIBRARY answers — the total size's documented cost and the absent
// hit test per scroll event — are asserted where the library is actually bound, in
// `viewport-controller.test.ts` and `scroll-chokepoint.test.ts`.

import { describe, expect, it } from "vitest";

import { LEDGER_MAX_ELEMENT_HEIGHT_PX } from "../../../core/index.js";
import { LEDGER_GEOMETRY_EPSILON_PX, LEDGER_ROW_HEIGHT_ESTIMATE_PX } from "../frame-bounds.js";
import { RowMeasurementLedger } from "./row-measurement-ledger.js";

function keys(count: number, prefix = "row"): readonly string[] {
  return Array.from({ length: count }, (_unused, index) => `${prefix}-${String(index)}`);
}

describe("the measurement ledger — accepting a height", () => {
  it("estimates a row it has never measured, and reports one it has", () => {
    const ledger = new RowMeasurementLedger();
    expect(ledger.heightOf("row-0")).toBe(LEDGER_ROW_HEIGHT_ESTIMATE_PX);
    expect(ledger.acceptedHeight("row-0", 240)).toBe(240);
    expect(ledger.heightOf("row-0")).toBe(240);
  });

  it("holds the previous height for an observation inside the epsilon", () => {
    // The library's own compare is exact, so without this a streaming row's last-bit
    // wobble would invalidate its measurement cache on every frame.
    const ledger = new RowMeasurementLedger();
    ledger.acceptedHeight("row-0", 240);
    expect(ledger.acceptedHeight("row-0", 240 + LEDGER_GEOMETRY_EPSILON_PX / 2)).toBe(240);
  });

  it("negative control: an observation outside the epsilon is taken", () => {
    const ledger = new RowMeasurementLedger();
    ledger.acceptedHeight("row-0", 240);
    const observed = 240 + LEDGER_GEOMETRY_EPSILON_PX * 4;
    expect(ledger.acceptedHeight("row-0", observed)).toBe(observed);
  });

  it("refuses an observation that is not a height, and keeps what it had", () => {
    // An element that has not been laid out reports zero. Taking that as a row's
    // height collapses every offset below it onto the same pixel.
    const ledger = new RowMeasurementLedger();
    expect(ledger.acceptedHeight("row-0", 0)).toBe(LEDGER_ROW_HEIGHT_ESTIMATE_PX);
    expect(ledger.acceptedHeight("row-0", Number.NaN)).toBe(LEDGER_ROW_HEIGHT_ESTIMATE_PX);
    expect(ledger.measuredRowCount).toBe(0);
    ledger.acceptedHeight("row-0", 240);
    expect(ledger.acceptedHeight("row-0", 0)).toBe(240);
  });

  it("bounds the prior table, evicting the least recently measured", () => {
    const ledger = new RowMeasurementLedger({ measurementCap: 3 });
    for (const rowKey of keys(6)) {
      ledger.acceptedHeight(rowKey, 200);
    }
    expect(ledger.measuredRowCount).toBe(3);
    // The oldest priors are gone, so those rows fall back to the estimate.
    expect(ledger.heightOf("row-0")).toBe(LEDGER_ROW_HEIGHT_ESTIMATE_PX);
    expect(ledger.heightOf("row-5")).toBe(200);
  });

  it("forgets one row's prior on request, for a row the window pruned", () => {
    const ledger = new RowMeasurementLedger();
    ledger.acceptedHeight("row-0", 240);
    ledger.forget("row-0");
    expect(ledger.heightOf("row-0")).toBe(LEDGER_ROW_HEIGHT_ESTIMATE_PX);
  });
});

describe("the measurement ledger — the display validity key", () => {
  it("discards every prior when the display changes under it, and says so", () => {
    const ledger = new RowMeasurementLedger();
    ledger.setDisplaySettings({ devicePixelRatio: 2, rootFontSizePx: 16 });
    ledger.acceptedHeight("row-0", 240);
    expect(ledger.measuredRowCount).toBe(1);
    expect(ledger.setDisplaySettings({ devicePixelRatio: 2, rootFontSizePx: 18 })).toBe(true);
    expect(ledger.measuredRowCount).toBe(0);
  });

  it("negative control: an unchanged display keeps them, and reports no change", () => {
    const ledger = new RowMeasurementLedger();
    ledger.setDisplaySettings({ devicePixelRatio: 2, rootFontSizePx: 16 });
    ledger.acceptedHeight("row-0", 240);
    expect(ledger.setDisplaySettings({ devicePixelRatio: 2, rootFontSizePx: 16 })).toBe(false);
    expect(ledger.measuredRowCount).toBe(1);
  });
});

describe("the measurement ledger — degrading rather than discarding", () => {
  it("gives a repeated key a key of its own, and counts the repeat", () => {
    // The library's measurement and element caches are keyed by item key, so two
    // rows sharing one key means the second displaces the first — one row on screen
    // where the projection sent two.
    const ledger = new RowMeasurementLedger();
    const projection = ledger.projectKeys(["row-0", "row-0", "row-1"]);
    expect(projection.duplicateKeyCount).toBe(1);
    expect(projection.virtualKeys).toHaveLength(3);
    expect(new Set(projection.virtualKeys).size).toBe(3);
    expect(projection.virtualKeys[0]).toBe("row-0");
  });

  it("negative control: distinct keys are passed through untouched", () => {
    const ledger = new RowMeasurementLedger();
    const rowKeys = keys(3);
    const projection = ledger.projectKeys(rowKeys);
    expect(projection.duplicateKeyCount).toBe(0);
    expect(projection.virtualKeys).toStrictEqual(rowKeys);
  });

  it("caches the projection against the array's identity", () => {
    const ledger = new RowMeasurementLedger();
    const rowKeys = keys(4);
    expect(ledger.projectKeys(rowKeys)).toBe(ledger.projectKeys(rowKeys));
    expect(ledger.projectKeys(keys(4))).not.toBe(ledger.projectKeys(rowKeys));
  });
});

describe("the measurement ledger — the element ceiling", () => {
  /**
   * A ledger holding `rowCount` rows of `heightPx` each, and the total that implies.
   *
   * The total is computed here from the same two numbers the ledger was told, rather
   * than passed in as a third: the virtualizer's sum and this ledger's walk are the
   * same arithmetic over the same measurements, and a case that fed them different
   * figures would be measuring its own setup.
   */
  function ledgerOfRows(
    rowCount: number,
    heightPx: number,
  ): {
    readonly ledger: RowMeasurementLedger;
    readonly rowKeys: readonly string[];
    readonly totalHeightPx: number;
  } {
    const ledger = new RowMeasurementLedger({ measurementCap: rowCount });
    const rowKeys = keys(rowCount);
    for (const rowKey of rowKeys) {
      ledger.acceptedHeight(rowKey, heightPx);
    }
    return { ledger, rowKeys, totalHeightPx: rowCount * heightPx };
  }

  it("counts the rows whose own top sits past the tallest box a browser places", () => {
    // Four rows, each a third of the ceiling: the first three tops are inside it and
    // the fourth is not, so exactly one row is unreachable however far a person
    // scrolls. The total is past the ceiling, which is what makes the count worth
    // taking at all.
    const third = Math.ceil(LEDGER_MAX_ELEMENT_HEIGHT_PX / 3);
    const { ledger, rowKeys, totalHeightPx } = ledgerOfRows(4, third);
    expect(totalHeightPx).toBeGreaterThan(LEDGER_MAX_ELEMENT_HEIGHT_PX);
    expect(ledger.rowsPastElementCeiling(rowKeys, totalHeightPx)).toBe(1);
  });

  it("counts every row below the first one past it, not only that row", () => {
    const third = Math.ceil(LEDGER_MAX_ELEMENT_HEIGHT_PX / 3);
    const { ledger, rowKeys, totalHeightPx } = ledgerOfRows(9, third);
    expect(ledger.rowsPastElementCeiling(rowKeys, totalHeightPx)).toBe(6);
  });

  it("negative control: a window inside the ceiling has lost nothing", () => {
    const { ledger, rowKeys, totalHeightPx } = ledgerOfRows(4, LEDGER_ROW_HEIGHT_ESTIMATE_PX);
    expect(totalHeightPx).toBeLessThan(LEDGER_MAX_ELEMENT_HEIGHT_PX);
    expect(ledger.rowsPastElementCeiling(rowKeys, totalHeightPx)).toBe(0);
  });

  it("counts nothing for a row that merely straddles the ceiling", () => {
    // The narrower claim, and the true one: a row whose top is inside the ceiling is
    // drawn from that top down and is still reachable, so reporting it lost would
    // name a loss nobody has. Two rows, the second starting just inside.
    const justInside = Math.floor(LEDGER_MAX_ELEMENT_HEIGHT_PX / 2);
    const { ledger, rowKeys, totalHeightPx } = ledgerOfRows(2, justInside + 2);
    expect(totalHeightPx).toBeGreaterThan(LEDGER_MAX_ELEMENT_HEIGHT_PX);
    expect(ledger.rowsPastElementCeiling(rowKeys, totalHeightPx)).toBe(0);
  });
});
