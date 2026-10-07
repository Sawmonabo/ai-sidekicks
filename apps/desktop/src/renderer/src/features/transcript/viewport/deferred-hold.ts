// The position work a reconcile arms and a layout effect performs.
//
// `reconcile` runs in a passive effect, before the rows it took have rendered, so the sizer and
// the virtualizer's offsets are still in the previous space. The head hold needs post-insert
// offsets, so it is armed here and performed once the new height is committed; the anchored hold
// runs immediately, in the pre-render space its offset was measured in. A follower is owed
// nothing here: the virtualizer's end anchor and its landing on appended rows move the offset
// once the rows render. The head hold does not read the reading anchor, which captures nothing
// while a reader is at the tail; it uses where the head row was.

import { type ScrollController } from "#renderer/lib/scroll/chokepoint.js";

/** Dependencies of a `ViewportDeferredHold`; `rowKeys` is read when the hold is performed. */
export interface ViewportDeferredHoldOptions {
  readonly scroll: ScrollController;
  /** The retained row keys as they stand when the hold is performed. */
  readonly rowKeys: () => readonly string[];
  /** Where a row's top edge sits, from the measurements the library holds. */
  readonly offsetOfIndex: (index: number) => number;
  /** Put a reader who is not following back on their anchored row — the immediate arm. */
  readonly holdReadingPosition: () => void;
}

/** The pending head hold, and the rule that picks between it and the immediate anchored hold. */
export class ViewportDeferredHold {
  readonly #scroll: ScrollController;
  readonly #rowKeys: () => readonly string[];
  readonly #offsetOfIndex: (index: number) => number;
  readonly #holdReadingPosition: () => void;

  #headHoldPending: PendingHeadHold | undefined;

  public constructor(options: ViewportDeferredHoldOptions) {
    this.#scroll = options.scroll;
    this.#rowKeys = options.rowKeys;
    this.#offsetOfIndex = options.offsetOfIndex;
    this.#holdReadingPosition = options.holdReadingPosition;
  }

  /**
   * Decides what this reconcile owes the reading position. A page landing at the head is held
   * at the commit, even for a reader who was following, since landing it is the reader's ask for
   * history; anything else holds the anchored row now.
   */
  public armAfterReconcile(input: {
    readonly headInsertedCount: number;
    readonly previousHeadKey: string | undefined;
    readonly scrollTopPx: number;
  }): void {
    if (input.headInsertedCount > 0 && input.previousHeadKey !== undefined) {
      this.#headHoldPending = { rowKey: input.previousHeadKey, scrollTopPx: input.scrollTopPx };
      return;
    }
    this.#holdReadingPosition();
  }

  /**
   * Performs the head hold if one was armed, now that the new height is committed. Cheap when
   * nothing is armed, since the binding calls it after every render; the arm clears before acting.
   */
  public commit(): void {
    const headHold = this.#headHoldPending;
    this.#headHoldPending = undefined;
    if (headHold !== undefined) {
      this.#performHeadHold(headHold);
    }
  }

  /** Terminal, and called on disposal: a disposed frame owes no position. */
  public disarm(): void {
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
