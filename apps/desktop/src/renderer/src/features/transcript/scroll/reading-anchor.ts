// The reading anchor: the transcript never takes the reading position away from a person while
// agents work. It decides what should happen to the reading position; `scroll-chokepoint.ts` is
// the only module that writes a scroll offset, and this one touches no DOM.
//   - Following is a state: appends move the offset only while the viewport is at the tail, and
//     otherwise they are counted (the tail pill's count).
//   - The anchor is a row key plus that row's offset from the viewport top, which survives the
//     height changes of rows above it, where a bare scroll offset would drift.
//   - Pinning suppresses prune, and held rows (open ask, approval, deep-link target, selection)
//     are never pruned; the held set lives here because engagement is a reading fact.
//   - Following resumes on arrival at the tail or through the pill, never on a timer.

import { Emitter, type Unsubscribe } from "@renderer/lib/emitter.js";
import { type ScrollGeometry } from "./geometry-sample.js";

/**
 * The three reading states. Closed.
 *
 * `reading-with-new-rows` is a state, not a nonzero counter, because the tail pill's presence is
 * what the viewport branches on.
 */
export const READING_MODES = ["following", "reading", "reading-with-new-rows"] as const;

/** One reading state. Derived from the enumeration, never restated. */
export type ReadingMode = (typeof READING_MODES)[number];

/** Why a row is held against prune. Closed: each is something a person is doing with the row. */
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

/** The reading state machine: follow, read, pin history, and hold engaged rows against prune. */
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
   * Arriving at the tail resumes following, clears the count, and clears the pin, exactly as
   * {@link resumeFollowing} does: reaching the tail by scrolling and by the pill are one act, and
   * a pin only the pill released would survive the other and refuse prune forever. Leaving the
   * tail keeps the last anchor point, since dropping it would leave a frame with nothing to
   * restore.
   *
   * Arriving counts however the sample was produced, but leaving takes a `"scroll"` sample: a
   * shrinking viewport raises the distance from the tail with no reader action, and it must not
   * stop following on its own.
   */
  public observeGeometry(geometry: ScrollGeometry): void {
    if (geometry.isAtTail) {
      // Through `unpin` so a sample that only releases a pin still notifies; the window's prune
      // refusal lifts on that field.
      this.unpin();
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
   * While following the count stays at zero: the viewport is about to show them.
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
   * The cursor, not a row count, because `window-cap.ts` cuts the window by root cursor while
   * pinned and a count would move under the reader as the log appended.
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
   * Returns the mode it moved to instead of scrolling: the one module that can move the scroll
   * container performs the move.
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

  /** Whether prune and trim stop, which they do while history is pinned. */
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
