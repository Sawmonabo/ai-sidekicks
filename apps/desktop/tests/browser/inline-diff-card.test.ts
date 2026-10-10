// The transcript's diff card drawn in Chromium, inside a scrolling flow of a known height. Each
// file's rows sit in the flow itself: nothing in the card scrolls either way, a long token wraps,
// the rows stop at a third of the flow with a fade at the cut, at the current text size, and the
// footer counts the lines drawn beside `Show all` and `Copy patch`, both drawn as links.
// `Show all` draws every row and leaves the footer. The rows wear the flow's look: a separator
// where lines are skipped and never the `@@` spelling; a file with no lines says what changed where
// they would be; and past two screens of blocks the files fold.

import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installMeridianTokens } from "#renderer/app/token-installation.js";
import {
  DIFF_CARD,
  diffOf,
  drawDiffCard,
  filePatch,
} from "#renderer/features/repos/diff/components/InlineDiffCard.test-support.js";
import type { DiffInlineCardProps } from "#renderer/registries/inline-cards/registry.js";
import type { DiffModel } from "#renderer/features/repos/diff/model.js";
import { letObserversAnswer } from "../helpers/animation-frame.js";

/** The flow's visible height, in CSS pixels, standing in for the transcript's scroller. */
const FLOW_HEIGHT_PX = 600;

/** The changed lines of the long file. */
const LINE_COUNT = 40;

/** The line carrying the long token, below the cut. */
const LONG_TOKEN_LINE = 30;

beforeEach(() => {
  installMeridianTokens(document);
});

afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty("font-size");
});

