// One cell's lines are filled by a `CellLines` reused cell after cell, so a cell measured after
// another must fill exactly the lines a fresh one fills: nothing the last cell left, its filled
// lines, its open line, a break it allowed or a taller kind of line, carries over.

import { describe, expect, it } from "vitest";

import { CellLines, type TableLineHeights } from "./cell-lines.js";

const LINE_HEIGHTS: TableLineHeights = { plain: 20, code: 22, footnote: 21, ideograph: 24 };

/**
 * Each character 10 pixels wide; a space ends a word, a `#` is a code character, and a hyphen
 * inside a word allows a break after it, as a cell's text is fed.
 */
function fillCell(lines: CellLines, widthPx: number, text: string): number {
  lines.start(widthPx);
  for (const character of text) {
    if (character === " ") {
      lines.placeSpace(10);
    } else {
      lines.addCharacter(10, character === "#" ? "code" : "plain");
      if (character === "-" && !lines.isWordStart) {
        lines.endSegment();
      }
    }
  }
  return lines.finish();
}

describe("a cell's lines, filled by one reused cell after cell", () => {
  it("fills each cell as a fresh one does, whatever the cell before it left", () => {
    // The first cell wraps, ends on a code line and a space that allows a break; the second's word
    // is wider than its width, so a break left allowed would start it on a line of its own. The
    // third ends mid-word, so the fourth's hyphen would seem to sit inside a word and break after.
    // The last word outgrows the buffer a word's characters are first held in.
    const cells = [
      { widthPx: 60, text: "aaaa bbbb cccc ## " },
      { widthPx: 30, text: "dddddddd" },
      { widthPx: 200, text: "ee" },
      { widthPx: 40, text: "-cccccc" },
      { widthPx: 300, text: "f".repeat(70) },
    ];
    const reused = new CellLines(LINE_HEIGHTS);
    const reusedHeightsPx = cells.map((cell) => fillCell(reused, cell.widthPx, cell.text));
    const freshHeightsPx = cells.map((cell) =>
      fillCell(new CellLines(LINE_HEIGHTS), cell.widthPx, cell.text),
    );

    expect(reusedHeightsPx).toStrictEqual(freshHeightsPx);
    expect(freshHeightsPx).toStrictEqual([82, 60, 20, 40, 60]);
  });
});
