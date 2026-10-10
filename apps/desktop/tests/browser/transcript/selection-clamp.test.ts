// The viewport's selection record against the engine's own selection, in the engine that paints
// it: a drag's selection, real shift-arrows and text replaced under an end, and the record settling
// once per selection under real keys, which a DOM shim cannot answer. Rows are plain elements the
// case mounts and lets go itself, as the window does, so each case reads the record after the
// browser has moved its own selection.

import { afterEach, describe, expect, it } from "vitest";

import { nextFrame } from "../../helpers/animation-frame.js";
import {
  SELECT_ALL,
  SHIFT_ARROW_RIGHT,
  SHIFT_PAGE_DOWN,
  SHIFT_WORD_RIGHT,
  pressKey,
  sendKey,
} from "../../helpers/system-keys.js";

import { resolveTextPosition } from "#renderer/features/transcript/viewport/selection/preservation.js";
import type { RowSelectionBoundary } from "#renderer/features/transcript/viewport/selection/record.js";
import { ViewportSelectionTracker } from "#renderer/features/transcript/viewport/selection/tracker.js";

const ROW_COUNT = 14;
/** The scroller's height for a page step: a few lines, so a page lands inside the log. */
const SCROLLER_HEIGHT_PX = 120;
/** Each row's text, long enough that an end sits well inside it. */
const rowTextOf = (index: number): string => `Row ${String(index)} says a few words of its own.`;

/** A scroller of rows the tracker knows, and the case's own hand on which rows are drawn. */
interface TrackedRows {
  readonly tracker: ViewportSelectionTracker;
  readonly scrollContainer: HTMLElement;
  readonly row: (index: number) => HTMLElement;
  /** Lets a row go as the window does: the tracker hears it while its nodes are still drawn. */
  readonly letGo: (index: number) => void;
  /** Draws a let-go row again in its place, as the window's commit does. */
  readonly drawAgain: (index: number) => void;
}

function mountTrackedRows(drawRow: (rowKey: string) => void = () => {}): TrackedRows {
  const scrollContainer = document.createElement("div");
  scrollContainer.style.width = "600px";
  scrollContainer.style.height = `${String(SCROLLER_HEIGHT_PX)}px`;
  scrollContainer.style.overflowY = "auto";
  scrollContainer.tabIndex = 0;
  document.body.append(scrollContainer);
  const rowKeys = Array.from({ length: ROW_COUNT }, (_, index) => `row-${String(index)}`);
  const rows = rowKeys.map((_, index) => {
    const row = document.createElement("div");
    const paragraph = document.createElement("p");
    paragraph.textContent = rowTextOf(index);
    row.append(paragraph);
    scrollContainer.append(row);
    return row;
  });
  const tracker = new ViewportSelectionTracker({
    holdSelectedRows: () => {},
    logPositionOf: (rowKey) => rowKeys.indexOf(rowKey),
    logEdgeRowKey: (side) => (side === "head" ? rowKeys[0] : rowKeys.at(-1)),
    drawRow,
  });
  tracker.attach(scrollContainer);
  rows.forEach((row, index) => {
    tracker.addRow(row, rowKeys[index] ?? expect.fail("a key per row"));
  });
  const row = (index: number): HTMLElement => rows[index] ?? expect.fail(`row ${String(index)}`);
  return {
    tracker,
    scrollContainer,
    row,
    letGo: (index) => {
      tracker.removeRow(row(index));
      row(index).remove();
    },
    drawAgain: (index) => {
      const following = rows.slice(index + 1).find((candidate) => candidate.isConnected);
      scrollContainer.insertBefore(row(index), following ?? null);
      tracker.addRow(row(index), rowKeys[index] ?? expect.fail("a key per row"));
      tracker.restoreAfterFlush(row(index));
    },
  };
}

/** The text node and offset `characterOffset` characters into a row. */
function pointIn(row: HTMLElement, characterOffset: number): readonly [Text, number] {
  const position = resolveTextPosition(row, characterOffset) ?? expect.fail("the row holds text");
  return [position.textNode, position.offsetInNode];
}

function select(
  [anchorRow, anchorOffset]: readonly [HTMLElement, number],
  [focusRow, focusOffset]: readonly [HTMLElement, number],
): void {
  const browserSelection = document.getSelection() ?? expect.fail("the page has a selection");
  browserSelection.setBaseAndExtent(
    ...pointIn(anchorRow, anchorOffset),
    ...pointIn(focusRow, focusOffset),
  );
}

/** Lets the browser report its selection changes, which it queues as a task. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  await nextFrame();
}

/** A boundary `characterOffset` characters into a row with no windowed element. */
function boundaryAt(index: number, characterOffset: number): RowSelectionBoundary {
  return { rowKey: `row-${String(index)}`, position: { path: [], characterOffset } };
}

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

