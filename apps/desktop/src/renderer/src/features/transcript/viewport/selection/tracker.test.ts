// The viewport selection tracker over a real happy-dom document, which fires `selectionchange`
// itself whenever the selection's range is replaced. A migration is simulated by replacing a row's
// inner HTML with markup holding the same characters, which is what a settled block becoming a
// static subtree does to the nodes a selection was anchored in.

import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { resolveTextPosition } from "./preservation.js";
import { ViewportSelectionTracker } from "./tracker.js";

const ROW_MARKUP = "<p>The first settled paragraph.</p><p>The volatile tail is still growing.</p>";

/**
 * A scroll container of two rows the tracker knows, attached as the viewport attaches it, in a
 * log of those two rows.
 */
interface TrackedViewport {
  readonly firstRow: HTMLElement;
  readonly secondRow: HTMLElement;
  readonly tracker: ViewportSelectionTracker;
}

function mountTrackedViewport(): TrackedViewport {
  const scrollContainer = document.createElement("div");
  const [firstRow, secondRow] = [document.createElement("div"), document.createElement("div")];
  for (const row of [firstRow, secondRow]) {
    row.innerHTML = ROW_MARKUP;
    scrollContainer.append(row);
  }
  document.body.append(scrollContainer);
  const rowKeys = ["first-row", "second-row"];
  const tracker = new ViewportSelectionTracker({
    holdSelectedRows: () => {},
    logPositionOf: (rowKey) => rowKeys.indexOf(rowKey),
    drawRow: () => {},
  });
  tracker.attach(scrollContainer);
  onTestFinished(() => {
    tracker.detach();
  });
  tracker.addRow(firstRow, "first-row");
  tracker.addRow(secondRow, "second-row");
  return { firstRow, secondRow, tracker };
}

/** The text of an element outside the viewport, placed before or after it in the document. */
function mountOutsideText(placement: "before" | "after"): Text {
  const outside = document.createElement("p");
  outside.textContent = "a different part of the window";
  if (placement === "before") {
    document.body.prepend(outside);
  } else {
    document.body.append(outside);
  }
  return outside.firstChild as Text;
}

/** The text node and offset a character offset into `row` names. */
function positionIn(row: HTMLElement, characterOffset: number): readonly [Text, number] {
  const position = resolveTextPosition(row, characterOffset);
  if (position === undefined) {
    throw new Error("positionIn: the row holds no text");
  }
  return [position.textNode, position.offsetInNode];
}

function select(
  [anchorNode, anchorOffset]: readonly [Node, number],
  [focusNode, focusOffset]: readonly [Node, number],
): void {
  const selection = window.getSelection();
  if (selection === null) {
    throw new Error("select: this document has no selection");
  }
  selection.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
}

/** Select `[start, end)` of the row's own text, by character offset. */
function selectInRow(row: HTMLElement, start: number, end: number): void {
  select(positionIn(row, start), positionIn(row, end));
}

/** Replace the row's nodes with different nodes holding the same characters. */
function migrateBlocks(row: HTMLElement): void {
  row.innerHTML = "";
  row.innerHTML = ROW_MARKUP;
}

/**
 * The selected text while both ends sit in `container`'s live nodes, else `undefined`. A detached
 * range still reads its old text, so the text alone cannot show a restore happened.
 */
