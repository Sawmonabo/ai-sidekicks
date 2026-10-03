// The row selection guard over a real happy-dom document. A migration is simulated by replacing the
// row's inner HTML with markup holding the same characters, which is what a settled block
// becoming a static subtree does to the nodes a selection was anchored in.

import { afterEach, describe, expect, it } from "vitest";

import {
  RowSelectionGuard,
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

describe("RowSelectionGuard", () => {
  it("puts a selection back after the row's nodes are replaced", () => {
    const row = mountRow();
    const guard = new RowSelectionGuard(selectionDocument());
    guard.observe(row);

    selectRange(row, 4, 9);
    expect(selectedText()).toBe("first");

    migrateBlocks(row);
    // The condition a migration produces: the selection's nodes are off the document. An engine
    // may keep the detached range rather than collapse it, so the guard reads the anchor's
    // connectedness.
    expect(window.getSelection()?.anchorNode?.isConnected).toBe(false);

    expect(guard.restoreAfterFlush(guard.generation)).toBe(true);
    expect(selectedText()).toBe("first");

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

    // Negative control: the guard holds nothing here, so the migration cannot pull a selection
    // back into a row the reader has left.
    expect(guard.snapshot).toBeUndefined();
    migrateBlocks(row);
    expect(guard.restoreAfterFlush(guard.generation)).toBe(false);
    expect(selectedText()).toBe("diffe");

    otherRow.remove();
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
