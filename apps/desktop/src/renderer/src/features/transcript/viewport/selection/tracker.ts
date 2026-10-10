// One transcript viewport's record of the reader's selection, behind the viewport's only
// `selectionchange` listener. The record is the truth: each end is a row key and a position in that
// row's text (`preservation.ts`), so the selection outlives the rows it runs through leaving the
// window, and copy reads it rather than the browser's selection.
//   - The rows holding the two ends are held, so the window keeps them, and the virtualizer draws
//     them, while they sit within the let-go distance; the browser's selection is the reader's. An
//     end outside the scroller takes the log's edge row whole, holds nothing, and stays where the
//     reader put it.
//   - When an end's row is let go, the row is copied as drawn, for copy, and the browser's
//     selection is written as the record clamped to the drawn rows: that end stands at the edge of
//     the drawn rows the record covers, so the browser paints exactly the drawn part of the
//     selection with its own selection, in every state its own selection paints in. Each commit
//     that draws or lets go a row at that edge writes it again, and once the end's row is drawn
//     again the end is written where it is. A record covering no drawn row leaves a caret at the
//     scroller's start, where the browser paints nothing and still routes a copy here.
//   - A clamped end is the record's own end to the reader: a drag, a shift-click or a shift-press
//     that extends the browser's selection from it keeps the record's end. A shift-press that
//     would move a clamped end draws that end's row first and moves the end from where it is.
//   - A change the reader makes that leaves a caret (a click on text or empty space, focus moving
//     into a text field) clears the record, as it clears the browser's own selection.
//   - Select All with focus in the log selects the whole log, head row to tail row, held nowhere
//     and written clamped: the browser's own would select only the rows drawn.
//   - Text arriving in a row the browser's selection ends in replaces the text node an end sits
//     in, which moves that end to the node's start. An observer on those rows writes the record
//     back in the microtask after the change, before the browser reports it.
//   - Rows are known by their element, found by walking up from a selection's end, so a prune's
//     index shift or a windowed list nested in a row cannot mistake the owner.
//   - A caret inside the scroller is published as the range, so a window keeps the item holding it
//     drawn and a shift-click after a scroll extends from it, as the browser's own would.
//   - The listener returns early on a change it has already read or the tracker wrote itself.
//   - The record settles once per selection the reader makes, at the release of the press that
//     made it (`settling.ts`), for what acts on a finished selection rather than on each change.

import type { Unsubscribe } from "#shared/preload-api.js";
import {
  isAfter,
  rowEdgePoint,
  shownEndsOf,
  standsAtClampedEnd,
  type ClampedEnd,
  type ShownEnd,
} from "./clamp.js";
import { extendSelection, extensionOf, type SelectionExtension } from "./extension.js";
import {
  compareRowTextPositions,
  rowTextPositionOf,
  type RowTextPosition,
} from "./preservation.js";
import {
  otherSide,
  RECORD_SIDES,
  type RecordSide,
  type RowSelection,
  type RowSelectionBoundary,
  type SelectionPoint,
} from "./record.js";
import { SelectionSettling } from "./settling.js";

/** What the tracker asks of the viewport around it. */
export interface ViewportSelectionTrackerOptions {
  /** Holds exactly these rows for the selection, releasing every other; empty releases all. */
  readonly holdSelectedRows: (rowKeys: readonly string[]) => void;
  /** A row's position in the log the viewport was handed, or `undefined` for a key it lacks. */
  readonly logPositionOf: (rowKey: string) => number | undefined;
  /** The key of the log's first or last row, which an end outside the scroller takes. */
  readonly logEdgeRowKey: (side: "head" | "tail") => string | undefined;
  /** Draws a row the window let go and brings it into view, so an end in it can move. */
  readonly drawRow: (rowKey: string) => void;
}

/**
 * The selection in one viewport: its one `selectionchange` listener, the record of the selection
 * that copy reads, and the selection's range for anything inside the scroller that keeps its ends.
 */
