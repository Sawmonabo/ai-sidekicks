// The transcript's diff card drawn in Chromium, inside a scrolling flow of a known height. Each
// file's rows sit in the flow itself: nothing in the card scrolls either way, a long token wraps,
// the rows stop at a third of the flow with a fade at the cut, and the footer counts the lines
// drawn beside `Show all` and `Copy patch`. `Show all` draws every row and leaves the footer. The
// rows wear the flow's look: one gutter as wide as its widest number, a separator where lines are
// skipped and never the `@@` spelling; and past two screens of blocks the files fold.

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { installMeridianTokens } from "#renderer/app/token-installation.js";
import { InlineDiffCard } from "#renderer/features/repos/diff/components/InlineDiffCard.js";
import { parseUnifiedPatch } from "#renderer/features/repos/diff/patch-parse.js";
import type { DiffModel } from "#renderer/features/repos/diff/model.js";
import { DIFF_ROW_HEIGHT_PX } from "#renderer/features/repos/diff/measures.js";
import type { DiffInlineCardProps } from "#renderer/registries/inline-cards/registry.js";
import { liveBridgeWrapper } from "#test/helpers/app/frame-fixtures.js";

/** The flow's visible height, in CSS pixels, standing in for the transcript's scroller. */
const FLOW_HEIGHT_PX = 600;

/** The changed lines of the long file. */
const LINE_COUNT = 40;

/** The line carrying the long token, below the cut. */
const LONG_TOKEN_LINE = 30;

/** A row's card props, naming no compared pair. */
const CARD: DiffInlineCardProps = {
  kind: "diff",
  runId: "run-1",
  diffArtifactId: "diff-artifact-1",
  artifactManifestId: "artifact-manifest-1",
};

afterEach(() => {
  cleanup();
});

describe("browser — the transcript's diff card", () => {
  it("draws a third of the flow in the flow, faded at the cut, under the footer", async () => {
    const { card, block } = renderCard(CARD, diffOf([longFile()]));
    const rowsBox = block.querySelector<HTMLElement>(".meridian-diff-block__rows");
    const footer = block.querySelector<HTMLElement>(".meridian-diff-block__footer");
    if (rowsBox === null || footer === null) {
      throw new Error("the block drew no rows or footer");
    }

    // No header rows: as many lines as a third of the flow holds.
    const fittingRows = Math.floor(FLOW_HEIGHT_PX / 3 / DIFF_ROW_HEIGHT_PX);
    expect(rowsBox.querySelectorAll('[role="row"]')).toHaveLength(fittingRows);
    expect(rowsBox.getBoundingClientRect().height).toBe(fittingRows * DIFF_ROW_HEIGHT_PX);
    expect(footer.textContent).toBe(
      `${String(fittingRows)} of ${String(LINE_COUNT)} lines·Show all·Copy patch`,
    );
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
      expect(longCode.getBoundingClientRect().height).toBeGreaterThan(DIFF_ROW_HEIGHT_PX);
    });
    expect(longCode.scrollWidth).toBeLessThanOrEqual(longCode.clientWidth);
  });

  it("draws one gutter as wide as the widest number, a removed line at its old number", () => {
    const { card } = renderCard(
      CARD,
      diffOf([
        filePatch("short.ts", "@@ -3,2 +3,2 @@", [" kept", "-gone", "+came"]),
        filePatch("long.ts", "@@ -12340,1 +12340,3 @@", [" kept", "+one", "+two"]),
      ]),
    );
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

  it("stands a separator where lines are skipped, and never shows the hunk's own spelling", () => {
    const { block } = renderCard(
      CARD,
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
    const { card } = renderCard(CARD, diffOf(files));
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
      { ...CARD, baseRef: "main", headRef: "feature" },
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
  installMeridianTokens(document);
  const BridgeHost = liveBridgeWrapper();
  const { container } = render(
    <BridgeHost>
      <div style={{ blockSize: FLOW_HEIGHT_PX, inlineSize: 420, overflowY: "auto" }}>
        <InlineDiffCard card={cardProps} diff={diff} />
      </div>
    </BridgeHost>,
  );
  const card = container.querySelector<HTMLElement>(".meridian-diff-card");
  const block = card?.querySelector<HTMLElement>(".meridian-diff-block");
  if (card === null || block === null || block === undefined) {
    throw new Error("the card drew no block");
  }
  return { card, block };
}

/** Nothing in the card scrolls up and down or sideways: the flow is the one scroller. */
function expectNoInnerScroller(card: HTMLElement): void {
  for (const element of [card, ...card.querySelectorAll<HTMLElement>("*")]) {
    const { overflowX, overflowY } = getComputedStyle(element);
    expect(["auto", "scroll"], element.className).not.toContain(overflowY);
    expect(["auto", "scroll"], element.className).not.toContain(overflowX);
  }
}

/** One digit's advance in the rows' own face and size, measured beside them. */
function digitAdvancePx(block: HTMLElement): number {
  const rows = block.querySelector<HTMLElement>(".meridian-diff-block__rows") as HTMLElement;
  const probe = document.createElement("span");
  probe.textContent = "0000000000";
  rows.append(probe);
  const widthPx = probe.getBoundingClientRect().width / 10;
  probe.remove();
  return widthPx;
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

/** One file's patch: its headers, then each hunk header followed by its prefixed lines. */
function filePatch(path: string, ...hunks: readonly (string | readonly string[])[]): string {
  const lines = [`--- ${path}`, `+++ ${path}`];
  for (const hunk of hunks) {
    lines.push(...(typeof hunk === "string" ? [hunk] : hunk));
  }
  return [...lines, ""].join("\n");
}

/** The diff of the given file patches, each file carrying its own patch for `Copy patch`. */
function diffOf(filePatches: readonly string[]): DiffModel {
  const files = filePatches.map((patch) => {
    const parsed = parseUnifiedPatch(patch, { baseRef: "main", headRef: "feature" });
    const [file] = parsed.files;
    if (file === undefined) {
      throw new Error("a test patch parsed to no file");
    }
    return { ...file, patch };
  });
  return { baseRef: "main", headRef: "feature", files };
}
