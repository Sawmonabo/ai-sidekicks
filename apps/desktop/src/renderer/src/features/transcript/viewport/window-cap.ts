// The transcript window: which stretch of the log the viewport holds, what it lets go of, and when.
//
// The window is one span of the projected log, measured in pixels from the reading position and
// never counted in rows. It keeps the rows within the retained share of the reader on each side;
// an edge that drifts past the let-go distance is cut back to the share, and a stretch is admitted
// beyond an edge the reader approaches. Chromium places no element taller than 33,554,431 px, so a
// window that grew with the log would strand the rows past that height.
//
// The span is held by its end rows, so it survives the feed handing over the whole log on every
// pass, and an end at the log's first or last row stays there as the log grows at it. A run group
// goes with its children: no end falls between a row and the row it hangs from. A cut never takes
// the reader's row, a row on screen or a held row; it stops short of the first one, and names it.
//
// The feed hands over the whole projected log on every reconcile, so the key index describes the
// last log ingested and an ingest re-indexes only the span that differs from it.

import {
  TRANSCRIPT_LET_GO_SCREEN_HEIGHTS,
  TRANSCRIPT_RETAINED_SCREEN_HEIGHTS,
  TRANSCRIPT_STRETCH_SCREEN_HEIGHTS,
} from "./caps.js";
import { type ReadingAnchorPoint } from "./reading-anchor.js";
import { RetainedRowStateTable, type RetainedRowState } from "./retained-row-state-table.js";

/** One row as the window sees it. The body is nobody's business here. */
export interface WindowRow {
  readonly key: string;
  /** The run group or row this hangs from; `undefined` for a top-level row. */
  readonly parentKey: string | undefined;
  /** The `transcript.read` cursor this row was read at. */
  readonly rootCursor: string;
}

/** An end of the window: `head` toward the log's first row, `tail` toward its last. */
export type WindowSide = "head" | "tail";

/**
 * Why a pass let nothing go, or stopped short. Closed, so a caller can read back every reason.
 */
export const PRUNE_DEFERRAL_REASONS = [
  "within-share",
  "unmeasured",
  "active-turn",
  "scroll-write",
  "reveal-drain",
  "reading-floor",
  "on-screen-rows",
  "held-rows",
] as const;

/** One deferral reason. Derived from the enumeration, never restated. */
export type PruneDeferralReason = (typeof PRUNE_DEFERRAL_REASONS)[number];

/** What the caller must tell the window before it may admit or let go of anything. */
export interface PruneConditions {
  /** A turn is mid-flight; its rows are still being written to. */
  readonly hasActiveTurn: boolean;
  /** `ScrollController.vetoesPrune()` — a programmatic write is in flight. */
  readonly scrollControllerVetoes: boolean;
  /** The reveal engine has characters queued for this frame. */
  readonly revealDrainInFlight: boolean;
  /** `ReadingAnchor.heldRowKeys()`. A held row is never let go. */
  readonly heldRowKeys: readonly string[];
  /** The rows the viewport has on screen, as the virtualizer laid them out. Never let go. */
  readonly onScreenRowKeys: readonly string[];
  /**
   * Where the reader is: their row and its top edge's offset from the top of the viewport,
   * `"tail"` while they follow it, or `undefined` before they are placed.
   */
  readonly readingPosition: ReadingAnchorPoint | "tail" | undefined;
  /** The viewport's height in pixels, the window's unit; zero or `undefined` before it is known. */
  readonly viewportHeightPx: number | undefined;
  /** A row's height in pixels: as the virtualizer laid it out, else its estimate. */
  readonly heightOf: (rowKey: string) => number;
  /** The side the reader asked a stretch for by approaching it, or `undefined`. */
  readonly admitSide: WindowSide | undefined;
}

