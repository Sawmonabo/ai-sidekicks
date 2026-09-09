// Which rows one walk is over, and what moves that set.
//
// SPLIT FROM THE MOUNT BESIDE IT for `ledger-replay-reveal.ts`' reason: this half is a
// pure derivation over two windows and a previous walk, driven with no clock, no
// engine and no mount at all, while `ledger-replay-window.ts` holds the engine's
// lifetime and the control surface the dock renders.
//
// THE ONE IDEA HERE: a replay is a walk over a FIXED set of rows, and two different
// things move underneath it.
//
//   • The LOG grows PAST ITS TAIL. That is an arrival, and the walk does not follow it
//     — a row admitted mid-walk was never in the walk, so scrubbing to the very end of
//     it reveals nothing, which is why the arrival is counted and named on screen
//     instead. Past the TAIL and not merely outside the frozen set: "Load earlier"
//     prepends historical rows the frozen log never held either, and counting those
//     told a person the session had moved on because they had asked to see its past.
//   • The PROJECTION moves — a facet chip, a chapter disclosed, a rewound band
//     folded. Nothing about the log changed, so the walk follows it: the same fixed
//     set, drawn differently.
//
// AND THE TWO ARE TOLD APART BY DIFFERENT ARRAYS, which is the whole reason the walk
// carries three. `loadedRows` is frozen at engagement and answers the first; a walk
// that read the second from it too could not answer anything once the session had
// admitted a single row.

import { type TimelineRow } from "@ai-sidekicks/contracts";

import { type ReplayState } from "../../structure/index.js";
import { type LedgerWindowModel } from "../window/index.js";

/** The two facts a replaced walk carries across the re-mint. */
export interface LedgerReplayResumePoint {
  readonly elapsedMs: number;
  /** What the replaced walk was doing, so the re-minted one is doing it too. */
  readonly state: ReplayState;
}

/**
 * The row set one walk is over, the log it began over, and the projection it was last
 * folded out of.
 *
 * A WRAPPER rather than the arrays themselves, because the object's identity is what
 * decides when the engine is re-minted, and ending a walk over an unchanged window
 * has to re-mint one. The arrays alone could not say "same rows, new walk".
 */
export interface LedgerReplayWalk {
  /**
   * Which walk this is, counted from the mount's first.
   *
   * The engine's key, and a COUNTER rather than the wrapper's own identity because a
   * subject-scoped key is a name inside one key space and never an object. It moves
   * on exactly the acts that end a walk and start another, which is what makes an
   * engine's lifetime the walk's.
   */
  readonly generation: number;
  /** What the engine plays — the projection, restricted to the rows this walk holds. */
  readonly rows: readonly TimelineRow[];
  /**
   * The LOG this walk began over, frozen from engagement to the end of the walk.
   *
   * Which rows this walk MAY cover, so clearing a filter or opening a chapter cannot
   * enlarge it. What the walk covers is decided by membership here; whether the
   * session has moved on is decided by {@link frozenTailSequence}, and the two are
   * different questions over the same frozen log.
   */
  readonly loadedRows: readonly TimelineRow[];
  /**
   * The ordering key the frozen log's TAIL sat at, or `undefined` for an empty one.
   *
   * WHAT AN ARRIVAL IS MEASURED PAST, and the reason the count is not a membership
   * test: a row outside the frozen set is not necessarily a row the session admitted,
   * because "Load earlier" prepends rows that are older than everything in the walk.
   * Counted as arrivals they made the notice say the session had moved on, and offered
   * to abandon the walk to reach entries the person had just asked to see.
   *
   * The key is `TimelineRow.sequence`, which is the session event sequence the whole
   * log is ordered by — never a run position, which is reused across a rewind.
   */
  readonly frozenTailSequence: number | undefined;
  /**
   * The projection `rows` was folded out of, so an unmoved projection costs one
   * identity check.
   *
   * A THIRD ARRAY BECAUSE A PROJECTION CHANGE AND AN ARRIVAL ARE TWO EVENTS. Once the
   * session has admitted anything, `loadedRows` no longer says whether the projection
   * has moved — and the guard that kept an arrival out of the walk was written
   * against exactly that reading, so one admitted row permanently blocked every later
   * filter and fold change from rebuilding `rows`, and a chapter opened after it
   * disclosed nothing.
   */
  readonly projectedFrom: readonly TimelineRow[];
  /**
   * Where a re-minted engine resumes, for a walk that replaced one mid-flight.
   *
   * `undefined` for a walk that begins at the head, which is every walk the engine
   * is not already running: a fresh engine is idle at elapsed zero and restoring a
   * position onto it would start a replay nobody pressed play on.
   */
  readonly resumeFrom: LedgerReplayResumePoint | undefined;
}

