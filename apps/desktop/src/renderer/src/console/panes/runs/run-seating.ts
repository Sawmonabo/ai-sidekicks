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
// rule `bridge/queue-feed.ts` keeps for its own snapshot and tail.
//
// AND "COMPLETE" IS A CLAIM WITH A LIST BEHIND IT. `awaitingProjectionRunIds` names
// the runs the pane is drawing from the session's record rather than from the live
// stream, so the surface can say how many and which — never a bare skeleton with no
// count, and never a list presented as current while a run the session knows is
// missing from it.

import { compareInstants, parseInstant } from "../../core/index.js";
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
  /** Runs the session knows that the stream has not described. In row order. */
  readonly awaitingProjectionRunIds: readonly string[];
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
  return {
    rows: [
      ...projections.map(
        (projection): SeatedRun => ({
          source: "projected",
          runId: projection.runId,
          projection,
        }),
      ),
      ...awaiting.map((known): SeatedRun => ({ source: "known", runId: known.runId, known })),
    ],
    awaitingProjectionRunIds: awaiting.map((known) => known.runId),
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
    runVersion: readNumber(body, "runVersion"),
    touchedAtIso: entity.touchedAt,
    stopTrigger: readString(body, "trigger"),
    intendedClose: body["intendedClose"] === true,
    failureCategory: readString(body, "failureCategory"),
    providerFailureDetail: readString(body, "providerFailureDetail"),
  };
}

function readString(body: Readonly<Record<string, unknown>>, member: string): string | undefined {
  const value = body[member];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(body: Readonly<Record<string, unknown>>, member: string): number | undefined {
  const value = body[member];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