function selectedTextIn(container: Node): string | undefined {
  const selection = window.getSelection();
  const anchorNode = selection?.anchorNode ?? null;
  const focusNode = selection?.focusNode ?? null;
  if (anchorNode === null || focusNode === null) {
    return undefined;
  }
  return container.contains(anchorNode) && container.contains(focusNode)
    ? selection?.toString()
    : undefined;
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

describe("ViewportSelectionTracker — a selection inside a row", () => {
  it("puts a selection back after the row's nodes are replaced", () => {
    const { firstRow, tracker } = mountTrackedViewport();
    selectInRow(firstRow, 4, 9);
    expect(selectedTextIn(firstRow)).toBe("first");
    // A commit that migrated nothing writes nothing, so it never fights a drag still under way.
    expect(tracker.restoreAfterFlush(firstRow)).toBe(false);

    migrateBlocks(firstRow);
    // The condition a migration produces: the selection's nodes are off the document. An engine
    // may keep the detached range rather than collapse it, so the restore reads the anchor's
    // connectedness.
    expect(window.getSelection()?.anchorNode?.isConnected).toBe(false);
    expect(selectedTextIn(firstRow)).toBeUndefined();

    expect(tracker.restoreAfterFlush(firstRow)).toBe(true);
    expect(selectedTextIn(firstRow)).toBe("first");
  });

  it("restores only the row selected in last, and no row once the selection leaves", () => {
    const { firstRow, secondRow, tracker } = mountTrackedViewport();
    selectInRow(firstRow, 4, 9);
    selectInRow(secondRow, 10, 17);

    // One commit migrates both rows. The first row's old selection must not come back over the
    // one the reader has made since.
    migrateBlocks(firstRow);
    migrateBlocks(secondRow);
    expect(tracker.restoreAfterFlush(firstRow)).toBe(false);
    expect(tracker.restoreAfterFlush(secondRow)).toBe(true);
    expect(selectedTextIn(secondRow)).toBe("settled");

    // Negative control: a selection elsewhere is the reader's, and no row pulls it back.
    const outsideText = mountOutsideText("after");
    select([outsideText, 2], [outsideText, 11]);
    migrateBlocks(secondRow);
    expect(tracker.restoreAfterFlush(firstRow)).toBe(false);
    expect(tracker.restoreAfterFlush(secondRow)).toBe(false);
    expect(selectedTextIn(outsideText)).toBe("different");
  });

  it("puts a selection back in its own block after the window lets a block above it go", () => {
    const { firstRow, tracker } = mountTrackedViewport();
    firstRow.innerHTML = [
      "<div data-markdown-block='0'><p>An opening block.</p></div>",
      "<div data-markdown-block='1'><p>The selected block.</p></div>",
    ].join("");
    const selectedBlock = firstRow.lastElementChild as HTMLElement;
    selectInRow(selectedBlock, 4, 12);
    expect(selectedTextIn(firstRow)).toBe("selected");

    // The window draws a spacer in the first block's place and the selected block anew.
    firstRow.firstElementChild?.replaceWith(document.createElement("div"));
    selectedBlock.innerHTML = "<p>The selected block.</p>";

    expect(tracker.restoreAfterFlush(firstRow)).toBe(true);
    expect(selectedTextIn(firstRow)).toBe("selected");
  });

  it("reads and restores nothing once detached", () => {
    const { firstRow, tracker } = mountTrackedViewport();
    selectInRow(firstRow, 4, 9);
    tracker.detach();

    selectInRow(firstRow, 10, 17);
    migrateBlocks(firstRow);

    expect(tracker.restoreAfterFlush(firstRow)).toBe(false);
    expect(tracker.selectionRange).toBeUndefined();
  });
});

describe("ViewportSelectionTracker — the selection's range", () => {
  it("tells subscribers the range of a selection starting or ending in the scroller, and when it leaves", () => {
    const { firstRow, secondRow, tracker } = mountTrackedViewport();
    const textBefore = mountOutsideText("before");
    const listener = vi.fn();
    const unsubscribe = tracker.subscribe(listener);

    // Across two rows: no row holds it whole, but the range is the reader's.
    const [startNode, startOffset] = positionIn(firstRow, 4);
    const [endNode, endOffset] = positionIn(secondRow, 9);
    select([startNode, startOffset], [endNode, endOffset]);
    expect(listener).toHaveBeenCalledTimes(1);
    // By identity: both rows hold the same characters, so a structural match cannot tell them
    // apart.
    expect(tracker.selectionRange?.startContainer).toBe(startNode);
    expect(tracker.selectionRange?.startOffset).toBe(startOffset);
    expect(tracker.selectionRange?.endContainer).toBe(endNode);
    expect(tracker.selectionRange?.endOffset).toBe(endOffset);

    // Starting before the scroller and ending in it still counts.
    select([textBefore, 0], [endNode, endOffset]);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(tracker.selectionRange?.startContainer).toBe(textBefore);
    expect(tracker.selectionRange?.endContainer).toBe(endNode);

    // Leaving the scroller is a change subscribers hear about.
    select([textBefore, 2], [textBefore, 11]);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(tracker.selectionRange).toBeUndefined();

    // A change wholly outside, after one already outside, moves nothing.
    select([textBefore, 0], [textBefore, 5]);
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
    selectInRow(firstRow, 4, 9);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(tracker.selectionRange).toBeDefined();
  });
});