describe("browser — the transcript's diff card", () => {
  it("draws a third of the flow in the flow, faded at the cut, under the footer", async () => {
    const { card, block } = renderCard(DIFF_CARD, diffOf([longFile()]));
    const rowsBox = block.querySelector<HTMLElement>(".meridian-diff-block__rows");
    const footer = block.querySelector<HTMLElement>(".meridian-diff-block__footer");
    if (rowsBox === null || footer === null) {
      throw new Error("the block drew no rows or footer");
    }

    // No header rows: as many lines as a third of the flow holds.
    const rowHeightPx = drawnRowHeightPx(rowsBox);
    const fittingRows = Math.floor(FLOW_HEIGHT_PX / 3 / rowHeightPx);
    expect(rowsBox.querySelectorAll('[role="row"]')).toHaveLength(fittingRows);
    expect(rowsBox.getBoundingClientRect().height).toBeCloseTo(fittingRows * rowHeightPx, 1);
    expect(footer.textContent).toBe(
      `${String(fittingRows)} of ${String(LINE_COUNT)} lines·Show all·Copy patch`,
    );
    // `Copy patch` is drawn as the footer's link `Show all` is: the accent's text, no underline
    // at rest.
    const [showAll, copyPatch] = footer.querySelectorAll<HTMLButtonElement>("button");
    if (showAll === undefined || copyPatch === undefined) {
      throw new Error("the footer drew fewer than two controls");
    }
    const accentText = resolvedColor("var(--meridian-accent-text)");
    for (const control of [showAll, copyPatch]) {
      expect(getComputedStyle(control).color).toBe(accentText);
      expect(getComputedStyle(control).textDecorationLine).toBe("none");
      expect(getComputedStyle(control).fontSize).toBe(getComputedStyle(footer).fontSize);
    }
    expect(getComputedStyle(rowsBox, "::after").backgroundImage).toContain("linear-gradient");
    expectNoInnerScroller(card);

    fireEvent.click(footer.querySelector("button") as HTMLButtonElement);
    await vi.waitFor(() => {
      expect(rowsBox.querySelectorAll('[role="row"]')).toHaveLength(LINE_COUNT);
    });
    expect(footer.textContent).toBe(
      `${String(LINE_COUNT)} of ${String(LINE_COUNT)} lines·Copy patch`,
    );
    expect(rowsBox.classList).not.toContain("meridian-diff-block__rows--cut");
    expectNoInnerScroller(card);

    // The unbreakable token, once scrolled to, wraps inside its row rather than running past the
    // row's edge.
    const longCode = [...rowsBox.querySelectorAll<HTMLElement>(".meridian-diff__code")].find(
      (code) => (code.textContent ?? "").includes("x".repeat(200)),
    );
    const flow = card.parentElement;
    if (longCode === undefined || flow === null) {
      throw new Error("the card drew no row for the long token");
    }
    flow.scrollTop = longCode.offsetTop;
    await vi.waitFor(() => {
      expect(longCode.getBoundingClientRect().height).toBeGreaterThan(rowHeightPx);
    });
    expect(longCode.scrollWidth).toBeLessThanOrEqual(longCode.clientWidth);
  });

  it("cuts at as many rows as a third of the flow holds at the current text size", async () => {
    document.documentElement.style.fontSize = "20px";
    const { block } = renderCard(DIFF_CARD, diffOf([longFile()]));
    const rowsBox = block.querySelector<HTMLElement>(".meridian-diff-block__rows") as HTMLElement;
    const rowHeightsPx: number[] = [];
    for (const textSizePx of [20, 12]) {
      if (textSizePx !== 20) {
        await act(async () => {
          document.documentElement.style.fontSize = `${String(textSizePx)}px`;
          await letObserversAnswer();
        });
      }
      // The cut holds exactly as many rows as a third of the flow holds at their drawn height.
      const rowHeightPx = drawnRowHeightPx(rowsBox);
      const fittingRows = Math.floor(FLOW_HEIGHT_PX / 3 / rowHeightPx);
      expect(rowsBox.querySelectorAll('[role="row"]')).toHaveLength(fittingRows);
      expect(rowsBox.getBoundingClientRect().height).toBeCloseTo(fittingRows * rowHeightPx, 1);
      rowHeightsPx.push(rowHeightPx);
    }
    // And the rows are drawn at a height that follows the text size.
    expect((rowHeightsPx[0] ?? 0) / (rowHeightsPx[1] ?? 1)).toBeCloseTo(20 / 12, 2);
  });

  it("keeps a file with no lines its header, and writes what changed where its lines would be", () => {
    const binaryPatch = [
      "diff --git a/assets/logo.png b/assets/logo.png",
      "index 1a2b3c4..5d6e7f8 100644",
      "Binary files a/assets/logo.png and b/assets/logo.png differ",
      "",
    ].join("\n");
    const renamePatch = [
      "diff --git a/docs/before.md b/docs/after.md",
      "similarity index 100%",
      "rename from docs/before.md",
      "rename to docs/after.md",
      "",
    ].join("\n");
    const { card } = renderCard(DIFF_CARD, diffOf([binaryPatch, renamePatch]));
    const blocks = [...card.querySelectorAll<HTMLElement>(".meridian-diff-block")];
    expect(
      blocks.map((block) => ({
        header: block.querySelector(".meridian-diff__row--file")?.textContent,
        rows: block.querySelectorAll('[role="row"]').length,
        note: block.querySelector(".meridian-diff-block__note")?.textContent,
        footer: block.querySelector(".meridian-diff-block__footer")?.textContent,
      })),
    ).toEqual([
      {
        header: "assets/logo.png",
        rows: 1,
        note: "binary — contents not shown",
        footer: "Copy patch",
      },
      {
        header: "docs/after.md",
        rows: 1,
        note: "renamed from docs/before.md",
        footer: "Copy patch",
      },
    ]);
  });

  it("stands a separator where lines are skipped, and never shows the hunk's own spelling", () => {
    const { block } = renderCard(
      DIFF_CARD,
      diffOf([
        filePatch("two-hunks.ts", "@@ -1,2 +1,2 @@", [" a", "-b", "+B"], "@@ -40,2 +40,2 @@", [
          " y",
          "-z",
          "+Z",
        ]),
      ]),
    );
    const rows = [...block.querySelectorAll<HTMLElement>('[role="row"]')];
    // Three lines, the separator, three lines: the first hunk opens on its first line.
    expect(rows.map((row) => row.classList.contains("meridian-diff__row--separator"))).toEqual([
      false,
      false,
      false,
      true,
      false,
      false,
      false,
    ]);
    expect(block.textContent).not.toContain("@@");
    const separator = rows[3] as HTMLElement;
    expect(separator.querySelector("button")).toBeNull();
    expect(separator.querySelector(".meridian-diff__flow-gutter")).toBeNull();
  });

  it("folds the files past two screens of blocks into one footer", () => {
    const fileCount = 31;
    const files = Array.from({ length: fileCount }, (_unused, ordinal) =>
      filePatch(`handlers/file-${String(ordinal)}.ts`, "@@ -7,3 +7,3 @@", [" a", "-b", "+c", " d"]),
    );
    const { card } = renderCard(DIFF_CARD, diffOf(files));
    const blocks = [...card.querySelectorAll<HTMLElement>(".meridian-diff-block")];
    const fold = card.querySelector<HTMLElement>(".meridian-diff-card__fold");
    if (fold === null) {
      throw new Error("the card drew no fold footer");
    }
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.length).toBeLessThan(fileCount);
    expect(fold.textContent).toBe(
      `${String(fileCount - blocks.length)} more files changed·${String(fileCount)} total`,
    );
    // The blocks drawn fill two screens and one more would not fit.
    const first = (blocks[0] as HTMLElement).getBoundingClientRect();
    const last = (blocks.at(-1) as HTMLElement).getBoundingClientRect();
    const second = (blocks[1] as HTMLElement).getBoundingClientRect();
    const blockPitchPx = second.top - first.top;
    expect(last.bottom - first.top).toBeLessThanOrEqual(2 * FLOW_HEIGHT_PX);
    expect(last.bottom - first.top + blockPitchPx).toBeGreaterThan(2 * FLOW_HEIGHT_PX);
  });

  it("draws a compared pair in the flow too, with no scroller of its own", () => {
    const { card } = renderCard(
      { ...DIFF_CARD, baseRef: "main", headRef: "feature" },
      diffOf([longFile()]),
    );
    expect(card.querySelectorAll(".meridian-diff-block")).toHaveLength(1);
    expect(card.querySelector(".meridian-diff-pane")).toBeNull();
    expectNoInnerScroller(card);
  });
});