describe("ViewportSelectionTracker — a clamped selection in the browser", () => {
  it("keeps a drag's start when its row is let go mid-drag", async () => {
    const { tracker, row, letGo } = mountTrackedRows();
    const browserSelection = document.getSelection() ?? expect.fail("the page has a selection");
    // A press, then the selection a drag's moves make: the browser extends it from its anchor.
    document.body.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }));
    select([row(1), 4], [row(3), 8]);
    await settle();

    // The row the drag started in leaves the window while the button is still held. The browser
    // keeps extending a drag only from a range: a caret makes its next move start a new one.
    letGo(1);
    await settle();
    expect(browserSelection.isCollapsed).toBe(false);
    expect(row(2).contains(browserSelection.anchorNode)).toBe(true);

    browserSelection.extend(...pointIn(row(4), 10));
    await settle();
    document.body.dispatchEvent(new PointerEvent("pointerup", { button: 0, bubbles: true }));

    expect(tracker.selection).toStrictEqual({ start: boundaryAt(1, 4), end: boundaryAt(4, 10) });
  });

  it("extends from a let-go start with a shift-arrow, keeping the start", async () => {
    const { tracker, row, letGo, scrollContainer } = mountTrackedRows();
    scrollContainer.focus();
    select([row(1), 3], [row(3), 3]);
    await settle();
    letGo(1);
    await settle();

    await pressKey(SHIFT_ARROW_RIGHT);
    await settle();

    expect(tracker.selection).toStrictEqual({ start: boundaryAt(1, 3), end: boundaryAt(3, 4) });
  });

  it("draws a let-go end's row before a shift-arrow moves that end", async () => {
    let drawAgain: (index: number) => void = () => {};
    // The window draws the row a frame or more after it is asked, once its screen is prepared.
    const tracked = mountTrackedRows(() => {
      requestAnimationFrame(() => {
        drawAgain(3);
      });
    });
    ({ drawAgain } = tracked);
    const { tracker, row, letGo } = tracked;
    tracked.scrollContainer.focus();
    select([row(1), 3], [row(3), 3]);
    await settle();
    letGo(3);
    await settle();

    await pressKey(SHIFT_ARROW_RIGHT);
    await settle();
    await settle();

    expect(row(3).isConnected).toBe(true);
    expect(tracker.selection).toStrictEqual({ start: boundaryAt(1, 3), end: boundaryAt(3, 4) });
  });

  // The page step, which the browser's own selection move lacks, past the end's row, and the word
  // step the host's text bindings name, Option on macOS and Control elsewhere, within it.
  it.each([
    ["a page", SHIFT_PAGE_DOWN, "leaves its row"],
    ["a word", SHIFT_WORD_RIGHT, "stays in its row"],
  ] as const)(
    "moves a let-go end %s from where it is, as the browser moves a drawn one",
    async (_, key, rowMove) => {
      // The browser's own step from the end while its row is drawn, as the oracle.
      const native = mountTrackedRows();
      native.scrollContainer.focus();
      select([native.row(1), 3], [native.row(2), 3]);
      await settle();
      await pressKey(key);
      await settle();
      const nativeSelection = native.tracker.selection ?? expect.fail("the step selected");
      expect(nativeSelection.end).not.toStrictEqual(boundaryAt(2, 3));
      expect(nativeSelection.end.rowKey === "row-2" ? "stays in its row" : "leaves its row").toBe(
        rowMove,
      );
      native.tracker.detach();
      document.getSelection()?.removeAllRanges();
      document.body.replaceChildren();

      let drawAgain: (index: number) => void = () => {};
      const tracked = mountTrackedRows(() => {
        requestAnimationFrame(() => {
          drawAgain(2);
        });
      });
      ({ drawAgain } = tracked);
      tracked.scrollContainer.focus();
      select([tracked.row(1), 3], [tracked.row(2), 3]);
      await settle();
      tracked.letGo(2);
      await settle();

      await pressKey(key);
      await settle();
      await settle();

      expect(tracked.tracker.selection).toStrictEqual(nativeSelection);
    },
  );

  it("keeps an end in place while the text it sits in is replaced as a reply grows", async () => {
    const { tracker, row } = mountTrackedRows();
    select([row(1), 3], [row(3), 10]);
    await settle();
    const textNode = row(3).querySelector("p")?.firstChild;
    if (!(textNode instanceof Text)) {
      throw new Error("the row draws its text as one node");
    }

    // A rendered text update replaces the node's whole data, which moves an end inside it to 0.
    textNode.data = `${textNode.data} More words arrive.`;
    await settle();

    expect(tracker.selection).toStrictEqual({ start: boundaryAt(1, 3), end: boundaryAt(3, 10) });
    const liveRange = document.getSelection()?.getRangeAt(0) ?? expect.fail("a range is shown");
    expect([liveRange.endContainer, liveRange.endOffset]).toStrictEqual([textNode, 10]);
  });
});

describe("ViewportSelectionTracker — a selection settling under real keys", () => {
  it("settles a held shift-arrow once, at the arrow's release, after all its repeats", async () => {
    const { tracker, row, scrollContainer } = mountTrackedRows();
    scrollContainer.focus();
    select([row(1), 3], [row(1), 5]);
    await settle();
    let settledCount = 0;
    tracker.subscribeToSettledSelection(() => {
      settledCount += 1;
    });

    // The arrow goes down once and repeats three times while it is held, each move reported
    // before the next repeat, as a held key's repeats arrive.
    for (const isRepeat of [false, true, true, true]) {
      await sendKey(SHIFT_ARROW_RIGHT, "rawKeyDown", isRepeat);
      await settle();
    }
    expect(tracker.selection?.end).toStrictEqual(boundaryAt(1, 9));
    expect(settledCount).toBe(0);

    await sendKey(SHIFT_ARROW_RIGHT, "keyUp");
    await settle();
    expect(settledCount).toBe(1);
  });

  it("settles Select All once, at its key's release", async () => {
    const { tracker, scrollContainer } = mountTrackedRows();
    scrollContainer.focus();
    let settledCount = 0;
    tracker.subscribeToSettledSelection(() => {
      settledCount += 1;
    });

    await pressKey(SELECT_ALL);
    await settle();

    // The whole log, its head row to its tail row, each whole.
    expect(tracker.selection).toStrictEqual({
      start: { rowKey: "row-0", position: undefined },
      end: { rowKey: `row-${String(ROW_COUNT - 1)}`, position: undefined },
    });
    expect(settledCount).toBe(1);
  });
});
