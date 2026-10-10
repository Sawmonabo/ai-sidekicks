// The diff's rows laid out in Chromium, in the flow and in Review: both draw one line of the
// same type on rows of the same height, and their line-number gutters, the flow's one of the new
// file's numbers and Review's two columns, are each as many figures wide as its file's widest
// number at the current text size, and never under two.

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installMeridianTokens } from "#renderer/app/token-installation.js";
import { DiffRenderer } from "#renderer/features/repos/diff/components/DiffRenderer.js";
import {
  diffOf,
  drawDiffCard,
  filePatch,
} from "#renderer/features/repos/diff/components/InlineDiffCard.test-support.js";
import type { DiffViewMode } from "#renderer/features/repos/diff/model.js";
import { liveBridgeWrapper, withAnnouncer } from "#test/helpers/app/frame-fixtures.js";

/** A short file, whose numbers take one figure, and one whose widest number takes five. */
const SHORT_AND_LONG = diffOf([
  filePatch("short.ts", "@@ -3,2 +3,2 @@", [" kept", "-gone", "+came"]),
  filePatch("long.ts", "@@ -12340,1 +12340,3 @@", [" kept", "+one", "+two"]),
]);

beforeEach(() => {
  installMeridianTokens(document);
});

afterEach(() => {
  cleanup();
});

describe("browser — the diff's rows", () => {
  it("draws the flow's rows and Review's in one type and rhythm: 12 px lines on 18 px rows", () => {
    const { card } = drawDiffCard(SHORT_AND_LONG, { heightPx: 600, widthPx: 420 });
    const scroller = drawReview("unified");
    const flowRow = card.querySelector<HTMLElement>(".meridian-diff__row--line");
    const reviewRow = scroller.querySelector<HTMLElement>(".meridian-diff__row--line");
    if (flowRow === null || reviewRow === null) {
      throw new Error("a look drew no line row");
    }
    // At the default text size, a line of `text-12` at the body line height, as the design sets a
    // diff in both.
    for (const row of [flowRow, reviewRow]) {
      expect(getComputedStyle(row).fontSize).toBe("12px");
      expect(row.getBoundingClientRect().height).toBe(18);
    }
  });

  it("draws the flow's one gutter as wide as its widest number, a removed line at its old number", () => {
    const { card } = drawDiffCard(SHORT_AND_LONG, { heightPx: 600, widthPx: 420 });
    const [shortBlock, longBlock] = card.querySelectorAll<HTMLElement>(".meridian-diff-block");
    if (shortBlock === undefined || longBlock === undefined) {
      throw new Error("the card drew fewer than two blocks");
    }
    const digitWidthPx = digitAdvancePx(shortBlock);
    // One gutter per row, never two; two characters at least, and five for 12342.
    for (const [block, digits] of [
      [shortBlock, 2],
      [longBlock, 5],
    ] as const) {
      for (const row of block.querySelectorAll(".meridian-diff__row--line")) {
        const gutters = row.querySelectorAll<HTMLElement>(".meridian-diff__flow-gutter");
        expect(gutters).toHaveLength(1);
        expect(row.querySelectorAll(".meridian-diff__gutter")).toHaveLength(0);
        const gutter = gutters[0] as HTMLElement;
        expect(Number.parseFloat(getComputedStyle(gutter).width)).toBeCloseTo(
          digits * digitWidthPx,
          1,
        );
        expect(getComputedStyle(gutter).userSelect).toBe("none");
      }
    }
    const numbers = [...shortBlock.querySelectorAll(".meridian-diff__flow-gutter")].map(
      (gutter) => gutter.textContent,
    );
    // The removed line keeps 4, its number in the old file; the added line takes 4 in the new.
    expect(numbers).toEqual(["3", "4", "4"]);
    const signs = [...shortBlock.querySelectorAll(".meridian-diff__sign")].map(
      (sign) => sign.textContent,
    );
    expect(signs).toEqual(["", "−", "+"]);
  });

  it("sizes Review's columns, both halves of a split row alike, from each file's widest number", () => {
    for (const viewMode of ["unified", "split"] as const) {
      const scroller = drawReview(viewMode);
      const digitWidthPx = digitAdvancePx(scroller);
      // Each line row's columns, by the file the row belongs to: two figures for the short file
      // and five for the long one, on both sides of every row.
      const widthsByFile = [...scroller.querySelectorAll<HTMLElement>(".meridian-diff__row--line")]
        .map((row) =>
          [...row.querySelectorAll<HTMLElement>(".meridian-diff__gutter")].map(
            (gutter) => Number.parseFloat(getComputedStyle(gutter).width) / digitWidthPx,
          ),
        )
        .map((figures) => figures.map((figure) => Math.round(figure * 10) / 10));
      expect(widthsByFile, viewMode).toEqual(
        viewMode === "unified"
          ? [
              [2, 2],
              [2, 2],
              [2, 2],
              [5, 5],
              [5, 5],
              [5, 5],
            ]
          : [
              [2, 2],
              [2, 2],
              [5, 5],
              [5, 5],
              [5, 5],
            ],
      );
      cleanup();
    }
  });
});

/** Review's renderer over the two files, in a pane tall enough to draw every row. */
function drawReview(viewMode: DiffViewMode): HTMLElement {
  const Wrapper = withAnnouncer(liveBridgeWrapper());
  const { container } = render(
    <Wrapper>
      <div style={{ display: "flex", blockSize: 600, inlineSize: 760 }}>
        <DiffRenderer
          model={SHORT_AND_LONG}
          viewMode={viewMode}
          expansion={new Map()}
          onExpandGap={() => undefined}
          label="Diff, main to feature"
        />
      </div>
    </Wrapper>,
  );
  const scroller = container.querySelector<HTMLElement>(".meridian-diff");
  if (scroller === null) {
    throw new Error("Review drew no diff");
  }
  return scroller;
}

/** One digit's advance in the rows' own face and size, measured beside them. */
function digitAdvancePx(rowsHolder: HTMLElement): number {
  const rows = rowsHolder.querySelector<HTMLElement>(".meridian-diff-block__rows") ?? rowsHolder;
  const probe = document.createElement("span");
  probe.textContent = "0000000000";
  rows.append(probe);
  const widthPx = probe.getBoundingClientRect().width / 10;
  probe.remove();
  return widthPx;
}
