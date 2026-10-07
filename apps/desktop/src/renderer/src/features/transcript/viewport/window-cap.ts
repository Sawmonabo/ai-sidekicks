// The transcript window: what the log keeps, what it lets go of, and when.
//
// Chromium places no element taller than 33,554,431 px, so an uncapped log's total-size spacer
// would stop growing and strand the rows below it; the cap is a ceiling, not a nicety.
//
// Only top-level rows count, so a run group with two hundred tool rows is one row. A row whose
// `parentKey` names no row the window holds is top-level here: reading "has a parent key" as
// "is a child" let a run-only log grow without bound. Prune is a request that can be refused
// for a named reason, drops a parent's subtree with it, never drops held rows or those from
// the reader's row down, and parks (never loses) the retained state of a dropped row.
//
// The feed hands over the whole projected log on every reconcile, so the key index describes the
// last log ingested and an ingest re-indexes only the span that differs from it. A prune records
// what it dropped beside that index instead of editing it, so the next ingest still diffs against
// the log it was last handed. Since the same head rows are dropped again on every pass, a prune
// also names the rows that left the window its last pass returned, which is all a pass's reader
// has to pay for.

import { RetainedRowStateTable, type RetainedRowState } from "./retained-row-state-table.js";
import { TRANSCRIPT_WINDOW_ROW_CAP } from "./caps.js";

/** One row as the window sees it. The body is nobody's business here. */
export interface WindowRow {
  readonly key: string;
  /** The run group or row this hangs from; `undefined` for a top-level row. */
  readonly parentKey: string | undefined;
  /** The `transcript.read` cursor this row was read at — the unit a pin cuts by. */
  readonly rootCursor: string;
}

/**
 * Why a prune did not happen. Closed, so a caller can read back every reason a prune deferred.
 */
export const PRUNE_DEFERRAL_REASONS = [
  "under-cap",
  "active-turn",
  "scroll-write",
  "reveal-drain",
  "pinned-history",
  "reading-floor",
  "held-rows",
] as const;

/** One deferral reason. Derived from the enumeration, never restated. */
export type PruneDeferralReason = (typeof PRUNE_DEFERRAL_REASONS)[number];

/** What the caller must tell the window before it may drop anything. */
export interface PruneConditions {
  /** A turn is mid-flight; its rows are still being written to. */
  readonly hasActiveTurn: boolean;
  /** `ScrollController.vetoesPrune()` — a programmatic write is in flight. */
  readonly scrollControllerVetoes: boolean;
  /** The reveal engine has characters queued for this frame. */
  readonly revealDrainInFlight: boolean;
  /** `ReadingAnchor.state.pinnedRootCursor`. Pinned history is never trimmed. */
  readonly pinnedRootCursor: string | undefined;
  /** `ReadingAnchor.heldRowKeys()`. A held row survives the cap. */
  readonly heldRowKeys: readonly string[];
  /**
   * The row the reader is on, or `undefined` while they are at the tail.
   *
   * A floor stops the drop walk, where a held key would only be skipped: skipping would open a
   * hole directly below a reader parked in the middle of a long log.
   */
  readonly readingFloorRowKey: string | undefined;
}

/** The result of one prune pass. */
export interface PruneOutcome {
  readonly applied: boolean;
  /** Why this pass took nothing. `undefined` exactly when `applied` is true. */
  readonly deferredBecause: PruneDeferralReason | undefined;
  /**
   * What still holds the window over its cap after the pass, or `undefined` when it is within
   * its cap.
   * Not a restatement of `deferredBecause`: a walk that stopped at the reading floor after
   * taking rows applied (`deferredBecause` is `undefined`) yet leaves the window over its cap.
   * A caller that re-asks reads this one. `under-cap` owes nothing.
   */
  readonly owedBecause: PruneDeferralReason | undefined;
  /** Every key dropped, ancestors and their subtrees together. */
  readonly prunedKeys: readonly string[];
  /**
   * The dropped keys the window held when its last prune returned, in drop order: the rows that
   * left the window it published then. A row dropped again, or one that arrived since and was
   * never shown, is not among them.
   */
  readonly newlyPrunedKeys: readonly string[];
  readonly topLevelRetained: number;
}

