// The position work a reconcile arms and a layout effect performs.
//
// `reconcile` runs in a passive effect, before the rows it took have rendered, so the sizer and
// the virtualizer's offsets are still in the previous space. The tail glide (which would land
// short of the new entry) and the head hold (which needs post-insert offsets) are armed here and
// performed once the new height is committed; the anchored hold runs immediately, in the
// pre-render space its offset was measured in. The head hold does not read the reading anchor,
// which captures nothing while a reader is at the tail; it uses where the head row was.

import { type ReadingAnchor } from "../scroll/reading-anchor.js";
import { type ScrollController } from "#renderer/lib/scroll/chokepoint.js";

/** Dependencies of a `ViewportDeferredHold`; `rowKeys` is read when the hold is performed. */
export interface ViewportDeferredHoldOptions {
  readonly anchor: ReadingAnchor;
  readonly scroll: ScrollController;
  /** The retained row keys as they stand when the hold is performed. */
  readonly rowKeys: () => readonly string[];
  /** Where a row's top edge sits, from the measurements the library holds. */
  readonly offsetOfIndex: (index: number) => number;
  /** Put the reader back on their anchored row — the immediate arm. */
  readonly holdReadingPosition: () => void;
}

/** The two pending arms, and the rule that picks between them and the third. */
export class ViewportDeferredHold {
  readonly #anchor: ReadingAnchor;
  readonly #scroll: ScrollController;
  readonly #rowKeys: () => readonly string[];
  readonly #offsetOfIndex: (index: number) => number;
  readonly #holdReadingPosition: () => void;

  #tailGlidePending = false;
  #headHoldPending: PendingHeadHold | undefined;

  public constructor(options: ViewportDeferredHoldOptions) {
    this.#anchor = options.anchor;
    this.#scroll = options.scroll;
    this.#rowKeys = options.rowKeys;
    this.#offsetOfIndex = options.offsetOfIndex;
    this.#holdReadingPosition = options.holdReadingPosition;
  }

  /**
   * Decides what this reconcile owes the reading position. The head hold outranks the tail
   * glide: a backward page landing with an append would otherwise glide a following reader to
   * the tail and discard the history they asked for.
   */
  public armAfterReconcile(input: {
    readonly headInsertedCount: number;
    readonly previousHeadKey: string | undefined;
    readonly scrollTopPx: number;
  }): void {
    if (input.headInsertedCount > 0 && input.previousHeadKey !== undefined) {
      this.#tailGlidePending = false;
      this.#headHoldPending = { rowKey: input.previousHeadKey, scrollTopPx: input.scrollTopPx };
      return;
    }
    if (this.#anchor.state.mode === "following") {
      this.#tailGlidePending = true;
      return;
    }
    this.#holdReadingPosition();
  }

  /**
   * Performs whatever was armed, now that the new height is committed. Cheap when nothing is
   * armed, since the binding calls it after every render; each arm clears its flag before acting.
   */
  public commit(): void {
    const headHold = this.#headHoldPending;
    this.#headHoldPending = undefined;
    if (headHold !== undefined) {
      this.#performHeadHold(headHold);
      return;
    }
    if (!this.#tailGlidePending) {
      return;
    }
    this.#tailGlidePending = false;
    // Re-checked: a reader who scrolled away since the reconcile must not be dragged to the tail.
    if (this.#anchor.state.mode !== "following") {
      return;
    }
    this.#scroll.glideToTail("follow-tail");
  }

  /** Terminal, and called on disposal: a disposed frame owes no position. */
  public disarm(): void {
    this.#tailGlidePending = false;
    this.#headHoldPending = undefined;
  }

  /**
   * Puts the row that used to be first back at its previous distance from the top of the
   * viewport. That row sat at offset zero, so the offset that restores it is its new offset (the
   * height inserted above it) plus the reader's `scrollTop`. A key the window no longer holds, or
   * an index of zero, leaves the offset alone rather than anchoring to whichever row now holds it.
   */
  #performHeadHold(headHold: PendingHeadHold): void {
    const index = this.#rowKeys().indexOf(headHold.rowKey);
    if (index <= 0) {
      return;
    }
    this.#scroll.glideTo(
      "hold-reading-position",
      this.#offsetOfIndex(index) + headHold.scrollTopPx,
    );
  }
}

/** What the head hold has to remember between arming and performing. */
interface PendingHeadHold {
  /** The row that was first before the page landed. */
  readonly rowKey: string;
  /** The offset the scroll container was at when the page landed. */
  readonly scrollTopPx: number;
}
