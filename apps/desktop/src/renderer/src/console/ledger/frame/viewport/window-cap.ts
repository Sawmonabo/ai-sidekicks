// The ledger window — what the log keeps, what it lets go, and when it is allowed
// to let go of it.
//
// `Spec-023 §Console Libraries`, timeline-virtualization row, puts this module on the
// own-build side and says why it exists at all: "Chromium caps element height at
// 33,554,431 px, so the window cap is a ceiling, not a nicety." THE SEMANTICS ARE THIS
// MODULE'S, because no committed document states them: the window caps top-level rows
// and chapters, mirroring `timeline.read` window semantics; children never trip the cap.
// Prune is deferred during an active turn, vetoed by the scroll controller, never lands
// during a reveal drain, can never orphan a child (ancestor closure), and re-parks
// leased row state under synthetic keys.
//
// FIVE PROPERTIES, and each one is a failure this module exists to make
// unrepresentable:
//
//   • **Only top-level rows count.** A chapter with two hundred tool rows under it
//     is one row against the cap. Counting children would make a busy run evict the
//     entire conversation around it.
//
//     TOP-LEVEL IS A FACT ABOUT THIS WINDOW, not about the row. A row whose
//     `parentKey` names no row the window holds is top-level HERE, because there is
//     no head for it to be counted against and nothing the cap could drop instead
//     of it. Reading "has a parent key" as "is a child" is what let a run-only log
//     grow without bound: every row named its run, no row WAS its run, and the cap
//     counted nobody. The orphan is also its own cut unit — dropping it drops its
//     own subtree and no sibling's, so a run does not lose its middle.
//   • **Prune is a REQUEST, not an act.** A closed set of conditions can refuse
//     it, each with a name the caller can read back. A prune that silently did
//     nothing would be indistinguishable from a window already under cap.
//   • **Ancestor closure.** Dropping a parent drops its subtree in the same pass. A
//     child left behind renders under a parent that is not there, which is the
//     orphan this property exists to make unrepresentable.
//   • **Held rows are never pruned**, however old, and the drop stops at the row
//     the reader is on. The reading anchor decides both; the window only obeys.
//   • **A dropped row's lease is parked, not lost.** What parking means, and the
//     bound it is held to, are `row-lease-table.ts`'s — the cap names a key it is
//     about to drop and reads nothing back.
//
// The window is a ceiling for a mechanical reason as well as a memory one:
// `LEDGER_MAX_ELEMENT_HEIGHT_PX` is where a browser stops being able to place a
// virtual list's total-size spacer, and an uncapped log reaches it.

import { LEDGER_WINDOW_ROW_CAP } from "../frame-bounds.js";
import { LedgerRowLeaseTable, type LedgerRowLease } from "../row-lease-table.js";

/** One row as the window sees it. The body is nobody's business here. */
export interface LedgerWindowRow {
  readonly key: string;
  /** The chapter or row this hangs from; `undefined` for a top-level row. */
  readonly parentKey: string | undefined;
  /** The `timeline.read` cursor this row was read at — the unit a pin cuts by. */
  readonly rootCursor: string;
}

/**
 * Why a prune did not happen. Closed, and every member is a condition a caller can
 * observe — a deferral nobody can explain is a leak that reads as a memory bug.
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
  /** `LedgerScrollController.vetoesPrune()` — a programmatic write is in flight. */
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
   * A FLOOR rather than a sixth held key. A held row is SKIPPED and the drop walks
   * on past it, so a reader parked at row ten of four thousand would keep row ten
   * and lose the rows under it — a hole opening immediately below them. A floor
   * STOPS the walk: prune takes what it honestly can from above the reader and the
   * retained window stays contiguous.
   */
  readonly readingFloorRowKey: string | undefined;
}

export interface PruneOutcome {
  readonly applied: boolean;
  /** Why this pass took nothing. `undefined` exactly when `applied` is true. */
  readonly deferredBecause: PruneDeferralReason | undefined;
  /**
   * What still holds the window over its cap now the pass has ended, or
   * `undefined` when the window is within its cap.
   *
   * NOT A RESTATEMENT OF `deferredBecause`, and the case where they differ is the
   * one this reading exists for: a walk that stopped at the reading floor AFTER
   * taking rows applied, so `deferredBecause` is `undefined` and correct — and the
   * window is still thousands of rows over its cap. Reported as an applied prune
   * with nothing owed, that residual was re-asked by nobody, and on a session that
   * had gone quiet the rows stayed resident for the life of the mount. The two
   * readings answer two different questions, so the caller that re-asks reads THIS
   * one; `under-cap` deliberately owes nothing, because a window inside its cap is
   * not a window waiting on a condition.
   */
  readonly owedBecause: PruneDeferralReason | undefined;
  /** Every key dropped, ancestors and their subtrees together. */
  readonly prunedKeys: readonly string[];
  readonly topLevelRetained: number;
}

export interface LedgerWindowOptions {
  readonly topLevelCap?: number;
  readonly parkedLeaseCap?: number;
}

export class LedgerWindow {
  readonly #topLevelCap: number;
  readonly #childKeysByParentKey = new Map<string, string[]>();
  /** Every retained row key, so "is this row's parent here?" costs no scan. */
  readonly #presentRowKeys = new Set<string>();
  readonly #leaseTable: LedgerRowLeaseTable;

