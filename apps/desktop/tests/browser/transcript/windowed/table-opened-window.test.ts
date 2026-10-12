// A long table drawn in a window the app opened, whose document is not the one its script runs
// in. The faces load in the window's document alone, so a table that measured its text in the
// script's own document, or waited on that document's faces, would lay its rows out in the
// fallback font. Its own file, so no earlier case has loaded the faces in the script's document.

import { describe, expect, it } from "vitest";

import {
  benchTable,
  expectSameLayout,
  mountWithWhole,
  replyWith,
  scrollToRow,
  tablesOf,
} from "./long-table.js";

describe("browser — a long table drawn in a window the app opened", () => {
  it("lays its rows out in the window's own faces, at the whole table's widths and heights", async () => {
    const bodies = await mountWithWhole(replyWith(benchTable(300)), {
      isComplete: true,
      drawsInFrame: true,
    });
    expect(tablesOf(bodies).windowed.ownerDocument).not.toBe(document);
    expect(document.fonts.size).toBe(0);
    expectSameLayout(bodies, "at the top");
    await scrollToRow(bodies, 299);
    expectSameLayout(bodies, "at the last row");
  });
});