export class ViewportSelectionTracker {
  readonly #options: ViewportSelectionTrackerOptions;
  readonly #rowKeyByElement = new Map<Node, string>();
  readonly #rowElementByKey = new Map<string, HTMLElement>();
  readonly #listeners = new Set<() => void>();
  readonly #recordListeners = new Set<() => void>();
  readonly #settling = new SelectionSettling(() => this.#selection !== undefined);
  /** The end rows as they were drawn when the window let them go, by row key. */
  readonly #letGoEndRows = new Map<string, Element>();
  readonly #endRowObserver: MutationObserver;
  /** The rows the observer watches: those the browser's selection ends in. */
  #observedRows: readonly Element[] = [];
  #scrollContainer: HTMLElement | undefined;
  #listening: AbortController | undefined;
  #selection: RowSelection | undefined;
  /** The end of the record the browser's anchor stands for: where the reader started it. */
  #anchorSide: RecordSide = "start";
  /** The ends the reader put outside the scroller, where the browser's selection keeps them. */
  #outsidePoints: Partial<Record<RecordSide, SelectionPoint>> = {};
  /** The ends standing at an edge of the drawn rows while their own rows are not drawn. */
  #clampedEnds: Partial<Record<RecordSide, ClampedEnd>> = {};
  /** The browser's selection as last read or written, so a change already seen is told apart. */
  #shown: ShownRange | undefined;
  /** A shift-press held until the row of the end it moves is drawn. */
  #pendingExtension:
    | { readonly rowKey: string; readonly extension: SelectionExtension }
    | undefined;
  #selectionRange: AbstractRange | undefined;
  /** Bumped when a row mounts or unmounts, so a clamp is written again only when rows moved. */
  #rowsRevision = 0;
  #clampedRowsRevision = -1;