/** Draw the card in a flow of `FLOW_HEIGHT_PX`, and hand back the card and its first block. */
function renderCard(
  cardProps: DiffInlineCardProps,
  diff: DiffModel,
): { readonly card: HTMLElement; readonly block: HTMLElement } {
  const { card, block } = drawDiffCard(diff, {
    heightPx: FLOW_HEIGHT_PX,
    widthPx: 420,
    card: cardProps,
  });
  return { card, block };
}

/** The height the block's first row is drawn at, in CSS pixels. */
function drawnRowHeightPx(rowsBox: HTMLElement): number {
  return rowsBox.querySelector('[role="row"]')?.getBoundingClientRect().height ?? 0;
}

/** The color a value resolves to in the document, as computed styles report colors. */
function resolvedColor(value: string): string {
  const probe = document.createElement("span");
  probe.style.color = value;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

/** Nothing in the card scrolls up and down or sideways: the flow is the one scroller. */
function expectNoInnerScroller(card: HTMLElement): void {
  for (const element of [card, ...card.querySelectorAll<HTMLElement>("*")]) {
    const { overflowX, overflowY } = getComputedStyle(element);
    expect(["auto", "scroll"], element.className).not.toContain(overflowY);
    expect(["auto", "scroll"], element.className).not.toContain(overflowX);
  }
}

/** One file of changed lines, one past the cut carrying a token no word break can split. */
function longFile(): string {
  const body: string[] = [];
  for (let ordinal = 0; ordinal < LINE_COUNT; ordinal += 1) {
    body.push(
      ordinal === LONG_TOKEN_LINE
        ? `+const token = "${"x".repeat(400)}";`
        : `+const value${String(ordinal)} = compute(${String(ordinal)});`,
    );
  }
  return filePatch("module.ts", `@@ -0,0 +1,${String(LINE_COUNT)} @@`, body);
}