/** Caps for a `TranscriptWindow`; each defaults to the shared transcript constant. */
export interface TranscriptWindowOptions {
  readonly topLevelCap?: number;
  readonly parkedStateCap?: number;
}

/** The retained transcript rows, capped by top-level count and pruned only when allowed. */
export class TranscriptWindow {
  readonly #topLevelCap: number;
  /** Each parent key's child keys over the last ingested log, in log order, each listed once. */
  readonly #childKeysByParentKey = new Map<string, string[]>();
  /** Every key of the last ingested log, so "is this row's parent here?" costs no scan. */
  readonly #ingestedRowKeys = new Set<string>();
  /** Keys the log gained since the last prune returned: rows the window published then lacked. */
  readonly #arrivedRowKeys = new Set<string>();
  readonly #retainedStates: RetainedRowStateTable;

  /** Keys a prune dropped since the last ingest; the window no longer holds them. */
  #prunedRowKeys = new Set<string>();
  /** The keys the window had dropped when its last prune returned. */
  #droppedAtLastPrune: ReadonlySet<string> = new Set<string>();

  /** The log last ingested, which the next ingest diffs against. */
  #ingestedRows: readonly WindowRow[] = [];
  /**
   * Whether a key repeats in the last ingested log. A key set cannot count a repeat, so while one
   * stands every ingest rebuilds the index.
   */
  #hasRepeatedRowKey = false;
  /**
   * Rows of the last ingested log whose parent that log holds. With no repeated key this is the
   * summed length of every ingested key's child list, kept as keys and lists change.
   */
  #childRowCount = 0;
  /** Top-level rows the window holds now, kept so the cap is checked without walking the log. */
  #topLevelRowCount = 0;
  /**
   * The adopted log, oldest first, which is also prune order. An array rather than a map so a
   * repeated key survives here; the row measurement table reports and handles the repeat.
   */
  #rows: readonly WindowRow[] = [];

  public constructor(options: TranscriptWindowOptions = {}) {
    this.#topLevelCap = options.topLevelCap ?? TRANSCRIPT_WINDOW_ROW_CAP;
    this.#retainedStates = new RetainedRowStateTable(options.parkedStateCap);
  }

