// The reading anchor: the transcript never takes the reading position away from a person while
// agents work. It decides what should happen to the reading position; `chokepoint.ts` is
// the only module that writes a scroll offset, and this one touches no DOM.
//   - Following is a state: appends move the offset only while the viewport is at the tail, and
//     otherwise they are counted (the tail pill's count).
//   - The anchor is a row key plus that row's offset from the viewport top, which survives the
//     height changes of rows above it, where a bare scroll offset would drift.
//   - The rows a reader's selection starts and ends in are held, so the window keeps them while
//     they sit within its let-go distance and the browser's selection stays anchored; the held set
//     lives here because engagement is a reading fact.
//   - Following resumes on arrival at the tail or through the pill, never on a timer, and ends
//     only on the reader's own act: their scroll toward the head, or a move they asked for.

import type { Unsubscribe } from "#shared/preload-api.js";
import { Emitter } from "#renderer/lib/emitter.js";
import {
  SCROLL_GEOMETRY_EPSILON_PX,
  type ScrollGeometry,
} from "#renderer/lib/scroll/geometry/sample.js";
import { TRANSCRIPT_GESTURE_GAP_MS } from "./caps.js";

/**
 * The three reading states. Closed.
 *
 * `reading-with-new-rows` is a state, not a nonzero counter, because the tail pill's presence is
 * what the viewport branches on.
 */
export const READING_MODES = ["following", "reading", "reading-with-new-rows"] as const;

/** One reading state. Derived from the enumeration, never restated. */
export type ReadingMode = (typeof READING_MODES)[number];

/** Why a row is held against a cut. Closed: each is something a person is doing with the row. */
export const READING_HOLD_REASONS = ["selection"] as const;

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
  readonly anchorPoint: ReadingAnchorPoint | undefined;
}

/** The reading state machine: follow, read, and hold engaged rows against a cut. */
export class ReadingAnchor {
  readonly #stateEmitter = new Emitter<ReadingAnchorState>("reading anchor state");
  readonly #holdReasonByRowKey = new Map<string, ReadingHoldReason>();
  /**
   * The held keys as one array, rebuilt only when the held set changes, so a reader compares it.
   */
  #heldRowKeys: readonly string[] = [];

  #mode: ReadingMode = "following";
  #newRowCount = 0;
  #anchorPoint: ReadingAnchorPoint | undefined;
  /** The last sample folded in, so a reader's scroll toward the head is told apart. */
  #lastGeometry: ScrollGeometry | undefined;
  /** When the reader last turned the wheel, pressed a key or moved a touch on the log. */
  #lastReaderInputAtMs: number | undefined;
  /** Whether the reader's pointer is down in the box, where a dragged selection scrolls it. */
  #isReaderPointerDown = false;

  /** Watch the reading state, and receive the current one immediately. */
  public subscribe(sink: (state: ReadingAnchorState) => void): Unsubscribe {
    const unsubscribe = this.#stateEmitter.subscribe(sink);
    sink(this.state);
    return unsubscribe;
  }

  /** The reading state as it stands. */
  public get state(): ReadingAnchorState {
    return {
      mode: this.#mode,
      newRowCount: this.#newRowCount,
      anchorPoint: this.#anchorPoint,
    };
  }

  /**
   * Fold one geometry sample in.
   *
   * Arriving at the tail resumes following and clears the count, exactly as
   * {@link resumeFollowing} does: reaching the tail by scrolling and by the pill are one act.
   * Leaving the tail keeps the last anchor point, since dropping it would leave a frame with
   * nothing to restore.
   *
   * Only the reader leaves the tail: a `"scroll"` sample whose offset moved toward the head and
   * whose scroll event came within a gesture gap of the reader's own wheel, key or touch, or while
   * their pointer is down in the box. A write the transcript or the library made, a
   * shrinking viewport and content growing under a still offset never stop following; the
   * controller lands the follower on the tail again. A scroll toward the head is a decision and
   * releases the follow at once, however small, even inside the tail band; arriving back within
   * the band re-engages it. A move the reader asked for elsewhere (a link, a find hit) releases
   * through {@link readFrom}.
   */
  public observeGeometry(geometry: ScrollGeometry): void {
    const previous = this.#lastGeometry;
    this.#lastGeometry = geometry;
    const readerMovedTowardHead =
      this.#isReaderScroll(geometry) && hasOffsetMovedTowardHead(previous, geometry);
    if (geometry.isAtTail && !readerMovedTowardHead) {
      this.#transition("following", 0);
      return;
    }
    if (this.#mode === "following" && readerMovedTowardHead) {
      this.#transition("reading", this.#newRowCount);
    }
  }