/** The result of one pass. */
export interface PruneOutcome {
  /** Whether the pass let rows go. */
  readonly applied: boolean;
  /** Why this pass let nothing go. `undefined` exactly when `applied` is true. */
  readonly deferredBecause: PruneDeferralReason | undefined;
  /**
   * What still holds an edge past the let-go distance after the pass, or `undefined` when nothing
   * is owed. Not a restatement of `deferredBecause`: a cut that stopped short of a held row applied
   * yet leaves rows owed. A caller that re-asks reads this one; `within-share` owes nothing.
   */
  readonly owedBecause: PruneDeferralReason | undefined;
  /** Every key the pass let go, in log order. */
  readonly prunedKeys: readonly string[];
  /**
   * The keys let go above the reader that the window held when its last pass returned, in log
   * order: the height the reader's offset owes. A row that arrived since was never laid out.
   */
  readonly prunedAboveKeys: readonly string[];
}

/** Options for a `TranscriptWindow`. */
export interface TranscriptWindowOptions {
  /** How many let-go rows' retained states are parked; defaults to the shared constant. */
  readonly parkedStateCap?: number;
}

/** The span of the log the viewport holds, sized in screen heights from the reading position. */
export class TranscriptWindow {
  /** Each parent key's child keys over the last ingested log, in log order, each listed once. */
  readonly #childKeysByParentKey = new Map<string, string[]>();
  /** Every key of the last ingested log, so "is this row's parent here?" costs no scan. */
  readonly #ingestedRowKeys = new Set<string>();
  /** Each key's first position in `#positionIndexedRows`, built when a span grows. */
  readonly #positionByKey = new Map<string, number>();
  readonly #retainedStates: RetainedRowStateTable;

  /** The log last ingested, which the next ingest diffs against. */
  #ingestedRows: readonly WindowRow[] = [];
  /**
   * Whether a key repeats in the last ingested log. A key set cannot count a repeat, so while one
   * stands every ingest rebuilds the index.
   */
  #hasRepeatedRowKey = false;
  /** The log `#positionByKey` describes. */
  #positionIndexedRows: readonly WindowRow[] | undefined;
  /** The span's first and last positions in the last ingested log; empty is `0` and `-1`. */
  #headPosition = 0;
  #tailPosition = -1;
  /** The span's end rows, by which the next ingest finds the span in the log it is handed. */
  #headKey: string | undefined;
  #tailKey: string | undefined;
  /** Whether the span starts at the log's first row, so rows landing in front of it join it. */
  #holdsLogHead = true;
  /** Whether the span ends at the log's last row, so appended rows join it. */
  #holdsLogTail = true;
  /** The span's rows, oldest first; a new array exactly when the span or its log changed. */
  #rows: readonly WindowRow[] = [];
  /** The log `#rows` was sliced from. */
  #slicedRows: readonly WindowRow[] = [];
  /** The rows the window held when its last pass returned: what the viewport laid out. */
  #rowsAtLastPrune: readonly WindowRow[] = [];

  public constructor(options: TranscriptWindowOptions = {}) {
    this.#retainedStates = new RetainedRowStateTable(options.parkedStateCap);
  }

  /**
   * Adopt the projected log, oldest first, and find the span in it. The window holds the array
   * rather than copying it, so the caller must not mutate it afterwards.
   *
   * The window is a view over the projection, never a second copy: a row the projection no
   * longer carries is forgotten, and its retained state parked. An end whose row the log no longer
   * carries moves to the log's end on that side, which keeps more rather than guessing. A row that
   * arrives twice is listed once under its parent, at its first position.
   */
  public ingest(rows: readonly WindowRow[]): void {
    if (rows === this.#ingestedRows) {
      return;
    }
    const previousRows = this.#ingestedRows;
    this.#ingestedRows = rows;
    if (this.#hasRepeatedRowKey || !this.#reindexChangedSpan(previousRows, rows)) {
      this.#rebuildIndex(rows);
    }
    this.#retainedStates.parkAllExcept(this.#ingestedRowKeys);
    const lastPosition = rows.length - 1;
    const foundHead = this.#holdsLogHead ? 0 : positionOfKey(rows, this.#headKey);
    const foundTail = this.#holdsLogTail ? lastPosition : positionOfKey(rows, this.#tailKey);
    const head = foundHead < 0 ? 0 : foundHead;
    const tail = foundTail < 0 ? lastPosition : foundTail;
    // Ends the log now carries in the other order hold no span between them; the log is taken whole.
    if (tail < head) {
      this.#placeSpan(0, lastPosition);
    } else {
      this.#placeSpan(head, tail);
    }
  }

