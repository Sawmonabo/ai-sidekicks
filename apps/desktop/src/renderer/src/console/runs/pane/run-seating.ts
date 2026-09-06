// Which runs the pane draws a row for, and which of them the live stream has
// actually described.
//
// THE DEFECT THIS MODULE REPLACES. The pane rendered `stateFeed.runs` and nothing
// else, so the row set was whatever `run.subscribeState` happened to have carried.
// That stream is a live TAIL of transitions and registers no completion marker at
// all — `api-payload-contracts.md §Plan-004` gives its response as
// `RunStateChangeEvent | RunRolledBackEvent` and nothing more — so two readings
// came out wrong at once. A session whose snapshot named three runs and whose tail
// had described one drew a single row and said nothing about the other two, which a
// person reads as a session with one run. And a session whose only run was already
// terminal when the pane opened received no transition ever, so the pane sat on its
// loading skeleton for as long as it stayed open.
//
// WHAT ANSWERS "WHICH RUNS EXIST" IS THE SESSION STORE, and it always was: the
// snapshot read establishes the session's base state and the `run` partition inside
// it is folded from every run-lifecycle event the log carries. So the row set is
// SEEDED from that partition and the stream's projections are OVERLAID onto it by
// `runId`. A run the stream has described renders its live projection; a run only
// the partition knows renders the partition's own facts, marked as what it is.
//
// THE ORDER IS THE FEED'S, AND SEEDING NEVER RESEQUENCES IT. Projected rows keep
// `run-state-feed.ts`'s most-recently-touched order exactly, and rows the stream has
// not described are appended after them, newest-touched first. A run the stream has
// said nothing about cannot be ranked against one it has — the two readings measure
// different things — so it is appended rather than interleaved, which is the same
// rule `bridge/queue/queue-feed.ts` keeps for its own snapshot and tail.
//
// AND "COMPLETE" IS A CLAIM WITH A LIST BEHIND IT. `awaitingProjectionRunIds` names
// the runs the pane is drawing from the session's record rather than from the live
// stream, so the surface can say how many and which — never a bare skeleton with no
// count, and never a list presented as current while a run the session knows is
// missing from it.
//
// AND THE LIST IS BOUNDED, LIKE EVERY OTHER WIRE-CONTROLLED LIST THIS PANE HOLDS.
// The partition is folded from the log and nothing evicts it, so a long-lived
// session's un-projected runs are as many as the session is old — and this function
// used to append every one of them, past the `PROJECTED_RUN_CAP` the projection fold
// spends two files away, sorting all of them on every partition change. So the tail
// is cut at `SEATED_KNOWN_RUN_CAP` and what was cut is COUNTED: the rule for this
// pane's other capped list is written beside `QUEUE_ROWS_RENDERED_CAP` — "above it
// the surface says how many rows it is not drawing rather than drawing them all"
// — and a bound that dropped
// rows silently would be the pane asserting a session has fewer runs than it has.

import {
  compareInstants,
  parseInstant,
  readWireNumber,
  readWireString,
  SEATED_KNOWN_RUN_CAP,
} from "../../core/index.js";
import type { ConsoleEntity } from "../../store/index.js";
import type { RunProjection } from "./run-state-projection.js";

/**
 * One run as the session's own record knows it, with no live reading behind it.
 *
 * Every member is wire-verbatim off the durable `run_lifecycle` payload that
 * `frame/run-lifecycle-projector.ts` folded onto the entity, and every one of them
 * is optional because the projector writes only what the payload named — a run
 * whose newest event carried no state has none here, and inventing one would be
 * the console reporting a state no daemon reported.
 */
export interface KnownRun {
  readonly runId: string;
  /** The wire's own state string, as the newest transition named it. */
  readonly state: string | undefined;
  /** The run aggregate's progression counter, as the durable row carried it. */
  readonly runVersion: number | undefined;
  /** When the newest run event for it landed, off the envelope. */
  readonly touchedAtIso: string | undefined;
  /** The stop condition that ended the run, wire-verbatim. */
  readonly stopTrigger: string | undefined;
  /** A daemon-initiated clean close. Such a terminal is never read as a crash. */
  readonly intendedClose: boolean;
  readonly failureCategory: string | undefined;
  readonly providerFailureDetail: string | undefined;
}

/**
 * One seated row: the live projection where the stream described the run, the
 * session's own record where it did not.
 *
 * A discriminated union rather than an optional projection beside optional facts,
 * because the two rows say different things and are read by different components —
 * a row built from the partition carries no run version the stream confirmed, no
 * status history, and no controls, and a shape that let those be `undefined` on one
 * row type would let a live row render as a partial one.
 */
