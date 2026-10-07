// One transcript viewport's reading of the reader's selection, behind the viewport's only
// `selectionchange` listener. Each change is read once: the row holding both ends gets the
// snapshot its own restore reads after a flush, and whoever reads the selection's range in the
// scroller is told.
//   - A row's mount reads no selection: freshly mounted nodes cannot already hold one.
//   - The listener returns early on a caret, so the common case costs one read.
//   - Rows are known by their element, found by walking up from the selection's start, so a
//     prune's index shift or a windowed list nested in a row cannot mistake the owner.
//   - Every change replaces the snapshot, so a row the reader has left can never restore an old
//     selection over the one they made since.

import type { Unsubscribe } from "#shared/preload-api.js";
import {
  captureRowSelection,
  restoreRowSelection,
  type RowSelectionSnapshot,
} from "./preservation.js";

/**
 * The selection in one viewport: its one `selectionchange` listener, the snapshot a row's restore
 * reads, and the selection's range for anything inside the scroller that keeps its endpoints.
 */
export class ViewportSelectionTracker {
  readonly #rowElements = new Set<Node>();
  readonly #listeners = new Set<() => void>();
  #listening: AbortController | undefined;
  #heldRow: HeldRowSelection | undefined;
  #selectionRange: AbstractRange | undefined;

  /**
   * Starts reading the selection for `scrollContainer`: adds the viewport's one `selectionchange`
   * listener, on the container's document. Paired with `detach`.
   */
  public attach(scrollContainer: HTMLElement): void {
    const listening = new AbortController();
    scrollContainer.ownerDocument.addEventListener(
      "selectionchange",
      () => {
        this.#readSelection(scrollContainer);
      },
      { signal: listening.signal },
    );
    this.#listening = listening;
  }

  /**
   * Removes the listener and drops what it read. Subscribers are not called: they unmount with
   * the viewport that detaches.
   */
  public detach(): void {
    this.#listening?.abort();
    this.#listening = undefined;
    this.#heldRow = undefined;
    this.#selectionRange = undefined;
  }

  /** Counts a mounted row's element as a row whose selection is kept. Reads no selection. */
  public addRow(rowElement: HTMLElement): void {
    this.#rowElements.add(rowElement);
  }

  /** Forgets an unmounted row and any snapshot held for it. */
  public removeRow(rowElement: HTMLElement): void {
    this.#rowElements.delete(rowElement);
    if (this.#heldRow?.rowElement === rowElement) {
      this.#heldRow = undefined;
    }
  }

  /**
   * Puts the selection back if `rowElement` lost the one it held at the last selection change.
   * Called after every commit of the row; a row holding no snapshot reads nothing.
   */
  public restoreAfterFlush(rowElement: HTMLElement): boolean {
    const heldRow = this.#heldRow;
    if (heldRow?.rowElement !== rowElement) {
      return false;
    }
    const selection = rowElement.ownerDocument.getSelection();
    return selection !== null && restoreRowSelection(rowElement, heldRow.snapshot, selection);
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
   * The selection's range as of the last change, while it starts or ends inside the scroller and
   * is more than a caret; otherwise `undefined`. A new object for each change, so a reader can
   * compare by identity. A copy of the selection's range, so it never moves the selection, though
   * like any range its ends follow the nodes it holds.
   */
  public get selectionRange(): AbstractRange | undefined {
    return this.#selectionRange;
  }

  #readSelection(scrollContainer: HTMLElement): void {
    const hadRange = this.#selectionRange !== undefined;
    this.#heldRow = undefined;
    this.#selectionRange = undefined;
    const selection = scrollContainer.ownerDocument.getSelection();
    if (selection !== null && !selection.isCollapsed && selection.rangeCount > 0) {
      const liveRange = selection.getRangeAt(0);
      const isStartInside = scrollContainer.contains(liveRange.startContainer);
      if (isStartInside || scrollContainer.contains(liveRange.endContainer)) {
        this.#selectionRange = liveRange.cloneRange();
      }
      if (isStartInside) {
        this.#heldRow = this.#holdRowSelection(liveRange);
      }
    }
    if (hadRange || this.#selectionRange !== undefined) {
      for (const listener of this.#listeners) {
        listener();
      }
    }
  }

  /** The snapshot for the row holding `liveRange`'s start, when that row holds its end too. */
  #holdRowSelection(liveRange: AbstractRange): HeldRowSelection | undefined {
    for (let node: Node | null = liveRange.startContainer; node !== null; node = node.parentNode) {
      if (this.#rowElements.has(node)) {
        const snapshot = captureRowSelection(node, liveRange);
        return snapshot === undefined ? undefined : { rowElement: node, snapshot };
      }
    }
    return undefined;
  }
}

/** The one row a selection is wholly inside, and that selection in its coordinates. */
interface HeldRowSelection {
  readonly rowElement: Node;
  readonly snapshot: RowSelectionSnapshot;
}