  /** The rows the window holds, oldest first; the same array until the span or the log moves. */
  public rows(): readonly WindowRow[] {
    return this.#rows;
  }

  /** Whether the window starts at the log's first row, leaving nothing before it to admit. */
  public get holdsLogHead(): boolean {
    return this.#holdsLogHead;
  }

  /** Whether the window ends at the log's last row, leaving nothing after it to admit. */
  public get holdsLogTail(): boolean {
    return this.#holdsLogTail;
  }

  /** The key of the log's first row, whether or not the window holds it. */
  public get logHeadRowKey(): string | undefined {
    return this.#ingestedRows[0]?.key;
  }

  /** Whether the last ingested log carries a row under this key, held by the window or not. */
  public logHoldsRow(rowKey: string): boolean {
    return this.#ingestedRowKeys.has(rowKey);
  }

  /** A row body's retained state, live or parked. */
  public retainedState(rowKey: string): RetainedRowState | undefined {
    return this.#retainedStates.retainedState(rowKey);
  }

  /** Record what a row body retains while the window holds its row. */
  public setRetainedState(rowKey: string, state: RetainedRowState): void {
    this.#retainedStates.setRetainedState(rowKey, state);
  }

  /**
   * Drop every parked state. Delegated so the idle trim asks the window, which knows which rows
   * are still held, instead of holding the table itself.
   */
  public releaseParkedStates(): void {
    this.#retainedStates.releaseParkedStates();
  }