export type SeatedRun =
  | { readonly source: "projected"; readonly runId: string; readonly projection: RunProjection }
  | { readonly source: "known"; readonly runId: string; readonly known: KnownRun };

/** What the pane draws, and what it is still missing a live reading for. */
export interface RunSeating {
  readonly rows: readonly SeatedRun[];
  /** Runs the session knows that the stream has not described, SEATED. In row order. */
  readonly awaitingProjectionRunIds: readonly string[];
  /**
   * Further such runs the cap kept off the pane.
   *
   * Reported rather than implied by a short list: the ids above are the rows that
   * exist, and this is how many runs the session knows that no row was drawn for.
   * A surface that rendered the ids and dropped this would say the session has
   * exactly as many un-projected runs as it happens to be drawing.
   */
  readonly withheldKnownRunCount: number;
}

/**
 * Seat the pane's rows from the session's run partition and the stream's
 * projections.
 *
 * A run the stream has projected that the partition does not carry still seats a
 * row: the projection is a real reading of a real run, and dropping it because the
 * snapshot has not caught up would hide the newest thing that happened.
 */
export function seatRuns(
  knownRuns: Readonly<Record<string, ConsoleEntity>>,
  projections: readonly RunProjection[],
): RunSeating {
  const projectedRunIds = new Set(projections.map((projection) => projection.runId));
  const awaiting = Object.values(knownRuns)
    .filter((entity) => !projectedRunIds.has(entity.id))
    .map(readKnownRun)
    .sort(byNewestTouched);
  // Newest-touched first is already the order, so the cut takes the coldest runs —
  // and it is taken AFTER the sort rather than as a bound on the fold, because which
  // fifty are newest is not known until every candidate has been ranked.
  const seated = awaiting.slice(0, SEATED_KNOWN_RUN_CAP);
  return {
    rows: [
      ...projections.map(
        (projection): SeatedRun => ({
          source: "projected",
          runId: projection.runId,
          projection,
        }),
      ),
      ...seated.map((known): SeatedRun => ({ source: "known", runId: known.runId, known })),
    ],
    awaitingProjectionRunIds: seated.map((known) => known.runId),
    withheldKnownRunCount: awaiting.length - seated.length,
  };
}

/**
 * One partition entity read as the run facts it carries.
 *
 * The body is `Readonly<Record<string, unknown>>` by the store's own contract — the
 * store family holds no wire knowledge — so each member is read at the type the
 * durable payload declares for it and anything else is dropped rather than cast. A
 * member read at the wrong type would reach a row as a rendered figure the daemon
 * never sent, which is the one thing a wire figure may not be.
 */
function readKnownRun(entity: ConsoleEntity): KnownRun {
  const body = entity.body ?? {};
  return {
    runId: entity.id,
    state: entity.state,
    runVersion: readWireNumber(body["runVersion"]),
    touchedAtIso: entity.touchedAt,
    stopTrigger: readWireString(body["trigger"]),
    intendedClose: body["intendedClose"] === true,
    failureCategory: readWireString(body["failureCategory"]),
    providerFailureDetail: readWireString(body["providerFailureDetail"]),
  };
}

/**
 * Newest activity first, with the run id breaking an exact tie deterministically —
 * the ordering `run-state-projection.ts` gives its own projections through the same
 * two functions, so the two halves of the seated list read in one direction.
 *
 * THROUGH THE PARSER, NEVER AS TEXT. `ConsoleEntity.touchedAt` is a wire instant and
 * an RFC 3339 stamp carries an offset: `2026-01-01T10:00:00+01:00` names 09:00Z and
 * sorts AFTER `2026-01-01T09:30:00Z` lexically while naming an EARLIER moment, so a
 * text comparison seats the older run above the newer one, stably and silently.
 * `core/instant.ts` exists for exactly this, and hoisting the two operands into
 * locals named for neither `At` nor `Iso` is what had turned the syntax ban off.
 *
 * A run the partition carries no instant for sorts last: an absent stamp reads as
 * malformed, and a malformed reading sorts last in BOTH directions rather than being
 * given a sentinel that would be first in one of them.
 */
function byNewestTouched(left: KnownRun, right: KnownRun): number {
  const ranked = compareInstants(
    parseInstant(left.touchedAtIso ?? ""),
    parseInstant(right.touchedAtIso ?? ""),
    "newest-first",
  );
  return ranked === 0 ? left.runId.localeCompare(right.runId) : ranked;
}