/**
 * A walk over the whole window as it now stands, at the head.
 *
 * What a mount begins with, what an unengaged ledger follows, and what `end` returns
 * to — one shape rather than three literals that agree until one of them gains a
 * member. A FRESH GENERATION every time it replaces one, so ending a walk over an
 * unchanged window re-mints an engine too; `undefined` is the mount's first walk,
 * which replaces none.
 */
export function walkOverTheWholeWindow(
  replacedWalk: LedgerReplayWalk | undefined,
  ledgerWindow: LedgerWindowModel,
  loadedWindow: LedgerWindowModel,
): LedgerReplayWalk {
  return {
    generation: replacedWalk === undefined ? 0 : replacedWalk.generation + 1,
    rows: ledgerWindow.rows,
    loadedRows: loadedWindow.rows,
    frozenTailSequence: tailSequenceOf(loadedWindow.rows),
    projectedFrom: ledgerWindow.rows,
    resumeFrom: undefined,
  };
}

/**
 * The walk an engaged replay is left with when the projection under it moves.
 *
 * TWO OUTCOMES, AND WHICH ONE IT IS DECIDES WHETHER AN ENGINE IS RE-MINTED. A
 * projection rebuilt over rows this walk already holds moves nothing a replay can
 * see, so the generation is held — re-minting there would restart the frame the dock
 * is painting for a filter nobody touched — and all the new walk records is which
 * projection has now been accounted for. A projection that really did change the
 * walk's rows takes a new generation and the position the replaced walk held.
 *
 * `loadedRows` AND THE TAIL IT ENDED AT ARE CARRIED ACROSS EITHER WAY. They are what
 * the arrival count is measured against, and adopting the current log here would make
 * every arrival vanish from the notice the moment somebody opened a chapter.
 */
export function walkAcrossProjectionChange(
  previous: LedgerReplayWalk,
  projectedRows: readonly TimelineRow[],
  heldPosition: LedgerReplayResumePoint,
): LedgerReplayWalk {
  const rowsTheWalkCovers = projectionWithinTheWalk(projectedRows, previous.loadedRows);
  if (haveSameRowIds(previous.rows, rowsTheWalkCovers)) {
    return { ...previous, projectedFrom: projectedRows };
  }
  return {
    generation: previous.generation + 1,
    rows: rowsTheWalkCovers,
    loadedRows: previous.loadedRows,
    frozenTailSequence: previous.frozenTailSequence,
    projectedFrom: projectedRows,
    resumeFrom: heldPosition,
  };
}

/**
 * How many rows the log and this window hold that are ordered PAST the walk's tail.
 *
 * TWO SUBJECTS FROM ONE BOUNDARY, because the two have different consumers and are
 * different facts. The notice a reader sees is about the SESSION having moved on, and
 * a narrowing is not the session: an entry admitted into a shut chapter, or one the
 * facet bar is hiding, is in the loaded log and in no window the viewport draws.
 * `ledger-visible-window.ts`' pile of withheld rows is this window's, so the feed's
 * subtraction takes the second figure and the notice takes the first.
 *
 * MEASURED PAST THE TAIL AND NOT AGAINST THE FROZEN SET, which is the correction: a
 * row the frozen log did not hold is not the same fact as a row the session admitted,
 * because paging backwards prepends rows older than the whole walk. Counted by the
 * ordering key rather than by length for the reason a membership test was reached for
 * in the first place — a window loses rows at the head as well as gaining them at the
 * tail, so a subtraction would report a pruned walk as having admitted nothing.
 *
 * The identity short-circuit is what keeps an unreplayed ledger free and is exact for
 * both: while the frozen log IS the log, nothing has been admitted anywhere.
 */