  /**
   * Admit and let go for one pass, or say why nothing went.
   *
   * A reader outside the span (a jump to the tail, a landing) has the span widened to take them
   * with the retained share around them; a stretch is admitted on the side asked for; then an
   * edge past the let-go distance is cut back to the retained share. With the viewport's height or
   * the reader's place unknown, nothing moves. `owedBecause` is set on every return.
   */
  public prune(conditions: PruneConditions): PruneOutcome {
    const log = this.#ingestedRows;
    const screenHeightPx = conditions.viewportHeightPx ?? 0;
    const readerPosition = this.#readerPositionOf(conditions.readingPosition);
    if (log.length === 0) {
      return this.#settle(this.#headPosition, this.#tailPosition, NOTHING_OWED);
    }
    if (screenHeightPx <= 0 || readerPosition === undefined) {
      return this.#settle(this.#headPosition, this.#tailPosition, deferredOutcome("unmeasured"));
    }
    const lastPosition = log.length - 1;
    const anchorPoint =
      conditions.readingPosition === "tail" ? undefined : conditions.readingPosition;
    const heightOf = conditions.heightOf;
    // Distances run from the viewport's top edge upward and from its bottom edge downward. A
    // follower's viewport ends at the last row; a reader's starts where their row's offset says.
    const above: EdgeWalk =
      anchorPoint === undefined
        ? { log, heightOf, start: lastPosition, step: -1, startDistancePx: -screenHeightPx }
        : {
            log,
            heightOf,
            start: readerPosition - 1,
            step: -1,
            startDistancePx: -anchorPoint.offsetWithinViewportPx,
          };
    const below: EdgeWalk | undefined =
      anchorPoint === undefined
        ? undefined
        : {
            log,
            heightOf,
            start: readerPosition,
            step: 1,
            startDistancePx: anchorPoint.offsetWithinViewportPx - screenHeightPx,
          };
    const retainedPx = TRANSCRIPT_RETAINED_SCREEN_HEIGHTS * screenHeightPx;
    const letGoPx = TRANSCRIPT_LET_GO_SCREEN_HEIGHTS * screenHeightPx;
    const stretchPx = TRANSCRIPT_STRETCH_SCREEN_HEIGHTS * screenHeightPx;

    let head = this.#headPosition;
    let tail = this.#tailPosition;
    let hasGrown = false;
    const isReaderOutside =
      anchorPoint === undefined
        ? tail < lastPosition
        : readerPosition < head || readerPosition > tail;
    if (isReaderOutside) {
      // A jump to the tail or a landing: the span takes the reader and the share around them, and
      // the cut below lets go of what is now far from them.
      const beyondAbove = firstPositionBeyond(above, 0, retainedPx);
      head = Math.min(head, readerPosition, beyondAbove === undefined ? 0 : beyondAbove + 1);
      const beyondBelow =
        below === undefined ? undefined : firstPositionBeyond(below, lastPosition, retainedPx);
      tail =
        below === undefined
          ? lastPosition
          : Math.max(
              tail,
              readerPosition,
              beyondBelow === undefined ? lastPosition : beyondBelow - 1,
            );
      hasGrown = true;
    }
    if (conditions.admitSide === "head" && head > 0) {
      const beyond = firstPositionBeyond(
        { log, heightOf, start: head - 1, step: -1, startDistancePx: 0 },
        0,
        stretchPx,
      );
      head = beyond === undefined ? 0 : beyond + 1;
      hasGrown = true;
    } else if (conditions.admitSide === "tail" && tail < lastPosition) {
      const beyond = firstPositionBeyond(
        { log, heightOf, start: tail + 1, step: 1, startDistancePx: 0 },
        lastPosition,
        stretchPx,
      );
      tail = beyond === undefined ? lastPosition : beyond - 1;
      hasGrown = true;
    }
    if (hasGrown) {
      [head, tail] = this.#takeWholeGroups(head, tail);
    }

    // An edge is cut only once it sits past the let-go distance, and then back to the share.
    const headCutEnd =
      firstPositionBeyond(above, head, letGoPx) === undefined
        ? undefined
        : (firstPositionBeyond(above, head, retainedPx) ?? head - 1) + 1;
    const tailCutStart =
      below === undefined || firstPositionBeyond(below, tail, letGoPx) === undefined
        ? undefined
        : (firstPositionBeyond(below, tail, retainedPx) ?? tail + 1);
    if (headCutEnd === undefined && tailCutStart === undefined) {
      return this.#settle(head, tail, NOTHING_OWED);
    }
    const deferral = deferralFor(conditions);
    if (deferral !== undefined) {
      return this.#settle(head, tail, deferredOutcome(deferral));
    }

    const protectedReasons = protectedRowReasons(conditions, log[readerPosition]?.key);
    let stoppedBecause: PruneDeferralReason | undefined;
    let keptHead = head;
    if (headCutEnd !== undefined) {
      const cut = this.#headCut(head, headCutEnd, tail, protectedReasons);
      keptHead = cut.keptEdge;
      stoppedBecause = cut.stoppedBecause;
    }
    let keptTail = tail;
    if (tailCutStart !== undefined) {
      const cut = this.#tailCut(tailCutStart, tail, keptHead, protectedReasons);
      keptTail = cut.keptEdge;
      stoppedBecause ??= cut.stoppedBecause;
    }
    const prunedAboveRows = log.slice(head, keptHead);
    const prunedBelowRows = log.slice(keptTail + 1, tail + 1);
    if (prunedAboveRows.length === 0 && prunedBelowRows.length === 0) {
      return this.#settle(head, tail, {
        ...deferredOutcome(stoppedBecause ?? "within-share"),
        owedBecause: stoppedBecause,
      });
    }
    const shownRowKeys =
      prunedAboveRows.length === 0
        ? new Set<string>()
        : new Set(this.#rowsAtLastPrune.map((row) => row.key));
    const prunedKeys = [...prunedAboveRows, ...prunedBelowRows].map((row) => row.key);
    for (const prunedKey of prunedKeys) {
      this.#retainedStates.park(prunedKey);
    }
    return this.#settle(keptHead, keptTail, {
      applied: true,
      deferredBecause: undefined,
      owedBecause: stoppedBecause,
      prunedKeys,
      prunedAboveKeys: prunedAboveRows
        .map((row) => row.key)
        .filter((rowKey) => shownRowKeys.has(rowKey)),
    });
  }

  /** Move the span to the positions a pass settled on, and mark what the window now holds. */
  #settle(head: number, tail: number, outcome: PruneOutcome): PruneOutcome {
    this.#placeSpan(head, tail);
    this.#rowsAtLastPrune = this.#rows;
    return outcome;
  }

  #placeSpan(head: number, tail: number): void {
    const log = this.#ingestedRows;
    if (log !== this.#slicedRows || head !== this.#headPosition || tail !== this.#tailPosition) {
      this.#rows = log.slice(head, tail + 1);
    }
    this.#slicedRows = log;
    this.#headPosition = head;
    this.#tailPosition = tail;
    this.#headKey = log[head]?.key;
    this.#tailKey = log[tail]?.key;
    this.#holdsLogHead = head <= 0;
    this.#holdsLogTail = tail >= log.length - 1;
  }

  /** The reader's position in the log: the last row while following, `undefined` when unplaced. */
  #readerPositionOf(readingPosition: PruneConditions["readingPosition"]): number | undefined {
    if (readingPosition === undefined) {
      return undefined;
    }
    if (readingPosition === "tail") {
      return this.#ingestedRows.length - 1;
    }
    const position = positionOfKey(this.#ingestedRows, readingPosition.rowKey);
    return position < 0 ? undefined : position;
  }

  /**
   * Where the head cut ends: before the first protected row, and before any row tied by hanging
   * to a row the window keeps, so a run group never leaves without its children.
   */
  #headCut(
    head: number,
    cutEnd: number,
    tail: number,
    protectedReasons: ReadonlyMap<string, PruneDeferralReason>,
  ): WindowCut {
    let keptHead = cutEnd;
    let stoppedBecause: PruneDeferralReason | undefined;
    for (let position = head; position < keptHead; position += 1) {
      const reason = protectedReasons.get(this.#ingestedRows[position]?.key ?? "");
      if (reason !== undefined) {
        keptHead = position;
        stoppedBecause = reason;
        break;
      }
    }
    for (;;) {
      const tiedPosition = this.#firstTiedPosition(head, keptHead - 1, head, tail, 1);
      if (tiedPosition === undefined) {
        return { keptEdge: keptHead, stoppedBecause };
      }
      keptHead = tiedPosition;
    }
  }

  /** Where the tail cut starts, under the same stops as the head cut, read from the tail up. */
  #tailCut(
    cutStart: number,
    tail: number,
    head: number,
    protectedReasons: ReadonlyMap<string, PruneDeferralReason>,
  ): WindowCut {
    let keptTail = cutStart - 1;
    let stoppedBecause: PruneDeferralReason | undefined;
    for (let position = tail; position > keptTail; position -= 1) {
      const reason = protectedReasons.get(this.#ingestedRows[position]?.key ?? "");
      if (reason !== undefined) {
        keptTail = position;
        stoppedBecause = reason;
        break;
      }
    }
    for (;;) {
      const tiedPosition = this.#firstTiedPosition(tail, keptTail + 1, head, tail, -1);
      if (tiedPosition === undefined) {
        return { keptEdge: keptTail, stoppedBecause };
      }
      keptTail = tiedPosition;
    }
  }

  /**
   * The first row, walking a cut range from the window's edge (`outerEnd`) in to `innerEnd`, whose
   * parent or child the window keeps; `undefined` when the cut takes whole groups.
   */
  #firstTiedPosition(
    outerEnd: number,
    innerEnd: number,
    head: number,
    tail: number,
    step: 1 | -1,
  ): number | undefined {
    const log = this.#ingestedRows;
    if (step === 1 ? innerEnd < outerEnd : innerEnd > outerEnd) {
      return undefined;
    }
    const cutKeys = new Set<string>();
    for (let position = outerEnd; position !== innerEnd + step; position += step) {
      cutKeys.add(log[position]?.key ?? "");
    }
    const windowKeys = new Set(log.slice(head, tail + 1).map((row) => row.key));
    for (let position = outerEnd; position !== innerEnd + step; position += step) {
      const row = log[position];
      if (row === undefined) {
        continue;
      }
      const isTiedAcross = this.#tiedKeysOf(row).some(
        (tiedKey) => !cutKeys.has(tiedKey) && windowKeys.has(tiedKey),
      );
      if (isTiedAcross) {
        return position;
      }
    }
    return undefined;
  }

  /** Widen a span until every row in it has its parent and its children in it too. */
  #takeWholeGroups(head: number, tail: number): readonly [number, number] {
    let first = head;
    let last = tail;
    let unread: (readonly [number, number])[] = [[head, tail]];
    while (unread.length > 0) {
      let nextFirst = first;
      let nextLast = last;
      for (const [from, to] of unread) {
        for (let position = from; position <= to; position += 1) {
          const row = this.#ingestedRows[position];
          for (const tiedKey of row === undefined ? [] : this.#tiedKeysOf(row)) {
            const tiedPosition = this.#positionOf(tiedKey);
            if (tiedPosition !== undefined) {
              nextFirst = Math.min(nextFirst, tiedPosition);
              nextLast = Math.max(nextLast, tiedPosition);
            }
          }
        }
      }
      unread = [];
      if (nextFirst < first) {
        unread.push([nextFirst, first - 1]);
      }
      if (nextLast > last) {
        unread.push([last + 1, nextLast]);
      }
      first = nextFirst;
      last = nextLast;
    }
    return [first, last];
  }

  /** The keys a row hangs from or holds that the log carries: its parent and its children. */
  #tiedKeysOf(row: WindowRow): readonly string[] {
    const childKeys = this.#childKeysByParentKey.get(row.key) ?? [];
    return row.parentKey !== undefined && this.#ingestedRowKeys.has(row.parentKey)
      ? [row.parentKey, ...childKeys]
      : childKeys;
  }

  /** A key's first position in the last ingested log, indexed once per log on first ask. */
  #positionOf(rowKey: string): number | undefined {
    if (this.#positionIndexedRows !== this.#ingestedRows) {
      this.#positionByKey.clear();
      for (const [position, row] of this.#ingestedRows.entries()) {
        if (!this.#positionByKey.has(row.key)) {
          this.#positionByKey.set(row.key, position);
        }
      }
      this.#positionIndexedRows = this.#ingestedRows;
    }
    return this.#positionByKey.get(rowKey);
  }

  /** Index every row, discarding the old index. */
  #rebuildIndex(rows: readonly WindowRow[]): void {
    this.#ingestedRowKeys.clear();
    this.#childKeysByParentKey.clear();
    for (const row of rows) {
      this.#ingestedRowKeys.add(row.key);
    }
    this.#hasRepeatedRowKey = this.#ingestedRowKeys.size !== rows.length;
    // Only a repeated key can list a child twice under one parent, so these exist only then.
    const listedChildKeysByParentKey = this.#hasRepeatedRowKey
      ? new Map<string, Set<string>>()
      : undefined;
    for (const row of rows) {
      if (row.parentKey === undefined) {
        continue;
      }
      if (listedChildKeysByParentKey !== undefined) {
        const listedChildKeys = listedChildKeysByParentKey.get(row.parentKey) ?? new Set<string>();
        if (listedChildKeys.has(row.key)) {
          continue;
        }
        listedChildKeys.add(row.key);
        listedChildKeysByParentKey.set(row.parentKey, listedChildKeys);
      }
      const siblingKeys = this.#childKeysByParentKey.get(row.parentKey);
      if (siblingKeys === undefined) {
        this.#childKeysByParentKey.set(row.parentKey, [row.key]);
      } else {
        siblingKeys.push(row.key);
      }
    }
  }

  /**
   * Re-index only what differs between the last ingested log and `nextRows`. Answers `false`,
   * leaving a partial index for the caller to rebuild, when the two share neither a head nor a
   * tail or `nextRows` repeats a key.
   *
   * The changed span is re-indexed together with the shorter shared end, so the rows it forgets
   * and adds sit at one end of the log, and each child list it touches changes only at that end.
   */
  #reindexChangedSpan(previousRows: readonly WindowRow[], nextRows: readonly WindowRow[]): boolean {
    const sharedHeadCount = sharedHeadLength(previousRows, nextRows);
    const sharedTailCount = sharedTailLength(previousRows, nextRows, sharedHeadCount);
    if (sharedHeadCount === 0 && sharedTailCount === 0) {
      return false;
    }
    if (sharedHeadCount >= sharedTailCount) {
      this.#unindexRows(previousRows.slice(sharedHeadCount), "tail");
      return this.#indexRows(nextRows.slice(sharedHeadCount), "tail");
    }
    this.#unindexRows(previousRows.slice(0, previousRows.length - sharedTailCount), "head");
    return this.#indexRows(nextRows.slice(0, nextRows.length - sharedTailCount), "head");
  }

  /**
   * Forget rows that sit together at one end of the last ingested log. Their children are the
   * same end of each parent's list, since the list is in log order and holds no repeat.
   */
  #unindexRows(rows: readonly WindowRow[], end: WindowSide): void {
    const forgottenCountByParentKey = new Map<string, number>();
    for (const row of rows) {
      this.#ingestedRowKeys.delete(row.key);
      if (row.parentKey !== undefined) {
        const forgottenCount = forgottenCountByParentKey.get(row.parentKey) ?? 0;
        forgottenCountByParentKey.set(row.parentKey, forgottenCount + 1);
      }
    }
    for (const [parentKey, forgottenCount] of forgottenCountByParentKey) {
      const siblingKeys = this.#childKeysByParentKey.get(parentKey) ?? [];
      if (end === "head") {
        siblingKeys.splice(0, forgottenCount);
      } else {
        siblingKeys.length -= forgottenCount;
      }
      if (siblingKeys.length === 0) {
        this.#childKeysByParentKey.delete(parentKey);
      }
    }
  }

  /**
   * Index rows that go together at one end of the log; `false` when one repeats a key.
   */
  #indexRows(rows: readonly WindowRow[], end: WindowSide): boolean {
    const addedChildKeysByParentKey = new Map<string, string[]>();
    for (const row of rows) {
      if (this.#ingestedRowKeys.has(row.key)) {
        return false;
      }
      this.#ingestedRowKeys.add(row.key);
      if (row.parentKey !== undefined) {
        const addedChildKeys = addedChildKeysByParentKey.get(row.parentKey);
        if (addedChildKeys === undefined) {
          addedChildKeysByParentKey.set(row.parentKey, [row.key]);
        } else {
          addedChildKeys.push(row.key);
        }
      }
    }
    for (const [parentKey, addedChildKeys] of addedChildKeysByParentKey) {
      const siblingKeys = this.#childKeysByParentKey.get(parentKey);
      if (siblingKeys === undefined) {
        this.#childKeysByParentKey.set(parentKey, addedChildKeys);
      } else if (end === "head") {
        this.#childKeysByParentKey.set(parentKey, addedChildKeys.concat(siblingKeys));
      } else {
        for (const addedChildKey of addedChildKeys) {
          siblingKeys.push(addedChildKey);
        }
      }
    }
    return true;
  }
}

