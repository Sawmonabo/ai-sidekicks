// The terminal pane's own box, measured against the space the chrome gives it. happy-dom
// returns zeroes from every `getBoundingClientRect` and resolves no custom property, so "the
// pane body is exactly as tall as its cell" would pass there against a body of any height.
//
// The rule is one line of CSS: with the content box sized to its cell and the padding added
// outside it, the body would overhang the cell by twice the pane padding and the emulator's
// last rows would fall off the bottom, invisible in a screenshot of the pane's top.
//
// The cell is two boxes deep because the frame is `PaneFrame`'s: the pane layout sizes the
// chrome's `<section>`, the chrome gives its body a flex region under the head, and the terminal
// pane's box grows into that. The body's box must spend its padding inside what the section
// left it.

import { describe, expect, it } from "vitest";

import { mountTerminalPaneInGridCell } from "./in-grid-cell.js";

/** A pane layout cell of a fixed height, which is the only case the rule is about. */
const LAYOUT_CELL_HEIGHT_PX = 400;

describe("browser — the terminal pane's padding is inside its height", () => {
  it("fits its cell exactly, rather than overhanging it by its own padding", async () => {
    const { layoutCell, frame, body, bodyRegion } =
      await mountTerminalPaneInGridCell(LAYOUT_CELL_HEIGHT_PX);

    expect(layoutCell.getBoundingClientRect().height).toBe(LAYOUT_CELL_HEIGHT_PX);
    expect(frame.getBoundingClientRect().height).toBe(LAYOUT_CELL_HEIGHT_PX);
    expect(body.getBoundingClientRect().height).toBe(bodyRegion.getBoundingClientRect().height);
  });

  it("leaves the head its own height rather than covering it", async () => {
    // A body that filled the whole section (`block-size: 100%` against the frame rather than a
    // flex grow against the region under the head) would satisfy the case above while drawing
    // over the breadcrumb the pane is named by.
    const { frame, bodyRegion } = await mountTerminalPaneInGridCell(LAYOUT_CELL_HEIGHT_PX);

    expect(bodyRegion.getBoundingClientRect().height).toBeLessThan(
      frame.getBoundingClientRect().height,
    );
  });
});
