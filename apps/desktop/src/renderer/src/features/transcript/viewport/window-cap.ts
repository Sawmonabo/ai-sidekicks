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
  readonly #childKeysByParentKey = new Map<string, string[]>();
  /** Every retained row key, so "is this row's parent here?" costs no scan. */
  readonly #presentRowKeys = new Set<string>();
  readonly #retainedStates: RetainedRowStateTable;

  /**
   * The adopted log, oldest first, which is also prune order. An array rather than a map so a
   * repeated key survives here; the row measurement table reports and handles the repeat.
   */
  #rows: WindowRow[] = [];

  public constructor(options: TranscriptWindowOptions = {}) {
    this.#topLevelCap = options.topLevelCap ?? TRANSCRIPT_WINDOW_ROW_CAP;
    this.#retainedStates = new RetainedRowStateTable(options.parkedStateCap);
  }

  /**
   * Adopt the projected log, oldest first, replacing what the window held.
   *
   * The window is a view over the projection, never a second copy: a row the projection no
   * longer carries is forgotten, and its retained state parked. A row that arrives twice collapses
   * to its first position, so a projection defect cannot double a run group.
   */
  public ingest(rows: readonly WindowRow[]): void {
    this.#rows = [...rows];
    this.#childKeysByParentKey.clear();
    this.#presentRowKeys.clear();
    for (const row of this.#rows) {
      this.#presentRowKeys.add(row.key);
    }
    this.#retainedStates.parkAllExcept(this.#presentRowKeys);
    for (const row of this.#rows) {
      if (row.parentKey === undefined) {
        continue;
      }
      const siblings = this.#childKeysByParentKey.get(row.parentKey);
      if (siblings === undefined) {
        this.#childKeysByParentKey.set(row.parentKey, [row.key]);
      } else if (!siblings.includes(row.key)) {
        siblings.push(row.key);
      }
    }
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
    const topLevelKeys: string[] = [];
    for (const row of this.#rows) {
      if (row.parentKey === undefined || !this.#presentRowKeys.has(row.parentKey)) {
        topLevelKeys.push(row.key);
      }
    }
    return topLevelKeys;
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
      return {
        applied: false,
        deferredBecause: deferral,
        owedBecause: deferral === "under-cap" ? undefined : deferral,
        prunedKeys: [],
        topLevelRetained: this.topLevelRowKeys().length,
      };
    }
    const heldRowKeys = new Set(conditions.heldRowKeys);
    const topLevelKeys = this.topLevelRowKeys();
    const removedKeys = new Set<string>();
    const prunedKeys: string[] = [];
    const keysFromReadingFloor = this.#keysFromReadingFloor(conditions.readingFloorRowKey);
    let remainingToDrop = topLevelKeys.length - this.#topLevelCap;
    let stoppedAtReadingFloor = false;
    for (const key of topLevelKeys) {
      if (remainingToDrop <= 0) {
        break;
      }
      const closure = this.#ancestorClosure(key);
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
      return {
        applied: false,
        deferredBecause: blockedBy,
        owedBecause: blockedBy,
        prunedKeys: [],
        topLevelRetained: topLevelKeys.length,
      };
    }
    this.#rows = this.#rows.filter((row) => !removedKeys.has(row.key));
    for (const removedKey of removedKeys) {
      this.#childKeysByParentKey.delete(removedKey);
      this.#presentRowKeys.delete(removedKey);
    }
    return {
      applied: true,
      deferredBecause: undefined,
      owedBecause: blockedBy,
      prunedKeys,
      topLevelRetained: this.topLevelRowKeys().length,
    };
  }

  #deferralFor(conditions: PruneConditions): PruneDeferralReason | undefined {
    if (this.topLevelRowKeys().length <= this.#topLevelCap) {
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
    const closure: string[] = [];
    const pending: string[] = [rootKey];
    while (pending.length > 0) {
      const key = pending.shift();
      if (key === undefined) {
        continue;
      }
      closure.push(key);
      pending.push(...(this.#childKeysByParentKey.get(key) ?? []));
    }
    return closure;
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