  /**
   * The adopted log, oldest first — which is also prune order.
   *
   * An ARRAY and not a map keyed by row key, deliberately. A projection that
   * repeats a key is a defect, and a map would silently collapse the repeat into
   * one row: the reader would lose an entry and nothing anywhere would say so. The
   * array carries both, and `RowWindow` is the layer that reports the repeat and
   * draws it at an estimated height — `Spec-023 §Console Libraries`' timeline-
   * virtualization row asks for "stable keys", and this console's answer to a
   * projection that breaks that is to degrade rather than discard the window.
   */
  #rows: LedgerWindowRow[] = [];

  public constructor(options: LedgerWindowOptions = {}) {
    this.#topLevelCap = options.topLevelCap ?? LEDGER_WINDOW_ROW_CAP;
    this.#leaseTable = new LedgerRowLeaseTable(options.parkedLeaseCap);
  }

  /**
   * Adopt the projected log, in its order, oldest first.
   *
   * ADOPT rather than accumulate. The window is a VIEW over the projection, never a
   * second copy of it: a row the projection no longer carries is not remembered
   * here, because remembering it would be duplicate state beside the session store —
   * which is the thing the budgets forbid, and which would also make the log's ORDER
   * depend on the order rows happened to be re-read in. What the window adds is the
   * cap and the rules about when the cap may be applied.
   *
   * A row that arrives twice in one read collapses to one row in its first position,
   * so a projection defect cannot double a chapter.
   */
  public ingest(rows: readonly LedgerWindowRow[]): void {
    this.#rows = [...rows];
    this.#childKeysByParentKey.clear();
    this.#presentRowKeys.clear();
    for (const row of this.#rows) {
      this.#presentRowKeys.add(row.key);
    }
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
  public rows(): readonly LedgerWindowRow[] {
    return [...this.#rows];
  }

  /**
   * Retained top-level rows — the only ones the cap counts.
   *
   * A row is top-level when it names no parent OR when the parent it names is not
   * in this window. See the second bullet in this file's header for why the second
   * arm is not a leniency: without it a log whose every row hangs off a run header
   * the projection never emits counts zero rows against the cap forever.
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

  public get size(): number {
    return this.#rows.length;
  }

  /** A row body's leased state, live or parked. `row-lease-table.ts` owns which. */
  public lease(rowKey: string): LedgerRowLease | undefined {
    return this.#leaseTable.lease(rowKey);
  }

  public setLease(rowKey: string, lease: LedgerRowLease): void {
    this.#leaseTable.setLease(rowKey, lease);
  }

  /**
   * Drop the oldest top-level rows, or say why it could not.
   *
   * The refusals `#deferralFor` answers are ordered by what they cost: `under-cap`
   * is free, and the rest clear on their own within a frame or two, so a caller
   * that re-asks next frame gets its prune without waiting on any of them. The two
   * refusals that cannot be decided up front are `reading-floor` and `held-rows`,
   * which are knowable only once the walk has found what it can take.
   *
   * EVERY RETURN CARRIES `owedBecause`, and a partial pass is why. The walk can
   * apply and still leave the window over its cap — it stops at the reader's row,
   * or it skips every candidate as held — and an outcome that said only `applied`
   * left that residual unnameable. See the member's own doc.
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
        // Never prunes a held row, and never orphans one either: a chapter whose
        // child is open stays whole rather than losing its head.
        continue;
      }
      for (const closedKey of closure) {
        if (removedKeys.has(closedKey)) {
          continue;
        }
        removedKeys.add(closedKey);
        this.#leaseTable.park(closedKey);
        prunedKeys.push(closedKey);
      }
      remainingToDrop -= 1;
    }
    // What the walk could not get past, read off the walk rather than re-derived.
    // `remainingToDrop` above zero means the window is still over its cap, and the
    // two ways that happens are the two the loop can leave early or skip past: the
    // reader's floor stopped it, or every remaining candidate was held.
    const blockedBy: PruneDeferralReason | undefined =
      remainingToDrop <= 0 ? undefined : stoppedAtReadingFloor ? "reading-floor" : "held-rows";
    if (blockedBy !== undefined && prunedKeys.length === 0) {
      // Over cap and unable to take one row. Named rather than returned as an
      // applied prune with an empty key list, which this module's second property
      // calls indistinguishable from a window already under cap.
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

  /** The cursor the window is cut at — the pin's, or the oldest retained row's. */
  public cutAtRootCursor(pinnedRootCursor: string | undefined): string | undefined {
    if (pinnedRootCursor !== undefined) {
      return pinnedRootCursor;
    }
    return this.#rows[0]?.rootCursor;
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
   * Every key from the reader's row to the end of the window — the set the drop
   * may not touch — and empty when there is no floor to honour.
   *
   * Empty for a floor naming a row the window no longer holds, too: the row the
   * reader was on is already gone, so there is nothing above it left to protect,
   * and that case is the viewport controller's residual rather than the cap's. The
   * floor resolves to the FIRST occurrence of a repeated key, which is the reading
   * that protects the most of a projection defect `RowWindow` reports separately.
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