/** A pass that had nothing past the let-go distance on either side. */
const NOTHING_OWED: PruneOutcome = deferredOutcome("within-share");

/** One side's cut: the last position kept on that side, and what stopped it short, if anything. */
interface WindowCut {
  readonly keptEdge: number;
  readonly stoppedBecause: PruneDeferralReason | undefined;
}

/**
 * A walk outward from the viewport over the log: the first position, the direction, and the
 * distance of that first row's near edge from the viewport's edge on that side.
 */
interface EdgeWalk {
  readonly log: readonly WindowRow[];
  readonly heightOf: (rowKey: string) => number;
  readonly start: number;
  readonly step: 1 | -1;
  readonly startDistancePx: number;
}

/**
 * The first position of a walk, no further than `bound`, whose near edge sits `linePx` or more
 * from the viewport, or `undefined` when none does. A row's distance is the walk's start distance
 * plus the heights of the rows walked before it.
 */
function firstPositionBeyond(walk: EdgeWalk, bound: number, linePx: number): number | undefined {
  let distancePx = walk.startDistancePx;
  for (
    let position = walk.start;
    walk.step < 0 ? position >= bound : position <= bound;
    position += walk.step
  ) {
    if (distancePx >= linePx) {
      return position;
    }
    distancePx += walk.heightOf(walk.log[position]?.key ?? "");
  }
  return undefined;
}

