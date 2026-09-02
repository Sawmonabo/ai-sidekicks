// The reading anchor — the ledger's promise that it will not move the page you are
// reading.
//
// `Spec-023 §Console Design (Meridian)` §5.7: "Never take the reading position away
// from a person while agents work." Every rule below is that sentence made
// mechanical:
//
//   • **Following is a STATE, not a default.** The ledger follows the tail only
//     while the viewport is at the tail. The moment a person scrolls up, appends
//     stop moving the offset and start counting instead — which is what the tail
//     pill counts.
//   • **The anchor is a row and an offset, not a scroll position.** Rows above the
//     fold grow while a stream reveals into them, so an offset alone drifts. A row
//     key plus that row's distance from the top of the viewport survives every
//     height change under it, and restoring it is one glide through the chokepoint.
//   • **Pinning suppresses prune, and holds survive it.** Paging back cuts the
//     window by root cursor rather than by count, and a row a person is engaged
//     with — an open ask, an approval card, a deep-link target, a selection — is
//     held whether or not it is pinned. §5.7's "never prunes a held row" is the
//     window's rule; this is where the held set lives, because engagement is a
//     reading fact and the window is a memory one.
//   • **Following resumes on arrival, never on a timer.** Reaching the tail
//     resumes it, and so does the pill. Nothing here polls.
//
// Nothing in this module touches the DOM or writes a scroll offset. It decides
// WHAT should happen to the reading position; `scroll-chokepoint.ts` is the only
// module that can make it happen.

import { Emitter, type Unsubscribe } from "../../core/index.js";
import { type LedgerGeometry } from "./geometry-sample.js";

/**
 * The three reading states `Spec-023 §Console Design (Meridian)` §5.7 names.
 *
 * `reading-with-new-rows` is a state and not a counter being non-zero, because the
 * tail pill's presence is what the viewport branches on and a state a reader can
 * name is one a test can assert.
 */
export const READING_MODES = ["following", "reading", "reading-with-new-rows"] as const;

/** One reading state. Derived from the enumeration, never restated. */
export type ReadingMode = (typeof READING_MODES)[number];

/**
 * Why a row is held against prune. Closed: each member is a thing a person is
 * doing with the row, and a reason nobody can name is a leak.
 */
export const READING_HOLD_REASONS = [
  "open-ask",
  "open-approval",
  "deep-link-target",
  "selection",
] as const;

/** One hold reason. Derived from the enumeration, never restated. */
export type ReadingHoldReason = (typeof READING_HOLD_REASONS)[number];

/** Where the reader is, expressed so it survives every height change beneath it. */
export interface ReadingAnchorPoint {
  readonly rowKey: string;
  /** The row's top edge, relative to the top of the viewport. May be negative. */
  readonly offsetWithinViewportPx: number;
}

/** Everything the viewport renders from, in one value. */
export interface ReadingAnchorState {
  readonly mode: ReadingMode;
  /** Rows appended since the reader left the tail. Zero while following. */
  readonly newRowCount: number;
  /** The root cursor the window is cut at while pinned, or `undefined`. */
  readonly pinnedRootCursor: string | undefined;
  readonly anchorPoint: ReadingAnchorPoint | undefined;
}

export class ReadingAnchor {
  readonly #stateEmitter = new Emitter<ReadingAnchorState>("reading anchor state");
  readonly #holdReasonByRowKey = new Map<string, ReadingHoldReason>();

  #mode: ReadingMode = "following";
  #newRowCount = 0;
  #pinnedRootCursor: string | undefined;
  #anchorPoint: ReadingAnchorPoint | undefined;

  /** Watch the reading state, and receive the current one immediately. */
  public subscribe(sink: (state: ReadingAnchorState) => void): Unsubscribe {
    const unsubscribe = this.#stateEmitter.subscribe(sink);
    sink(this.state);
    return unsubscribe;
  }

  public get state(): ReadingAnchorState {
    return {
      mode: this.#mode,
      newRowCount: this.#newRowCount,
      pinnedRootCursor: this.#pinnedRootCursor,
      anchorPoint: this.#anchorPoint,
    };
  }