  /**
   * Adopt the projected log, oldest first, replacing what the window held, rows a prune dropped
   * included. The window holds the array rather than copying it, so the caller must not mutate it
   * afterwards.
   *
   * The window is a view over the projection, never a second copy: a row the projection no
   * longer carries is forgotten, and its retained state parked. Only the span that differs from
   * the last ingested log is re-indexed; a log sharing neither its head nor its tail with that one
   * is indexed whole. A row that arrives twice is listed once under its parent, at its first
   * position, so a projection defect cannot double a run group's subtree.
   */
  public ingest(rows: readonly WindowRow[]): void {
    const previousRows = this.#ingestedRows;
    this.#ingestedRows = rows;
    this.#rows = rows;
    // A new set rather than a cleared one: the last prune's still says what it had dropped.
    this.#prunedRowKeys = new Set<string>();
    const arrivedRowKeys =
      (this.#hasRepeatedRowKey ? undefined : this.#reindexChangedSpan(previousRows, rows)) ??
      this.#rebuildIndex(previousRows, rows);
    for (const arrivedRowKey of arrivedRowKeys) {
      this.#arrivedRowKeys.add(arrivedRowKey);
    }
    this.#topLevelRowCount = rows.length - this.#childRowCount;
    this.#retainedStates.parkAllExcept(this.#ingestedRowKeys);
  }

  /** Every retained row, oldest first. */
  public rows(): readonly WindowRow[] {
    return [...this.#rows];
  }

  /**
   * Retained top-level rows, the only ones the cap counts. A row naming a parent this window
   * does not hold is top-level too; see the header.
   */
  public topLevelRowKeys(): readonly string[] {
    return this.#rows.filter((row) => this.#isTopLevel(row)).map((row) => row.key);
  }

  /** How many rows the window holds. */
  public get size(): number {
    return this.#rows.length;
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
   * Drop the oldest top-level rows, or say why it could not.
   *
   * `owedBecause` is set on every return, including an applied pass: the walk can stop at the
   * reader's row or skip every candidate as held and still leave the window over its cap.
   * `reading-floor` and `held-rows` are only known once the walk has run; the other refusals
   * are decided up front and clear within a frame or two.
   */
  public prune(conditions: PruneConditions): PruneOutcome {
    const deferral = this.#deferralFor(conditions);
    if (deferral !== undefined) {
      return this.#settle({
        applied: false,
        deferredBecause: deferral,
        owedBecause: deferral === "under-cap" ? undefined : deferral,
        prunedKeys: [],
        newlyPrunedKeys: [],
        topLevelRetained: this.#topLevelRowCount,
      });
    }
    const heldRowKeys = new Set(conditions.heldRowKeys);
    const removedKeys = new Set<string>();
    const prunedKeys: string[] = [];
    const newlyPrunedKeys: string[] = [];
    const keysFromReadingFloor = this.#keysFromReadingFloor(conditions.readingFloorRowKey);
    let remainingToDrop = this.#topLevelRowCount - this.#topLevelCap;
    let stoppedAtReadingFloor = false;
    // Oldest first, and no further than the cap needs.
    for (const row of this.#rows) {
      if (remainingToDrop <= 0) {
        break;
      }
      if (!this.#isTopLevel(row)) {
        continue;
      }
      const closure = this.#ancestorClosure(row.key);
      if (closure.some((closedKey) => keysFromReadingFloor.has(closedKey))) {
        stoppedAtReadingFloor = true;
        break;
      }
      if (closure.some((closedKey) => heldRowKeys.has(closedKey))) {
        // A held row is never pruned and never orphaned: a run group with an open child stays
        // whole.
        continue;
      }
      for (const closedKey of closure) {
        if (removedKeys.has(closedKey)) {
          continue;
        }
        removedKeys.add(closedKey);
        this.#retainedStates.park(closedKey);
        prunedKeys.push(closedKey);
        if (this.#wasHeldAtLastPrune(closedKey)) {
          newlyPrunedKeys.push(closedKey);
        }
      }
      remainingToDrop -= 1;
    }
    // `remainingToDrop` above zero means the window is still over its cap: the reader's floor
    // stopped the walk, or every remaining candidate was held.
    const blockedBy: PruneDeferralReason | undefined =
      remainingToDrop <= 0 ? undefined : stoppedAtReadingFloor ? "reading-floor" : "held-rows";
    if (blockedBy !== undefined && prunedKeys.length === 0) {
      // Named rather than returned as an applied prune with an empty key list, which would be
      // indistinguishable from a window already under cap.
      return this.#settle({
        applied: false,
        deferredBecause: blockedBy,
        owedBecause: blockedBy,
        prunedKeys: [],
        newlyPrunedKeys: [],
        topLevelRetained: this.#topLevelRowCount,
      });
    }
    let removedTopLevelCount = 0;
    this.#rows = this.#rows.filter((row) => {
      if (!removedKeys.has(row.key)) {
        return true;
      }
      if (this.#isTopLevel(row)) {
        removedTopLevelCount += 1;
      }
      return false;
    });
    for (const removedKey of removedKeys) {
      this.#prunedRowKeys.add(removedKey);
    }
    // The closure takes every row hanging from a dropped row, so no kept row turns top-level.
    this.#topLevelRowCount -= removedTopLevelCount;
    return this.#settle({
      applied: true,
      deferredBecause: undefined,
      owedBecause: blockedBy,
      prunedKeys,
      newlyPrunedKeys,
      topLevelRetained: this.#topLevelRowCount,
    });
  }

  /** Mark what the window holds as a pass returns, which the next pass's newly pruned rows read. */
  #settle(outcome: PruneOutcome): PruneOutcome {
    this.#droppedAtLastPrune = this.#prunedRowKeys;
    this.#arrivedRowKeys.clear();
    return outcome;
  }

  /** Whether the window held a row of its log when its last prune returned. */
  #wasHeldAtLastPrune(rowKey: string): boolean {
    return !this.#arrivedRowKeys.has(rowKey) && !this.#droppedAtLastPrune.has(rowKey);
  }

  #deferralFor(conditions: PruneConditions): PruneDeferralReason | undefined {
    if (this.#topLevelRowCount <= this.#topLevelCap) {
      return "under-cap";
    }
    if (conditions.pinnedRootCursor !== undefined) {
      return "pinned-history";
    }
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

  /** A row and every descendant beneath it, parents before children. */
  #ancestorClosure(rootKey: string): readonly string[] {
    const closure: string[] = [rootKey];
    // The loop also visits each key appended while it runs, so the array is its own queue.
    for (const key of closure) {
      closure.push(...this.#childKeysOf(key));
    }
    return closure;
  }

  /** Whether a held row counts against the cap: it has no parent the window holds. */
  #isTopLevel(row: WindowRow): boolean {
    return row.parentKey === undefined || !this.#holdsRowKey(row.parentKey);
  }

  /**
   * Whether the window holds a row under this key: ingested, and not pruned since. No key is
   * pruned between an ingest and its prune, so that lookup is skipped then; the prune walk asks
   * this once per row.
   */
  #holdsRowKey(rowKey: string): boolean {
    return (
      this.#ingestedRowKeys.has(rowKey) &&
      (this.#prunedRowKeys.size === 0 || !this.#prunedRowKeys.has(rowKey))
    );
  }

  /** A row's child keys in log order; none once a prune dropped the row. */
  #childKeysOf(rowKey: string): readonly string[] {
    return this.#prunedRowKeys.has(rowKey) ? [] : (this.#childKeysByParentKey.get(rowKey) ?? []);
  }

  /**
   * Index every row, discarding the old index, and answer the keys `previousRows` lacked. Those
   * are read off the rows rather than the old index, which a failed re-index left partial.
   */
  #rebuildIndex(
    previousRows: readonly WindowRow[],
    rows: readonly WindowRow[],
  ): ReadonlySet<string> {
    const previousRowKeys = new Set<string>();
    for (const row of previousRows) {
      previousRowKeys.add(row.key);
    }
    const arrivedRowKeys = new Set<string>();
    this.#ingestedRowKeys.clear();
    this.#childKeysByParentKey.clear();
    for (const row of rows) {
      this.#ingestedRowKeys.add(row.key);
      if (!previousRowKeys.has(row.key)) {
        arrivedRowKeys.add(row.key);
      }
    }
    this.#hasRepeatedRowKey = this.#ingestedRowKeys.size !== rows.length;
    // Only a repeated key can list a child twice under one parent, so these exist only then.
    const listedChildKeysByParentKey = this.#hasRepeatedRowKey
      ? new Map<string, Set<string>>()
      : undefined;
    this.#childRowCount = 0;
    for (const row of rows) {
      if (row.parentKey === undefined) {
        continue;
      }
      if (this.#ingestedRowKeys.has(row.parentKey)) {
        this.#childRowCount += 1;
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
    return arrivedRowKeys;
  }

  /**
   * Re-index only what differs between the last ingested log and `nextRows`, and answer the keys
   * the re-indexed span gained. Answers `undefined`, leaving a partial index for the caller to
   * rebuild, when the two share neither a head nor a tail or `nextRows` repeats a key.
   *
   * The changed span is re-indexed together with the shorter shared end, so the rows it forgets
   * and adds sit at one end of the log, and each child list it touches changes only at that end.
   */
  #reindexChangedSpan(
    previousRows: readonly WindowRow[],
    nextRows: readonly WindowRow[],
  ): ReadonlySet<string> | undefined {
    const sharedHeadCount = sharedHeadLength(previousRows, nextRows);
    const sharedTailCount = sharedTailLength(previousRows, nextRows, sharedHeadCount);
    if (sharedHeadCount === 0 && sharedTailCount === 0) {
      return undefined;
    }
    if (sharedHeadCount >= sharedTailCount) {
      const forgottenRowKeys = this.#unindexRows(previousRows.slice(sharedHeadCount), "tail");
      return this.#indexRows(nextRows.slice(sharedHeadCount), "tail", forgottenRowKeys);
    }
    const forgottenRowKeys = this.#unindexRows(
      previousRows.slice(0, previousRows.length - sharedTailCount),
      "head",
    );
    return this.#indexRows(
      nextRows.slice(0, nextRows.length - sharedTailCount),
      "head",
      forgottenRowKeys,
    );
  }

  /**
   * Forget rows that sit together at one end of the last ingested log, and answer their keys.
   * Their children are the same end of each parent's list, since the list is in log order and
   * holds no repeat.
   */
  #unindexRows(rows: readonly WindowRow[], end: LogEnd): ReadonlySet<string> {
    const forgottenRowKeys = new Set<string>();
    const forgottenCountByParentKey = new Map<string, number>();
    for (const row of rows) {
      forgottenRowKeys.add(row.key);
      this.#ingestedRowKeys.delete(row.key);
      this.#childRowCount -= this.#childKeysByParentKey.get(row.key)?.length ?? 0;
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
      if (this.#ingestedRowKeys.has(parentKey)) {
        this.#childRowCount -= forgottenCount;
      }
      if (siblingKeys.length === 0) {
        this.#childKeysByParentKey.delete(parentKey);
      }
    }
    return forgottenRowKeys;
  }

  /**
   * Index rows that go together at one end of the log, and answer the keys among them that the
   * span this replaces lacked; `undefined` when one repeats a key.
   */
  #indexRows(
    rows: readonly WindowRow[],
    end: LogEnd,
    forgottenRowKeys: ReadonlySet<string>,
  ): ReadonlySet<string> | undefined {
    const arrivedRowKeys = new Set<string>();
    const addedChildKeysByParentKey = new Map<string, string[]>();
    for (const row of rows) {
      if (this.#ingestedRowKeys.has(row.key)) {
        return undefined;
      }
      this.#ingestedRowKeys.add(row.key);
      if (!forgottenRowKeys.has(row.key)) {
        arrivedRowKeys.add(row.key);
      }
      this.#childRowCount += this.#childKeysByParentKey.get(row.key)?.length ?? 0;
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
      if (this.#ingestedRowKeys.has(parentKey)) {
        this.#childRowCount += addedChildKeys.length;
      }
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
    return arrivedRowKeys;
  }

  /**
   * Every key from the reader's row to the end of the window, the set the drop may not touch;
   * empty when there is no floor, or when the floor names a row the window no longer holds.
   * A repeated key resolves to its first occurrence, which protects the most.
   */
  #keysFromReadingFloor(readingFloorRowKey: string | undefined): ReadonlySet<string> {
    const keysFromFloor = new Set<string>();
    if (readingFloorRowKey === undefined) {
      return keysFromFloor;
    }
    const floorPosition = this.#rows.findIndex((row) => row.key === readingFloorRowKey);
    if (floorPosition < 0) {
      return keysFromFloor;
    }
    for (let position = floorPosition; position < this.#rows.length; position += 1) {
      const rowKey = this.#rows[position]?.key;
      if (rowKey !== undefined) {
        keysFromFloor.add(rowKey);
      }
    }
    return keysFromFloor;
  }
}

/** The end of the log a re-indexed span sits at. */
type LogEnd = "head" | "tail";

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
