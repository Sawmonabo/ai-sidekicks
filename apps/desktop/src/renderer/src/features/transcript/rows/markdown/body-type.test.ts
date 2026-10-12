// A block's and a long table's remembered geometry belong to the body's text size as well as its
// width: a body that keeps its width while its text grows wraps every line anew.

import { describe, expect, it } from "vitest";

import { type MarkdownBodyType } from "./body-type.js";
import { recallBlockGeometry, rememberBlockGeometry } from "./block-window/geometry-memory.js";
import { type TableCellType } from "./table-window/cell-measure.js";
import { recallTableGeometry, rememberTableGeometry } from "./table-window/geometry-memory.js";

const MEASURED_AT: MarkdownBodyType = { widthPx: 600, fontSizePx: 13, lineHeightPx: 19.5 };
const LARGER_TEXT: MarkdownBodyType = { widthPx: 600, fontSizePx: 16, lineHeightPx: 24 };

/** A cells' type, whose figures the memory files and never reads. */
const CELL_TYPE: TableCellType = {
  fontStyle: "normal",
  fontWeight: "400",
  fontSizePx: 13,
  fontFamily: "sans-serif",
  boldWeight: "700",
  italicStyle: "italic",
  codeFontFamily: "monospace",
  codeFontSizePx: 12,
  codeEdgePx: 4,
  footnoteFontSizePx: 10,
  footnoteEdgePx: 1,
  lineHeightsPx: { plain: 19.5, code: 19.5, footnote: 19.5, ideograph: 19.5 },
  rowChromePx: 9,
  cellChromePx: 16,
};

describe("geometry remembered at one text size", () => {
  it("is recalled at that size and never at another of the same width", () => {
    const block = { fingerprint: "block", isFinal: false };
    rememberBlockGeometry(
      { ...block, bodyType: MEASURED_AT },
      { heightPx: 40, topMarginPx: 0, bottomMarginPx: 8 },
    );
    expect(recallBlockGeometry({ ...block, bodyType: MEASURED_AT })?.heightPx).toBe(40);
    expect(recallBlockGeometry({ ...block, bodyType: LARGER_TEXT })).toBeUndefined();

    rememberTableGeometry(
      { tableKey: "table", bodyType: MEASURED_AT },
      {
        columns: { widthsPx: [300, 300], tableWidthPx: 600 },
        cellType: CELL_TYPE,
        rowHeightsPx: new Float32Array([29, 29]),
        sampleRowIndexes: [0],
      },
    );
    expect(recallTableGeometry({ tableKey: "table", bodyType: MEASURED_AT })).toBeDefined();
    expect(recallTableGeometry({ tableKey: "table", bodyType: LARGER_TEXT })).toBeUndefined();
  });
});
