// The row selection guard, driven over a real jsdom document.
//
// The migration is simulated the way the block layer performs one: the row's inner
// HTML is replaced with markup holding the SAME characters, which is exactly what a
// settled block becoming a memoised static subtree does to the nodes a selection was
// anchored in.

import { afterEach, describe, expect, it } from "vitest";

import {
  RowSelectionGuard,
  characterOffsetWithin,
  resolveTextPosition,
  type SelectionDocument,
} from "./selection-preservation.js";

const ROW_MARKUP = "<p>The first settled paragraph.</p><p>The volatile tail is still growing.</p>";

let mountedRow: HTMLElement | undefined;

function mountRow(): HTMLElement {
  const row = document.createElement("div");
  row.innerHTML = ROW_MARKUP;
  document.body.append(row);
  mountedRow = row;
  return row;
}

/** Select `[start, end)` of the row's own text, by character offset. */
function selectRange(row: HTMLElement, start: number, end: number): void {
  const anchor = resolveTextPosition(row, start);
  const focus = resolveTextPosition(row, end);
  if (anchor === undefined || focus === undefined) {
    throw new Error("selectRange: the row holds no text to select");
  }
  const selection = window.getSelection();
  if (selection === null) {
    throw new Error("selectRange: this document has no selection");
  }
  selection.setBaseAndExtent(
    anchor.textNode,
    anchor.offsetInNode,
    focus.textNode,
    focus.offsetInNode,
  );
  document.dispatchEvent(new Event("selectionchange"));
}

/** Replace the row's nodes with different nodes holding the same characters. */
function migrateBlocks(row: HTMLElement): void {
  row.innerHTML = "";
  row.innerHTML = ROW_MARKUP;
}

function selectedText(): string {
  return window.getSelection()?.toString() ?? "";
}

const selectionDocument = (): SelectionDocument => document as unknown as SelectionDocument;

afterEach(() => {
  mountedRow?.remove();
  mountedRow = undefined;
  window.getSelection()?.removeAllRanges();
});

describe("characterOffsetWithin", () => {
  it("measures a text position from the start of the row", () => {
    const row = mountRow();
    const secondParagraphText = row.children[1]?.firstChild;
    expect(secondParagraphText).toBeDefined();

    expect(characterOffsetWithin(row, secondParagraphText as Node, 4)).toBe(
      "The first settled paragraph.".length + 4,
    );
  });

  it("returns undefined for a position outside the row", () => {
    const row = mountRow();
    const outsider = document.createElement("p");
    outsider.textContent = "another row";
    document.body.append(outsider);

    expect(characterOffsetWithin(row, outsider.firstChild, 2)).toBeUndefined();

    outsider.remove();
  });
});

describe("RowSelectionGuard", () => {
  it("puts a selection back after the row's nodes are replaced", () => {
    const row = mountRow();
    const guard = new RowSelectionGuard(selectionDocument());
    guard.observe(row);

    selectRange(row, 4, 9);
    expect(selectedText()).toBe("first");

    migrateBlocks(row);
    // What a migration does to a selection, stated as the condition rather than as a
    // rendering of it: the nodes the selection is anchored in are off the document.
    // A browser collapses at this point; jsdom keeps reporting the detached range, and
    // the guard reads the anchor's connectedness rather than either behaviour.
    expect(window.getSelection()?.anchorNode?.isConnected).toBe(false);

    expect(guard.restoreAfterFlush(guard.generation)).toBe(true);
    expect(selectedText()).toBe("first");

    guard.dispose();
  });

  it("preserves a selection that spans two blocks", () => {
    const row = mountRow();
    const guard = new RowSelectionGuard(selectionDocument());
    guard.observe(row);
    const firstParagraphLength = "The first settled paragraph.".length;

    selectRange(row, firstParagraphLength - 10, firstParagraphLength + 8);
    const held = selectedText();
    expect(held).toContain("paragraph.");

    migrateBlocks(row);
    guard.restoreAfterFlush(guard.generation);

    expect(selectedText()).toBe(held);

    guard.dispose();
  });

  it("holds nothing for a caret, so a migration writes no selection", () => {
    const row = mountRow();
    const guard = new RowSelectionGuard(selectionDocument());
    guard.observe(row);

    const caret = resolveTextPosition(row, 6);
    expect(caret).toBeDefined();
    window
      .getSelection()
      ?.setBaseAndExtent(
        (caret as { textNode: Text }).textNode,
        (caret as { offsetInNode: number }).offsetInNode,
        (caret as { textNode: Text }).textNode,
        (caret as { offsetInNode: number }).offsetInNode,
      );
    document.dispatchEvent(new Event("selectionchange"));

    expect(guard.snapshot).toBeUndefined();
    migrateBlocks(row);
    expect(guard.restoreAfterFlush(guard.generation)).toBe(false);

    guard.dispose();
  });

  it("holds nothing for a selection that left the row", () => {
    const row = mountRow();
    const guard = new RowSelectionGuard(selectionDocument());
    guard.observe(row);
    selectRange(row, 4, 9);
    expect(guard.snapshot).toBeDefined();

    const otherRow = document.createElement("div");
    otherRow.textContent = "a different row entirely";
    document.body.append(otherRow);
    const otherText = otherRow.firstChild;
    window.getSelection()?.setBaseAndExtent(otherText as Node, 2, otherText as Node, 7);
    document.dispatchEvent(new Event("selectionchange"));

    // The negative control for "a selection is preserved": this guard now holds
    // nothing, so the migration below cannot pull the reader's selection back into a
    // row they have left.
    expect(guard.snapshot).toBeUndefined();
    migrateBlocks(row);
    expect(guard.restoreAfterFlush(guard.generation)).toBe(false);
    expect(selectedText()).toBe("diffe");

    otherRow.remove();
    guard.dispose();
  });

  it("writes nothing when the selection survived the commit", () => {
    const row = mountRow();
    const guard = new RowSelectionGuard(selectionDocument());
    guard.observe(row);
    selectRange(row, 4, 9);

    expect(guard.restoreAfterFlush(guard.generation)).toBe(false);
    expect(selectedText()).toBe("first");

    guard.dispose();
  });

  it("refuses a restore guarded by a stale generation", () => {
    const row = mountRow();
    const guard = new RowSelectionGuard(selectionDocument());
    guard.observe(row);
    selectRange(row, 4, 9);
    const staleGeneration = guard.generation;

    const replacementRow = mountRow();
    guard.observe(replacementRow);
    migrateBlocks(replacementRow);

    expect(guard.restoreAfterFlush(staleGeneration)).toBe(false);

    guard.dispose();
  });

  it("re-observing the same element keeps the snapshot", () => {
    const row = mountRow();
    const guard = new RowSelectionGuard(selectionDocument());
    guard.observe(row);
    selectRange(row, 4, 9);
    const generation = guard.generation;

    guard.observe(row);

    expect(guard.generation).toBe(generation);
    expect(guard.snapshot).toBeDefined();

    guard.dispose();
  });

  it("stops listening once disposed", () => {
    const row = mountRow();
    const guard = new RowSelectionGuard(selectionDocument());
    guard.observe(row);
    guard.dispose();

    selectRange(row, 4, 9);

    expect(guard.snapshot).toBeUndefined();
    expect(guard.restoreAfterFlush(guard.generation)).toBe(false);
  });
});