  public constructor(options: ViewportSelectionTrackerOptions) {
    this.#options = options;
    this.#endRowObserver = new MutationObserver((records) => {
      this.#noteEndRowsChanged(records);
    });
  }

  /**
   * Starts reading the selection for `scrollContainer`: adds the viewport's one `selectionchange`
   * listener, the browser's Select All, the reader's presses, and the shift-presses that move an
   * end. Paired with `detach`.
   */
  public attach(scrollContainer: HTMLElement): void {
    const listening = new AbortController();
    const ownerDocument = scrollContainer.ownerDocument;
    const options = { capture: true, signal: listening.signal };
    ownerDocument.addEventListener(
      "selectionchange",
      () => {
        this.#readSelection(scrollContainer);
      },
      { signal: listening.signal },
    );
    // The browser's Select All, from a key or the Edit menu, starts its selection at the body; a
    // drag starts at the node pressed.
    ownerDocument.addEventListener(
      "selectstart",
      (event) => {
        const isFromRoot =
          event.target === ownerDocument.body || event.target === ownerDocument.documentElement;
        if (isFromRoot && scrollContainer.contains(ownerDocument.activeElement)) {
          event.preventDefault();
          this.selectWholeLog();
        }
      },
      options,
    );
    this.#settling.attach(ownerDocument, options);
    ownerDocument.addEventListener(
      "keydown",
      (event) => {
        this.#extendClampedEnd(event);
      },
      options,
    );
    this.#scrollContainer = scrollContainer;
    this.#listening = listening;
  }

  /**
   * Removes the listeners and drops the record, releasing its rows. Subscribers are not called:
   * they unmount with the viewport that detaches.
   */
  public detach(): void {
    this.#listening?.abort();
    this.#listening = undefined;
    if (this.#selection !== undefined) {
      this.#clearSelection();
    }
    this.#scrollContainer = undefined;
    this.#selectionRange = undefined;
  }

  /**
   * Selects the whole log, its head row to its tail row, each whole. Nothing is held, so the
   * window keeps its usual rows; the browser's selection is written clamped to the drawn rows.
   */
  public selectWholeLog(): void {
    const start = this.#logEdgeBoundary("head");
    const end = this.#logEdgeBoundary("tail");
    if (start === undefined || end === undefined) {
      return;
    }
    this.#setRecord({ start, end }, "start", {});
    this.#options.holdSelectedRows([]);
    this.#writeRecord();
    this.#settling.noteSelected();
  }

  /** Counts a mounted row's element under its key. Reads no selection. */
  public addRow(rowElement: HTMLElement, rowKey: string): void {
    this.#rowKeyByElement.set(rowElement, rowKey);
    this.#rowElementByKey.set(rowKey, rowElement);
    this.#letGoEndRows.delete(rowKey);
    this.#rowsRevision += 1;
  }

  /**
   * Forgets an unmounting row, while its nodes are still the ones it drew: an end row of the
   * record is copied for copy, and a browser's selection ending inside it is written again over
   * the rows that stay.
   */
  public removeRow(rowElement: HTMLElement): void {
    const rowKey = this.#rowKeyByElement.get(rowElement);
    const selection = this.#selection;
    if (
      selection !== undefined &&
      rowKey !== undefined &&
      anchoredRowKeys(selection).includes(rowKey)
    ) {
      this.#letGoEndRows.set(rowKey, rowElement.cloneNode(true) as Element);
    }
    this.#rowKeyByElement.delete(rowElement);
    if (rowKey !== undefined && this.#rowElementByKey.get(rowKey) === rowElement) {
      this.#rowElementByKey.delete(rowKey);
    }
    this.#rowsRevision += 1;
    if (selection !== undefined && this.#endsInside(rowElement)) {
      this.#writeRecord();
    }
  }

  /**
   * After a commit of `rowElement`: writes the browser's selection again from the record where a
   * remount lost it, where the drawn rows at a clamped end changed, or where a held shift-press's
   * row is now drawn. Answers whether it wrote. A commit that moved nothing writes nothing, so it
   * never fights a drag.
   */
  public restoreAfterFlush(rowElement: HTMLElement): boolean {
    const selection = this.#selection;
    if (selection === undefined) {
      return false;
    }
    const browserSelection = rowElement.ownerDocument.getSelection();
    if (browserSelection === null) {
      return false;
    }
    const rowKey = this.#rowKeyByElement.get(rowElement);
    const pending = this.#pendingExtension;
    if (pending !== undefined && pending.rowKey === rowKey) {
      this.#pendingExtension = undefined;
      return this.#applyExtension(browserSelection, pending.extension);
    }
    if (this.#isClamped()) {
      if (this.#clampedRowsRevision === this.#rowsRevision) {
        return false;
      }
      this.#clampedRowsRevision = this.#rowsRevision;
      return this.#writeRecord({ onlyWhenMoved: true });
    }
    if (
      (rowKey !== selection.start.rowKey && rowKey !== selection.end.rowKey) ||
      !this.#hasLost(browserSelection, selection)
    ) {
      return false;
    }
    return this.#writeRecord();
  }

  /**
   * Calls `listener` after each selection change that moves `selectionRange`: one that starts or
   * ends inside the scroller, and the one that takes the selection out of it.
   */
  public subscribe(listener: () => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Calls `listener` each time the record is taken or dropped, before anything else moves: the
   * rows its ends sit in are still in the log the viewport was handed.
   */
  public subscribeToRecord(listener: () => void): Unsubscribe {
    this.#recordListeners.add(listener);
    return () => {
      this.#recordListeners.delete(listener);
    };
  }

  /**
   * Calls `listener` once each time the recorded selection settles: at the release of the press,
   * of the pointer or a key, that changed it, or at once for a change no press made.
   */
  public subscribeToSettledSelection(listener: () => void): Unsubscribe {
    return this.#settling.subscribe(listener);
  }

  /**
   * The browser's selection range as of the last change, while it shows the record or is a caret
   * inside the scroller; otherwise `undefined`. While an end is clamped, the range runs from the
   * other end over its row only, so a window keeps drawn the items of a drawn end row a copy reads,
   * and none of the rows between. A new object for each change, so a reader can compare by
   * identity; a copy, so it never moves the selection, though its ends follow the nodes it holds.
   */
  public get selectionRange(): AbstractRange | undefined {
    return this.#selectionRange;
  }

  /** The reader's selection as recorded, or `undefined` when there is none in this viewport. */
  public get selection(): RowSelection | undefined {
    return this.#selection;
  }

  /**
   * The row an end of the selection sits in as it was drawn: the mounted row while it is drawn,
   * the copy taken as the window let it go otherwise. `undefined` for any other row.
   */
  public endRowElement(rowKey: string): Element | undefined {
    return this.#rowElementByKey.get(rowKey) ?? this.#letGoEndRows.get(rowKey);
  }

  #readSelection(scrollContainer: HTMLElement): void {
    const browserSelection = scrollContainer.ownerDocument.getSelection();
    if (browserSelection === null || this.#isShown(browserSelection)) {
      return;
    }
    const recorded = this.#selection;
    const extended =
      recorded === undefined
        ? undefined
        : this.#extendedFromClamp(recorded, browserSelection, scrollContainer);
    const read = extended ?? this.#freshSelectionOf(browserSelection, scrollContainer);
    if (read === undefined) {
      if (this.#selection !== undefined) {
        this.#clearSelection();
      }
      this.#shown = shownRangeOf(browserSelection);
      this.#publishCaret(browserSelection, scrollContainer);
      return;
    }
    this.#setRecord(read.selection, read.anchorSide, read.outsidePoints);
    this.#clampedEnds = read.clampedEnds;
    this.#shown = shownRangeOf(browserSelection);
    this.#options.holdSelectedRows(anchoredRowKeys(read.selection));
    this.#settling.noteSelected();
    // An extension kept a clamped end: the drawn rows on its side may call for another edge.
    if (extended !== undefined && this.#writeRecord({ onlyWhenMoved: true })) {
      return;
    }
    this.#observeEndRows(browserSelection);
    this.#publishShown(browserSelection);
  }

  /**
   * The record extended from a clamped end the browser's anchor stands at, by a drag, a
   * shift-click or a shift-press, to where the browser's focus is now; `undefined` when the anchor
   * stands at no clamped end, so the change is a selection of its own.
   */
  #extendedFromClamp(
    recorded: RowSelection,
    browserSelection: Selection,
    scrollContainer: HTMLElement,
  ): ReadSelection | undefined {
    const { anchorNode, focusNode } = browserSelection;
    if (browserSelection.isCollapsed || anchorNode === null || focusNode === null) {
      return undefined;
    }
    const anchor = { node: anchorNode, offset: browserSelection.anchorOffset };
    // The anchor's own end first: with no covered row drawn, both ends share one caret.
    const keptSide = [this.#anchorSide, otherSide(this.#anchorSide)].find((side) => {
      const clamped = this.#clampedEnds[side];
      return clamped !== undefined && standsAtClampedEnd(anchor, clamped);
    });
    const keptClamp = keptSide === undefined ? undefined : this.#clampedEnds[keptSide];
    if (keptSide === undefined || keptClamp === undefined) {
      return undefined;
    }
    const kept = recorded[keptSide];
    const keptOutside = this.#outsidePoints[keptSide];
    const isFocusFirst = isBackward(browserSelection);
    const focus = this.#endAt(
      { node: focusNode, offset: browserSelection.focusOffset },
      isFocusFirst ? "start" : "end",
      scrollContainer,
    );
    if (focus === undefined) {
      return undefined;
    }
    const isKeptFirst = !this.#isBefore(focus.boundary, kept);
    const [keptAs, focusAs]: readonly [RecordSide, RecordSide] = isKeptFirst
      ? ["start", "end"]
      : ["end", "start"];
    const outsidePoints: Partial<Record<RecordSide, SelectionPoint>> = {};
    if (keptOutside !== undefined) {
      outsidePoints[keptAs] = keptOutside;
    }
    if (focus.outsidePoint !== undefined) {
      outsidePoints[focusAs] = focus.outsidePoint;
    }
    const selection = isKeptFirst
      ? { start: kept, end: focus.boundary }
      : { start: focus.boundary, end: kept };
    // The browser may hold the clamped end at another point with no text between; the next
    // change is matched against the point it holds.
    const clampedEnds: Partial<Record<RecordSide, ClampedEnd>> = {};
    clampedEnds[keptAs] = { ...keptClamp, point: anchor };
    return { selection, anchorSide: keptAs, outsidePoints, clampedEnds };
  }

  /**
   * The record of a selection of the reader's own, or `undefined` when it is a caret or misses the
   * rows. A selection holding the whole scroller, both its ends outside, takes the whole log.
   */
  #freshSelectionOf(
    browserSelection: Selection,
    scrollContainer: HTMLElement,
  ): ReadSelection | undefined {
    if (browserSelection.isCollapsed || browserSelection.rangeCount === 0) {
      return undefined;
    }
    const liveRange = browserSelection.getRangeAt(0);
    const isStartInside = scrollContainer.contains(liveRange.startContainer);
    const isEndInside = scrollContainer.contains(liveRange.endContainer);
    if (!isStartInside && !isEndInside && !liveRange.intersectsNode(scrollContainer)) {
      return undefined;
    }
    const start = this.#endAt(
      { node: liveRange.startContainer, offset: liveRange.startOffset },
      "start",
      scrollContainer,
    );
    const end = this.#endAt(
      { node: liveRange.endContainer, offset: liveRange.endOffset },
      "end",
      scrollContainer,
    );
    if (start === undefined || end === undefined) {
      return undefined;
    }
    const outsidePoints: Partial<Record<RecordSide, SelectionPoint>> = {};
    if (start.outsidePoint !== undefined) {
      outsidePoints.start = start.outsidePoint;
    }
    if (end.outsidePoint !== undefined) {
      outsidePoints.end = end.outsidePoint;
    }
    return {
      selection: { start: start.boundary, end: end.boundary },
      anchorSide: isBackward(browserSelection) ? "end" : "start",
      outsidePoints,
      clampedEnds: {},
    };
  }

  /**
   * One end of the browser's selection as the record keeps it: the row boundary inside the
   * scroller, or the log's edge row whole and the point outside it where the reader put it.
   */
  #endAt(
    point: SelectionPoint,
    side: RecordSide,
    scrollContainer: HTMLElement,
  ):
    | { readonly boundary: RowSelectionBoundary; readonly outsidePoint?: SelectionPoint }
    | undefined {
    if (scrollContainer.contains(point.node)) {
      const boundary = this.#boundaryAt(point.node, point.offset, side);
      return boundary === undefined ? undefined : { boundary };
    }
    const boundary = this.#logEdgeBoundary(side === "start" ? "head" : "tail");
    return boundary === undefined ? undefined : { boundary, outsidePoint: point };
  }

  /**
   * The row boundary of one end of a range inside the scroller: the row holding it, or, for an end
   * between rows, the nearest row on the selection's side of it.
   */
  #boundaryAt(container: Node, offset: number, side: RecordSide): RowSelectionBoundary | undefined {
    for (let node: Node | null = container; node !== null; node = node.parentNode) {
      const rowKey = this.#rowKeyByElement.get(node);
      if (rowKey !== undefined) {
        return { rowKey, position: rowTextPositionOf(node, container, offset) };
      }
    }
    for (
      let node: Node | null | undefined =
        side === "start" ? container.childNodes[offset] : container.childNodes[offset - 1];
      node !== null && node !== undefined;
      node = side === "start" ? node.nextSibling : node.previousSibling
    ) {
      const rowKey = this.#rowKeyByElement.get(node);
      if (rowKey !== undefined) {
        const characterOffset = side === "start" ? 0 : (node.textContent?.length ?? 0);
        return { rowKey, position: { path: [], characterOffset } };
      }
    }
    return this.#logEdgeBoundary(side === "start" ? "head" : "tail");
  }

  /** The log's edge row on one side, taken whole. */
  #logEdgeBoundary(side: "head" | "tail"): RowSelectionBoundary | undefined {
    const rowKey = this.#options.logEdgeRowKey(side);
    return rowKey === undefined ? undefined : { rowKey, position: undefined };
  }

  /** Whether `first` comes before `second` in the log. */
  #isBefore(first: RowSelectionBoundary, second: RowSelectionBoundary): boolean {
    const firstPosition = this.#options.logPositionOf(first.rowKey) ?? 0;
    const secondPosition = this.#options.logPositionOf(second.rowKey) ?? 0;
    return (
      firstPosition < secondPosition ||
      (firstPosition === secondPosition &&
        compareRowTextPositions(first.position ?? ROW_START, second.position ?? ROW_START) < 0)
    );
  }

  /** Takes `selection` as the record, dropping the let-go end rows it no longer ends in. */
  #setRecord(
    selection: RowSelection,
    anchorSide: RecordSide,
    outsidePoints: Partial<Record<RecordSide, SelectionPoint>>,
  ): void {
    this.#selection = selection;
    this.#anchorSide = anchorSide;
    this.#outsidePoints = outsidePoints;
    const endRowKeys = anchoredRowKeys(selection);
    for (const rowKey of this.#letGoEndRows.keys()) {
      if (!endRowKeys.includes(rowKey)) {
        this.#letGoEndRows.delete(rowKey);
      }
    }
    this.#announceRecord();
  }

  /**
   * Writes the record as the browser's selection over the drawn rows, base on the end the reader
   * started from, so a drag under way keeps extending from it. With `onlyWhenMoved`, writes only
   * when an end now stands at a different drawn row, or none. Answers whether it wrote.
   */
  #writeRecord(options?: { readonly onlyWhenMoved: boolean }): boolean {
    const selection = this.#selection;
    const scrollContainer = this.#scrollContainer;
    const browserSelection = scrollContainer?.ownerDocument.getSelection() ?? null;
    if (selection === undefined || scrollContainer === undefined || browserSelection === null) {
      return false;
    }
    const shown = shownEndsOf(selection, {
      scrollContainer,
      rowElementByKey: this.#rowElementByKey,
      logPositionOf: this.#options.logPositionOf,
      outsidePoints: this.#outsidePoints,
    });
    if (options?.onlyWhenMoved === true && !this.#hasMoved(shown)) {
      return false;
    }
    this.#clampedRowsRevision = this.#rowsRevision;
    const anchorSide = this.#anchorSide;
    const focusSide = otherSide(anchorSide);
    const anchor = shown[anchorSide];
    const focus = shown[focusSide];
    if (isAfter(anchor.point, focus.point) !== (anchorSide === "end")) {
      // Both ends clamped over no drawn row cross; nothing drawn is selected.
      browserSelection.collapse(scrollContainer, 0);
      const caret: ClampedEnd = {
        container: scrollContainer,
        edge: "start",
        point: { node: scrollContainer, offset: 0 },
      };
      this.#clampedEnds = { start: caret, end: caret };
    } else {
      browserSelection.setBaseAndExtent(
        anchor.point.node,
        anchor.point.offset,
        focus.point.node,
        focus.point.offset,
      );
      this.#clampedEnds = {};
      for (const side of RECORD_SIDES) {
        const clamped = shown[side].clamped;
        if (clamped !== undefined) {
          this.#clampedEnds[side] = clamped;
        }
      }
    }
    this.#shown = shownRangeOf(browserSelection);
    this.#observeEndRows(browserSelection);
    this.#publishShown(browserSelection);
    return true;
  }

  /** Whether an end now stands clamped at a different edge than the one written, or none. */
  #hasMoved(shown: Record<RecordSide, ShownEnd>): boolean {
    return RECORD_SIDES.some(
      (side) => shown[side].clamped?.container !== this.#clampedEnds[side]?.container,
    );
  }

  /** Whether an end stands clamped, so the browser shows the drawn part of the record. */
  #isClamped(): boolean {
    return this.#clampedEnds.start !== undefined || this.#clampedEnds.end !== undefined;
  }

  /**
   * A shift-press that would move a clamped end: held, and the end's row drawn, so the end moves
   * from where it is once the row commits.
   */
  #extendClampedEnd(event: KeyboardEvent): void {
    const selection = this.#selection;
    if (selection === undefined || event.defaultPrevented) {
      return;
    }
    const focusSide = otherSide(this.#anchorSide);
    if (this.#clampedEnds[focusSide] === undefined) {
      return;
    }
    const extension = extensionOf(event);
    if (extension === undefined) {
      return;
    }
    event.preventDefault();
    const rowKey = selection[focusSide].rowKey;
    this.#pendingExtension = { rowKey, extension };
    this.#options.drawRow(rowKey);
  }

  /**
   * Moves the record's focus end as the held shift-press would have from where it is: the record is
   * written with that end where it sits, and the browser moves it.
   */
  #applyExtension(browserSelection: Selection, extension: SelectionExtension): boolean {
    if (!this.#writeRecord()) {
      return false;
    }
    extendSelection(browserSelection, extension);
    return true;
  }

  /**
   * Whether a remount inside an end row took the browser's selection: an end left on detached
   * nodes, or the selection collapsed inside an end row. A selection the reader moved elsewhere is
   * theirs, and its change makes the record.
   */
  #hasLost(browserSelection: Selection, selection: RowSelection): boolean {
    if (browserSelection.rangeCount === 0) {
      return false;
    }
    const liveRange = browserSelection.getRangeAt(0);
    if (!liveRange.startContainer.isConnected || !liveRange.endContainer.isConnected) {
      return true;
    }
    if (!browserSelection.isCollapsed) {
      return false;
    }
    return [selection.start.rowKey, selection.end.rowKey].some(
      (rowKey) => this.#rowElementByKey.get(rowKey)?.contains(liveRange.startContainer) === true,
    );
  }

  /** Whether the browser's selection ends inside `rowElement`. */
  #endsInside(rowElement: Element): boolean {
    const shown = this.#shown;
    return (
      shown !== undefined &&
      (rowElement.contains(shown.startNode) || rowElement.contains(shown.endNode))
    );
  }

  /** Whether the browser's selection is the one last read or written. */
  #isShown(browserSelection: Selection): boolean {
    const shown = this.#shown;
    if (shown === undefined || browserSelection.rangeCount === 0) {
      return false;
    }
    const liveRange = browserSelection.getRangeAt(0);
    return (
      liveRange.startContainer === shown.startNode &&
      liveRange.startOffset === shown.startOffset &&
      liveRange.endContainer === shown.endNode &&
      liveRange.endOffset === shown.endOffset
    );
  }

  /** Watches the rows the browser's selection ends in, for text that moves an end. */
  #observeEndRows(browserSelection: Selection): void {
    const rows: Element[] = [];
    if (this.#selection !== undefined && browserSelection.rangeCount > 0) {
      const liveRange = browserSelection.getRangeAt(0);
      for (const node of [liveRange.startContainer, liveRange.endContainer]) {
        const row = this.#rowOf(node);
        if (row !== undefined && !rows.includes(row)) {
          rows.push(row);
        }
      }
    }
    if (
      rows.length === this.#observedRows.length &&
      rows.every((row, index) => row === this.#observedRows[index])
    ) {
      return;
    }
    this.#endRowObserver.disconnect();
    for (const row of rows) {
      this.#endRowObserver.observe(row, { characterData: true, childList: true, subtree: true });
    }
    this.#observedRows = rows;
  }

  /**
   * A change inside a row the browser's selection ends in. An end the change moved (its node
   * replaced, or its node's text replaced) is written back from the record; an end that moved
   * otherwise is the reader's change, not yet heard, and is read now.
   */
  #noteEndRowsChanged(records: readonly MutationRecord[]): void {
    const shown = this.#shown;
    const scrollContainer = this.#scrollContainer;
    const browserSelection = scrollContainer?.ownerDocument.getSelection() ?? null;
    if (
      this.#selection === undefined ||
      shown === undefined ||
      scrollContainer === undefined ||
      browserSelection === null ||
      this.#isShown(browserSelection)
    ) {
      return;
    }
    const mutatedNodes = new Set(records.map((record) => record.target));
    const live = shownRangeOf(browserSelection);
    const isMovedByChange = (shownNode: Node, liveNode: Node | undefined): boolean =>
      !shownNode.isConnected || (liveNode === shownNode && mutatedNodes.has(shownNode));
    const isStartExplained =
      (live?.startNode === shown.startNode && live.startOffset === shown.startOffset) ||
      isMovedByChange(shown.startNode, live?.startNode);
    const isEndExplained =
      (live?.endNode === shown.endNode && live.endOffset === shown.endOffset) ||
      isMovedByChange(shown.endNode, live?.endNode);
    if (isStartExplained && isEndExplained) {
      this.#writeRecord();
      return;
    }
    this.#readSelection(scrollContainer);
  }

  /** The drawn row holding `node`, or `undefined` outside every row. */
  #rowOf(node: Node): Element | undefined {
    for (let ancestor: Node | null = node; ancestor !== null; ancestor = ancestor.parentNode) {
      if (this.#rowKeyByElement.has(ancestor)) {
        return ancestor as Element;
      }
    }
    return undefined;
  }

  /** Drops the record and releases its rows. */
  #clearSelection(): void {
    this.#selection = undefined;
    this.#anchorSide = "start";
    this.#outsidePoints = {};
    this.#clampedEnds = {};
    this.#shown = undefined;
    this.#pendingExtension = undefined;
    this.#letGoEndRows.clear();
    this.#endRowObserver.disconnect();
    this.#observedRows = [];
    this.#options.holdSelectedRows([]);
    this.#announceRecord();
  }

  #announceRecord(): void {
    for (const listener of this.#recordListeners) {
      listener();
    }
  }

  /**
   * Publishes the browser's range while it shows the record, or none. A clamped end is published
   * as the other end's row edge, so only a drawn end row's items are kept drawn.
   */
  #publishShown(browserSelection: Selection): void {
    if (
      this.#selection === undefined ||
      browserSelection.rangeCount === 0 ||
      browserSelection.isCollapsed
    ) {
      this.#publish(undefined);
      return;
    }
    const range = browserSelection.getRangeAt(0).cloneRange();
    const isStartClamped = this.#clampedEnds.start !== undefined;
    const isEndClamped = this.#clampedEnds.end !== undefined;
    if (isStartClamped || isEndClamped) {
      const realRow = this.#rowOf(isStartClamped ? range.endContainer : range.startContainer);
      if ((isStartClamped && isEndClamped) || realRow === undefined) {
        this.#publish(undefined);
        return;
      }
      const edge = rowEdgePoint(realRow, isStartClamped ? "start" : "end");
      if (isStartClamped) {
        range.setStart(edge.node, edge.offset);
      } else {
        range.setEnd(edge.node, edge.offset);
      }
    }
    this.#publish(range);
  }

  /** Publishes the browser's caret while it sits inside the scroller, or none. */
  #publishCaret(browserSelection: Selection, scrollContainer: HTMLElement): void {
    const caret =
      browserSelection.isCollapsed && browserSelection.rangeCount > 0
        ? browserSelection.getRangeAt(0)
        : undefined;
    this.#publish(
      caret !== undefined && scrollContainer.contains(caret.startContainer)
        ? caret.cloneRange()
        : undefined,
    );
  }

  /** Takes `range` as the published range and tells subscribers, unless none stays none. */
  #publish(range: AbstractRange | undefined): void {
    const hadRange = this.#selectionRange !== undefined;
    this.#selectionRange = range;
    if (hadRange || range !== undefined) {
      for (const listener of this.#listeners) {
        listener();
      }
    }
  }
}