export function countRowsAdmittedSinceTheWalkBegan(
  walk: LedgerReplayWalk,
  ledgerWindow: LedgerWindowModel,
  loadedWindow: LedgerWindowModel,
): { readonly intoTheLog: number; readonly intoThisWindow: number } {
  if (walk.loadedRows === loadedWindow.rows) {
    return { intoTheLog: 0, intoThisWindow: 0 };
  }
  return {
    intoTheLog: countRowsPastTheFrozenTail(loadedWindow.rows, walk.frozenTailSequence),
    intoThisWindow: countRowsPastTheFrozenTail(ledgerWindow.rows, walk.frozenTailSequence),
  };
}

/**
 * The ordering key the tail of a frozen log sat at.
 *
 * THE LAST ROW RATHER THAN A SCAN FOR THE HIGHEST KEY. The store orders every batch by
 * this key before it admits one and refuses any sequence it cannot order at all
 * (`store/session/sequence-reconciler.ts`), and the projection copies the key verbatim in log
 * order — so the last row of a loaded window carries the highest key in it. A scan
 * would be a second reading of an ordering that already holds, run over the whole log
 * on every appended row of a ledger nobody is replaying.
 */
function tailSequenceOf(rows: readonly TimelineRow[]): number | undefined {
  return rows.at(-1)?.sequence;
}

/**
 * The current projection restricted to the log this walk began over.
 *
 * WHAT KEEPS A FOLD FOLLOWABLE AND AN ARRIVAL FROZEN OUT AT THE SAME TIME. The fold
 * and the filter decide which of the walk's fixed set the viewport draws, so the walk
 * follows the projection through this restriction rather than through the projection
 * itself — and a row the session admitted mid-walk is dropped here however the fold
 * happens to place it.
 *
 * The projection's own array is returned BY IDENTITY where it holds no such row,
 * which is every walk nothing has been admitted to, so the comparison beside it is
 * one reference test and no engine is re-minted for a set that did not move.
 */
function projectionWithinTheWalk(
  projectedRows: readonly TimelineRow[],
  rowsTheWalkBeganOver: readonly TimelineRow[],
): readonly TimelineRow[] {
  const rowIdsTheWalkBeganOver = new Set(rowsTheWalkBeganOver.map((row) => row.id));
  const rowsTheWalkCovers = projectedRows.filter((row) => rowIdsTheWalkBeganOver.has(row.id));
  return rowsTheWalkCovers.length === projectedRows.length ? projectedRows : rowsTheWalkCovers;
}

/**
 * Whether two projections hold the same rows in the same order.
 *
 * BY ID AND NOT BY IDENTITY, because a projection is rebuilt whenever anything
 * upstream of it moves, and a rebuild over rows that did not move is not a change the
 * walk may answer.
 */
function haveSameRowIds(left: readonly TimelineRow[], right: readonly TimelineRow[]): boolean {
  return (
    left === right ||
    (left.length === right.length && left.every((row, index) => row.id === right[index]?.id))
  );
}

/**
 * How many of these rows sit past the tail the walk froze at.
 *
 * An empty frozen log has no tail to be past, and every row is an arrival against it —
 * which is the only reading available and the right one: a walk that began over
 * nothing was left behind by everything.
 */
function countRowsPastTheFrozenTail(
  rows: readonly TimelineRow[],
  frozenTailSequence: number | undefined,
): number {
  if (frozenTailSequence === undefined) {
    return rows.length;
  }
  let admittedCount = 0;
  for (const row of rows) {
    if (row.sequence > frozenTailSequence) {
      admittedCount += 1;
    }
  }
  return admittedCount;
}
