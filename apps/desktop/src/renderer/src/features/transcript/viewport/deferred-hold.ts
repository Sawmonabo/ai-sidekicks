// The position work a reconcile or a press arms and a layout effect performs.
//
// `reconcile` runs in a passive effect, before the rows it took have rendered, so the sizer and
// the virtualizer's offsets are still in the previous space. The head hold needs post-insert
// offsets, so it is armed here and performed once the new height is committed. The anchored hold
// runs immediately when the rows did not change, in the space its offset was measured in; when
// they did, and when a press on a control in the log changes them, it waits for the commit, since
// the anchored row's index means something only once the virtualizer counts the new rows (a row
// joining above the reader moves it). A follower is owed nothing here: the
// virtualizer's end anchor and its landing on appended rows move the offset once the rows render.
// The head hold does not read the reading anchor, which captures nothing while a reader is at the
// tail; it uses the rows the reader saw, where they stood when the page landed. A page can land
// below a listed row as well as above the first: a run's header keeps its place when the run's
// earlier rows arrive, and they join under it.

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

/** The pending holds, and the rule that picks between them and the immediate anchored hold. */
export class ViewportDeferredHold {
  readonly #scroll: ScrollController;
  readonly #rowKeys: () => readonly string[];
  readonly #offsetOfIndex: (index: number) => number;
  readonly #holdReadingPosition: () => void;

  /** The rows the reader saw when a page landed at the head, from the top of the viewport down. */
  #headHoldPending: readonly ReadingAnchorPoint[] | undefined;
  /** Why the anchored hold waits for the commit: a press, or rows a reconcile changed. */
  #anchoredHoldPending: "press" | "rows-changed" | undefined;

  public constructor(options: ViewportDeferredHoldOptions) {
    this.#scroll = options.scroll;
    this.#rowKeys = options.rowKeys;
    this.#offsetOfIndex = options.offsetOfIndex;
    this.#holdReadingPosition = options.holdReadingPosition;
  }

  /**
   * Decides what this reconcile owes the reading position. A page landing at the head is held
   * at the commit, even for a reader who was following, since landing it is the reader's ask for
   * history; a hold whose rows changed waits for the commit too, a press's among them; with the
   * rows unchanged it holds the anchored row now. Rows a press brought in above the head, as
   * opening a group whose first row sits above its header does, are the press's, held by its hold.
   */
  public armAfterReconcile(input: {
    readonly headInsertedCount: number;
    /** The rows the reader saw before the page landed, read only when one did. */
    readonly readRowsInView: () => readonly ReadingAnchorPoint[];
    /** Whether the reconcile changed the rows the viewport holds, so a render is coming. */
    readonly hasRowSetChanged: boolean;
  }): void {
    if (input.headInsertedCount > 0 && this.#anchoredHoldPending !== "press") {
      this.#headHoldPending = input.readRowsInView();
      return;
    }
    if (input.hasRowSetChanged) {
      // The hold waits for the commit that lays the new rows out; a press's stays armed as one.
      this.#anchoredHoldPending ??= "rows-changed";
      return;
    }
    this.#performAnchoredHold();
  }

  /**
   * Arms the anchored hold for the next commit whose rows the window has reconciled, for a press
   * that is about to change the rows.
   */
  public armAnchoredHoldAtCommit(): void {
    this.#anchoredHoldPending = "press";
  }

  /**
   * Performs what was armed, now that the new height is committed: the head hold, and a press's
   * anchored hold once `isRenderReconciled` says the window has taken the rows this render drew.
   * Cheap when nothing is armed, since the binding calls it after every render; each arm clears
   * before acting.
   */
  public commit(isRenderReconciled: boolean): void {
    const headHold = this.#headHoldPending;
    this.#headHoldPending = undefined;
    if (headHold !== undefined) {
      this.#performHeadHold(headHold);
    }
    if (isRenderReconciled && this.#anchoredHoldPending !== undefined) {
      this.#performAnchoredHold();
    }
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
    this.#headHoldPending = undefined;
    this.#anchoredHoldPending = undefined;
  }

  #performAnchoredHold(): void {
    this.#anchoredHoldPending = undefined;
    this.#holdReadingPosition();
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