/** A selection read from the browser: the record, and how the browser holds its ends. */
interface ReadSelection {
  readonly selection: RowSelection;
  readonly anchorSide: RecordSide;
  readonly outsidePoints: Partial<Record<RecordSide, SelectionPoint>>;
  readonly clampedEnds: Partial<Record<RecordSide, ClampedEnd>>;
}

/** The browser's selection range's ends, as last read or written. */
interface ShownRange {
  readonly startNode: Node;
  readonly startOffset: number;
  readonly endNode: Node;
  readonly endOffset: number;
}

/** A row's first character: where an end taken whole is ordered against one inside the row. */
const ROW_START: RowTextPosition = { path: [], characterOffset: 0 };

/** The rows an end of the selection sits inside, which are held and copied as drawn. */
function anchoredRowKeys(selection: RowSelection): readonly string[] {
  const rowKeys = [selection.start, selection.end]
    .filter((boundary) => boundary.position !== undefined)
    .map((boundary) => boundary.rowKey);
  return [...new Set(rowKeys)];
}

/** Whether the browser's focus comes before its anchor. */
function isBackward(browserSelection: Selection): boolean {
  const { anchorNode, focusNode } = browserSelection;
  if (anchorNode === null || focusNode === null) {
    return false;
  }
  return isAfter(
    { node: anchorNode, offset: browserSelection.anchorOffset },
    { node: focusNode, offset: browserSelection.focusOffset },
  );
}

function shownRangeOf(browserSelection: Selection): ShownRange | undefined {
  if (browserSelection.rangeCount === 0) {
    return undefined;
  }
  const liveRange = browserSelection.getRangeAt(0);
  return {
    startNode: liveRange.startContainer,
    startOffset: liveRange.startOffset,
    endNode: liveRange.endContainer,
    endOffset: liveRange.endOffset,
  };
}
