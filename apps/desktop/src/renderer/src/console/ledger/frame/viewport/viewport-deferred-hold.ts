// The position work a reconcile ARMS and a layout effect performs.
//
// WHY ANY OF IT IS DEFERRED. `reconcile` runs in a passive effect, so the rows it took
// have not rendered when it runs: the sizer still carries the previous total size and
// the virtualizer still answers offsets in the previous space. Two of the three things
// this frame does to a reading position depend on the space AFTER that render, so they
// are decided here and performed once the library has committed the new height.
//
// THREE ARMS, AND THE THIRD IS THE ONE THAT IS NOT DEFERRED AT ALL:
//
//   • **The tail glide.** A follower is at the bottom, and `glideToTail()` reads
//     `scrollHeight` — which, before the render, is the height of the log as it was
//     BEFORE the append. Nothing corrects it afterwards: the container did not resize
//     and no further row arrived, so the reader is left short of the new entry with
//     the state still reporting `following`.
//   • **The head hold.** Rows arriving BEFORE the window's head move every row below
//     them down by the height of the page that landed, so a reader standing still is
//     carried up into rows they did not ask to be looking at. Held by putting the row
//     that USED to be first back at the distance from the top of the viewport it had —
//     which is arithmetic in the post-insert offset space and reads as the wrong row's
//     offset in the pre-insert one.
//   • **The anchored hold**, which is the ordinary case and runs immediately. Its
//     index lookup is deliberately in the PRE-render offset space, because that is the
//     space the anchored row's offset was measured in.
//
// THE HEAD HOLD DELIBERATELY DOES NOT READ THE READING ANCHOR. The anchor captures
// nothing while a reader is at the tail — `isAtTail` returns before the capture — so a
// follower who asks for earlier rows has no anchor point to be restored to, and an arm
// that depended on one would hold every reader except the one standing at the end of
// the log. What it holds instead is a fact every reader has: where the head row was.

import { type ReadingAnchor } from "../measurement/index.js";
import { type LedgerScrollController } from "../scroll/index.js";

/** What the head hold has to remember between arming and performing. */
interface PendingHeadHold {
  /** The row that was first before the page landed. */
  readonly rowKey: string;
  /** The offset the surface was at when it was. */
  readonly scrollTopPx: number;
}

export interface LedgerDeferredHoldOptions {
  readonly anchor: ReadingAnchor;
  readonly scroll: LedgerScrollController;
  /** The retained row keys as they stand when the hold is performed. */
  readonly rowKeys: () => readonly string[];
  /** Where a row's top edge sits, from the measurements the library holds. */
  readonly offsetOfIndex: (index: number) => number;
  /** Put the reader back on their anchored row — the immediate arm. */
  readonly holdReadingPosition: () => void;
}

/** The two pending arms, and the rule that picks between them and the third. */
export class LedgerDeferredHold {
  readonly #anchor: ReadingAnchor;
  readonly #scroll: LedgerScrollController;
  readonly #rowKeys: () => readonly string[];
  readonly #offsetOfIndex: (index: number) => number;
  readonly #holdReadingPosition: () => void;

  #tailGlidePending = false;
  #headHoldPending: PendingHeadHold | undefined;

  public constructor(options: LedgerDeferredHoldOptions) {
    this.#anchor = options.anchor;
    this.#scroll = options.scroll;
    this.#rowKeys = options.rowKeys;
    this.#offsetOfIndex = options.offsetOfIndex;
    this.#holdReadingPosition = options.holdReadingPosition;
  }

  /**
   * Decide what this reconcile owes the reading position.
   *
   * THE HEAD HOLD OUTRANKS THE TAIL GLIDE, and the ordering is the one case where both
   * could be true: a backward page landing in the same reconcile as an append leaves a
   * reader who was following with rows at both ends, and gliding them to the tail
   * would discard the history they just asked for. A reader who wanted the tail has
   * the pill and the keyboard jump, and both clear the pin on the way.
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
   * Perform whatever was armed, now that the new height is committed.
   *
   * Idempotent and cheap when nothing is armed, because the binding calls it after
   * every render rather than only after the ones that changed the row set. Every arm
   * clears its own flag before it acts, so a stale arming never fires against a later
   * render.
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
    // Re-checked rather than trusted: a reader who scrolled away between the reconcile
    // and this commit is no longer following, and dragging them to the tail is the one
    // thing the reading anchor exists to prevent.
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
   * Put the row that used to be first back where it was.
   *
   * Its previous distance from the top of the viewport was `0 - scrollTop`, because it
   * sat at content offset zero. Its offset now is the height of everything inserted
   * above it, so the offset that restores that distance is exactly that height plus
   * the offset the reader was at.
   *
   * Two exits and neither guesses. A key the window no longer holds names a row the
   * cap took while the page was in flight — the offset is left where it is rather than
   * anchored to whichever row now holds that index, which is `holdReadingPosition`'s
   * own rule for a vanished anchor. An index of zero means nothing ended up above it
   * after all, so there is nothing to compensate for.
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