/** A pass that let nothing go, for one reason it names and owes. */
function deferredOutcome(reason: PruneDeferralReason): PruneOutcome {
  return {
    applied: false,
    deferredBecause: reason,
    owedBecause: reason === "within-share" ? undefined : reason,
    prunedKeys: [],
    prunedAboveKeys: [],
  };
}

/** The refusal a cut waits out, decided before any row is read. */
function deferralFor(conditions: PruneConditions): PruneDeferralReason | undefined {
  if (conditions.hasActiveTurn) {
    return "active-turn";
  }
  if (conditions.scrollControllerVetoes) {
    return "scroll-write";
  }
  if (conditions.revealDrainInFlight) {
    return "reveal-drain";
  }
  return undefined;
}

/**
 * Every row a cut must stop short of, with the reason it names: a held row, a row on screen, and
 * the reader's row, which outranks the others.
 */
function protectedRowReasons(
  conditions: PruneConditions,
  readerRowKey: string | undefined,
): ReadonlyMap<string, PruneDeferralReason> {
  const reasons = new Map<string, PruneDeferralReason>();
  for (const heldRowKey of conditions.heldRowKeys) {
    reasons.set(heldRowKey, "held-rows");
  }
  for (const onScreenRowKey of conditions.onScreenRowKeys) {
    reasons.set(onScreenRowKey, "on-screen-rows");
  }
  if (readerRowKey !== undefined) {
    reasons.set(readerRowKey, "reading-floor");
  }
  return reasons;
}

