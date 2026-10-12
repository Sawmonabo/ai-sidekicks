// The position work a pass or a press arms and the binding's layout effect performs.
//
// A pass runs before the virtualizer lays out the rows it took: a render's pass runs in that
// render, and any other pass ahead of the render its publication brings. Its scroll writes wait
// for that render to commit, so each lands on the offsets of the rows it drew, before the frame
// paints. The height a cut let go above the reader is paid by arithmetic on the offset; a page
// landing at the head is held on the rows the reader saw, where they stood when it landed; the
// anchored row is put back at its distance from the top of the viewport once the virtualizer
// counts the rows the window holds (a row joining above the reader moves its index). A press on a
// control in the log arms the anchored hold too. A follower is owed nothing here: the
// virtualizer's end anchor and its landing on appended rows move the offset once the rows render.
// The head hold does not read the reading anchor, which captures nothing while a reader is at the
// tail. A page can land below a listed row as well as above the first: a run's header keeps its
// place when the run's earlier rows arrive, and they join under it.

import { type ScrollController } from "#renderer/lib/scroll/chokepoint.js";
import { type ReadingAnchorPoint } from "./reading-anchor.js";

/** Dependencies of a `ViewportDeferredHold`; `rowKeys` is read when the hold is performed. */
export interface ViewportDeferredHoldOptions {
  readonly scroll: ScrollController;
  /** The retained row keys as they stand when the hold is performed. */
  readonly rowKeys: () => readonly string[];
  /** Where a row's top edge sits, from the measurements the library holds. */
  readonly offsetOfIndex: (index: number) => number;
  /** Put a reader who is not following back on their anchored row. */
  readonly holdReadingPosition: () => void;
}

/** The pending cut compensation and holds, and the rule that picks between the holds. */
export class ViewportDeferredHold {
  readonly #scroll: ScrollController;
  readonly #rowKeys: () => readonly string[];
  readonly #offsetOfIndex: (index: number) => number;
  readonly #holdReadingPosition: () => void;

  /** The offset that pays the height a cut let go above the reader. */
  #compensationTargetPx: number | undefined;
  /** The rows the reader saw when a page landed at the head, from the top of the viewport down. */
  #headHoldPending: readonly ReadingAnchorPoint[] | undefined;
  /** Why the anchored hold waits for the commit: a press, or a pass. */
  #anchoredHoldPending: "press" | "pass" | undefined;

  public constructor(options: ViewportDeferredHoldOptions) {
    this.#scroll = options.scroll;
    this.#rowKeys = options.rowKeys;
    this.#offsetOfIndex = options.offsetOfIndex;
    this.#holdReadingPosition = options.holdReadingPosition;
  }

  /**
   * Arms the offset that pays `prunedHeightPx`, the height a cut let go above the reader, on top of
   * any compensation still waiting: the rows above the reader's row went, so its offset moves up by
   * exactly that much. Answers whether it armed one: with nothing let go, or no offset sampled yet,
   * there is nothing to pay.
   */
  public armCompensation(prunedHeightPx: number): boolean {
    const scrollTopPx = this.#compensationTargetPx ?? this.#scroll.geometry?.scrollTop;
    if (prunedHeightPx <= 0 || scrollTopPx === undefined) {
      return false;
    }
    this.#compensationTargetPx = scrollTopPx - prunedHeightPx;
    return true;
  }

  /**
   * Decides what a pass owes the reading position. A page landing at the head is held at the
   * commit, even for a reader who was following, since landing it is the reader's ask for history;
   * otherwise the anchored row is held at the commit. Rows a press brought in above the head, as
   * opening a group whose first row sits above its header does, are the press's, held by its hold.
   */
  public armAfterPass(input: {
    readonly headInsertedCount: number;
    /** The rows the reader saw before the page landed, read only when one did. */
    readonly readRowsInView: () => readonly ReadingAnchorPoint[];
  }): void {
    if (input.headInsertedCount > 0 && this.#anchoredHoldPending !== "press") {
      this.#headHoldPending = input.readRowsInView();
      return;
    }
    this.#anchoredHoldPending ??= "pass";
  }

  /**
   * Arms the anchored hold for the next commit whose rows are the ones the window holds, for a
   * press that is about to change the rows.
   */
  public armAnchoredHoldAtCommit(): void {
    this.#anchoredHoldPending = "press";
  }

  /**
   * Performs what was armed, now that the rows are laid out: the cut compensation, the head hold,
   * and the anchored hold once `isRenderReconciled` says the virtualizer counts the rows the
   * window holds. Cheap when nothing is armed, since the binding calls it after every render; each
   * arm clears before acting.
   */
  public commit(isRenderReconciled: boolean): void {
    const compensationTargetPx = this.#compensationTargetPx;
    this.#compensationTargetPx = undefined;
    if (compensationTargetPx !== undefined) {
      this.#scroll.glideTo("prune-compensation", compensationTargetPx);
    }
    const headHold = this.#headHoldPending;
    this.#headHoldPending = undefined;
    if (headHold !== undefined) {
      this.#performHeadHold(headHold);
    }
    if (isRenderReconciled && this.#anchoredHoldPending !== undefined) {
      this.#anchoredHoldPending = undefined;
      this.#holdReadingPosition();
    }
  }

  /** The offset the armed cut compensation will glide to, or `undefined` while none is armed. */
  public get compensationTargetPx(): number | undefined {
    return this.#compensationTargetPx;
  }

  /** Whether an anchored hold is armed and waits for the commit that lays its rows out. */
  public get isAnchoredHoldArmed(): boolean {
    return this.#anchoredHoldPending !== undefined;
  }

  /** Whether a head hold is armed and waits for the commit that lays its page out. */
  public get isHeadHoldArmed(): boolean {
    return this.#headHoldPending !== undefined;
  }

  /**
   * The offset the armed head hold will glide to, worked out over the rows as the library now
   * lays them out, so the render that lays the landed page out draws the rows the reader will
   * see; `undefined` while none is armed or none of the rows the reader saw is held.
   */
  public headHoldTargetPx(): number | undefined {
    const rowsInView = this.#headHoldPending;
    return rowsInView === undefined ? undefined : this.#targetOf(rowsInView);
  }

  /** Terminal, and called on disposal: a disposed frame owes no position. */
  public disarm(): void {
    this.#compensationTargetPx = undefined;
    this.#headHoldPending = undefined;
    this.#anchoredHoldPending = undefined;
  }

  #performHeadHold(rowsInView: readonly ReadingAnchorPoint[]): void {
    const targetPx = this.#targetOf(rowsInView);
    if (targetPx !== undefined) {
      this.#scroll.glideTo("hold-reading-position", targetPx);
    }
  }

  /**
   * Where the first row the reader saw that no landed row followed is back at its distance from
   * the top of the viewport: its new offset less that distance. A row the page joined under, such
   * as a header the run's earlier rows arrived beneath, would hold still while the rows below it
   * move, so the next row the reader saw is held instead. Rows the window no longer holds are
   * passed over; with none left there is no target rather than whichever row is there.
   */
  #targetOf(rowsInView: readonly ReadingAnchorPoint[]): number | undefined {
    const rowKeys = this.#rowKeys();
    for (const [position, row] of rowsInView.entries()) {
      const index = rowKeys.indexOf(row.rowKey);
      const nextRow = rowsInView[position + 1];
      if (index >= 0 && (nextRow === undefined || rowKeys[index + 1] === nextRow.rowKey)) {
        return this.#offsetOfIndex(index) - row.offsetWithinViewportPx;
      }
    }
    return undefined;
  }
}