  /**
   * Fold one geometry sample in.
   *
   * Arriving at the tail resumes following and clears the count, which is §5.7's
   * "following resumes on reaching the tail". Leaving it does NOT clear the anchor
   * point: the viewport captures a fresh one as it scrolls, and dropping the last
   * known point here would leave a frame with nothing to restore.
   *
   * The two arms are deliberately asymmetric. ARRIVING at the tail is arriving
   * however the sample was produced — a shorter log or a taller pane both put the
   * reader at the bottom, and they are at the bottom. LEAVING it takes a `"scroll"`
   * sample, because a viewport that shrank raises the distance from the tail with
   * no reader action at all, and dropping a follower out of following because the
   * window got smaller is the ledger deciding to stop following on its own.
   */
  public observeGeometry(geometry: LedgerGeometry): void {
    if (geometry.isAtTail) {
      this.#transition("following", 0);
      return;
    }
    if (this.#mode === "following" && geometry.cause === "scroll") {
      this.#transition("reading", this.#newRowCount);
    }
  }

  /** Record where the reader is, so a height change beneath them can be undone. */
  public capture(anchorPoint: ReadingAnchorPoint): void {
    if (
      this.#anchorPoint?.rowKey === anchorPoint.rowKey &&
      this.#anchorPoint.offsetWithinViewportPx === anchorPoint.offsetWithinViewportPx
    ) {
      return;
    }
    this.#anchorPoint = anchorPoint;
    this.#emit();
  }

  /**
   * Count rows the log appended.
   *
   * While following the count stays at zero: the viewport is about to show them,
   * and a pill offering to jump to rows already on screen is noise.
   */
  public noteAppendedRows(rowCount: number): void {
    if (rowCount <= 0 || this.#mode === "following") {
      return;
    }
    this.#transition("reading-with-new-rows", this.#newRowCount + rowCount);
  }

  /**
   * Pin history at a root cursor.
   *
   * The cursor rather than a row count because §5.16 cuts the window by root
   * cursor while pinned: a count would move under the reader every time the log
   * appended, which is the drift pinning exists to stop.
   */
  public pin(rootCursor: string): void {
    if (this.#pinnedRootCursor === rootCursor) {
      return;
    }
    this.#pinnedRootCursor = rootCursor;
    this.#transition(this.#mode === "following" ? "reading" : this.#mode, this.#newRowCount);
  }

  public unpin(): void {
    if (this.#pinnedRootCursor === undefined) {
      return;
    }
    this.#pinnedRootCursor = undefined;
    this.#emit();
  }

  /**
   * The pill, and the keyboard's jump.
   *
   * Returns the mode it moved to rather than performing a scroll: the anchor
   * decides, and the one module that can move the surface performs.
   */
  public resumeFollowing(): ReadingMode {
    this.#pinnedRootCursor = undefined;
    this.#transition("following", 0);
    return this.#mode;
  }

  /** Hold a row the reader is engaged with. Re-holding under a new reason replaces. */
  public hold(rowKey: string, reason: ReadingHoldReason): void {
    if (this.#holdReasonByRowKey.get(rowKey) === reason) {
      return;
    }
    this.#holdReasonByRowKey.set(rowKey, reason);
    this.#emit();
  }

  public release(rowKey: string): void {
    if (this.#holdReasonByRowKey.delete(rowKey)) {
      this.#emit();
    }
  }

  public isHeld(rowKey: string): boolean {
    return this.#holdReasonByRowKey.has(rowKey);
  }

  /** Every held row, for the window's prune pass. */
  public heldRowKeys(): readonly string[] {
    return [...this.#holdReasonByRowKey.keys()];
  }

  public holdReason(rowKey: string): ReadingHoldReason | undefined {
    return this.#holdReasonByRowKey.get(rowKey);
  }

  /** `Spec-023 §Console Design (Meridian)` §5.7: prune and trim stop while pinned. */
  public suppressesPrune(): boolean {
    return this.#pinnedRootCursor !== undefined;
  }

  /** Terminal. Drops every sink so a late append cannot reach an unmounted pane. */
  public dispose(): void {
    this.#stateEmitter.clear();
    this.#holdReasonByRowKey.clear();
  }

  #transition(mode: ReadingMode, newRowCount: number): void {
    if (this.#mode === mode && this.#newRowCount === newRowCount) {
      return;
    }
    this.#mode = mode;
    this.#newRowCount = newRowCount;
    this.#emit();
  }

  #emit(): void {
    this.#stateEmitter.emit(this.state);
  }
}