/** A key's first position in a log, or `-1`; a repeated key resolves to its first occurrence. */
function positionOfKey(rows: readonly WindowRow[], rowKey: string | undefined): number {
  return rowKey === undefined ? -1 : rows.findIndex((row) => row.key === rowKey);
}

/**
 * Whether two rows are alike to the index, which reads only a row's key and parent key. A row past
 * either log's end matches nothing, which is where the shared-span scans stop.
 */
function hasSamePlacement(
  previousRow: WindowRow | undefined,
  nextRow: WindowRow | undefined,
): boolean {
  return (
    previousRow !== undefined &&
    nextRow !== undefined &&
    (previousRow === nextRow ||
      (previousRow.key === nextRow.key && previousRow.parentKey === nextRow.parentKey))
  );
}

/** How many rows, from the head, two logs share. */
function sharedHeadLength(
  previousRows: readonly WindowRow[],
  nextRows: readonly WindowRow[],
): number {
  let length = 0;
  while (hasSamePlacement(previousRows[length], nextRows[length])) {
    length += 1;
  }
  return length;
}

/** How many rows, from the tail, two logs share without reaching into their shared head. */
function sharedTailLength(
  previousRows: readonly WindowRow[],
  nextRows: readonly WindowRow[],
  sharedHeadCount: number,
): number {
  const longestTail = Math.min(previousRows.length, nextRows.length) - sharedHeadCount;
  let length = 0;
  while (
    length < longestTail &&
    hasSamePlacement(
      previousRows[previousRows.length - 1 - length],
      nextRows[nextRows.length - 1 - length],
    )
  ) {
    length += 1;
  }
  return length;
}