  /**
   * The reader turned the wheel, pressed a key or moved a touch on the log, at `inputAtMs` on the
   * page's performance timeline, the timeline scroll events stamp their samples on.
   */
  public noteReaderInput(inputAtMs: number): void {
    this.#lastReaderInputAtMs = inputAtMs;
  }

  /**
   * The reader's pointer went down in the box, or came up again. While it is down every scroll is
   * theirs: a selection dragged past an edge scrolls the box and sends no other input.
   */
  public notePointerDown(isDown: boolean): void {
    this.#isReaderPointerDown = isDown;
  }

  /**
   * Record where the reader is, so a height change beneath them can be undone. Silent: the point
   * changes on every scrolled pixel, is read where a hold is computed, and is nothing a render
   * draws.
   */
  public capture(anchorPoint: ReadingAnchorPoint): void {
    this.#anchorPoint = anchorPoint;
  }

  /**
   * Start reading at one row: the follow releases and the row's top edge becomes the anchor, at
   * `offsetWithinViewportPx` from the top of the viewport, so the window centers on it and an
   * append holds it there. A link to a message reads from the top; a press on a control inside
   * the log reads from where the row stands, so the row stays there.
   */
  public readFrom(rowKey: string, offsetWithinViewportPx = 0): void {
    this.#anchorPoint = { rowKey, offsetWithinViewportPx };
    this.#transition(this.#mode === "following" ? "reading" : this.#mode, this.#newRowCount);
  }

  /**
   * End following for a move the reader asked for that has no row to read from yet: a link to a
   * message still being read back.
   */
  public stopFollowing(): void {
    if (this.#mode === "following") {
      this.#transition("reading", this.#newRowCount);
    }
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
   * The pill, and the keyboard's jump.
   *
   * Returns the mode it moved to instead of scrolling: the one module that can move the scroll
   * container performs the move.
   */
  public resumeFollowing(): ReadingMode {
    this.#transition("following", 0);
    return this.#mode;
  }

  /** Hold a row the reader is engaged with. Re-holding under a new reason replaces. */
  public hold(rowKey: string, reason: ReadingHoldReason): void {
    if (this.#holdReasonByRowKey.get(rowKey) === reason) {
      return;
    }
    this.#holdReasonByRowKey.set(rowKey, reason);
    this.#heldRowKeys = [...this.#holdReasonByRowKey.keys()];
    this.#emit();
  }

  /** Stop holding a row; releasing a row not held changes nothing. */
  public release(rowKey: string): void {
    if (this.#holdReasonByRowKey.delete(rowKey)) {
      this.#heldRowKeys = [...this.#holdReasonByRowKey.keys()];
      this.#emit();
    }
  }

  /** Whether the reader holds this row. */
  public isHeld(rowKey: string): boolean {
    return this.#holdReasonByRowKey.has(rowKey);
  }

  /** Every held row, for the window's pass; the same array until a hold or release changes it. */
  public heldRowKeys(): readonly string[] {
    return this.#heldRowKeys;
  }

  /** Why the reader holds this row, or `undefined` when it is not held. */
  public holdReason(rowKey: string): ReadingHoldReason | undefined {
    return this.#holdReasonByRowKey.get(rowKey);
  }

  /** Terminal. Drops every sink so a late append cannot reach an unmounted pane. */
  public dispose(): void {
    this.#stateEmitter.clear();
    this.#holdReasonByRowKey.clear();
    this.#heldRowKeys = [];
  }

  /** Whether the reader's own input moved this sample, read off its scroll event's time stamp. */
  #isReaderScroll(geometry: ScrollGeometry): boolean {
    const inputAtMs = geometry.inputAt;
    if (geometry.cause !== "scroll" || inputAtMs === undefined) {
      return false;
    }
    if (this.#isReaderPointerDown) {
      return true;
    }
    const sinceReaderInputMs =
      this.#lastReaderInputAtMs === undefined ? undefined : inputAtMs - this.#lastReaderInputAtMs;
    return (
      sinceReaderInputMs !== undefined &&
      sinceReaderInputMs >= 0 &&
      sinceReaderInputMs <= TRANSCRIPT_GESTURE_GAP_MS
    );
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

/**
 * Whether the offset fell since the previous sample, whatever the sizes did; a first sample has
 * nothing to stay with, so it counts as a move.
 */
function hasOffsetMovedTowardHead(
  previous: ScrollGeometry | undefined,
  next: ScrollGeometry,
): boolean {
  return previous === undefined || next.scrollTop < previous.scrollTop - SCROLL_GEOMETRY_EPSILON_PX;
}
