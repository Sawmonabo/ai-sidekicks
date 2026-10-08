// The log-derived row projection: this window's event log read as `TranscriptEventRow`s. Rows carry
// what the log supports (id, sequence, cursor, `type`, `actor` and `payload` verbatim), a run's
// turn position, epoch and superseded marker as the daemon stamped them, and `summary` as the wire
// type restated, since no registered payload carries one. The stamps are the daemon's because the
// window holds a share of the log: an ordinal counted here would change with what was loaded. The
// id is the daemon's opaque one, carried not composed: the hydrated-event read keys on
// {sessionId, eventId} and a row jump finds a row by it, so a `session:sequence` key would resolve
// for no caller.

import { SESSION_EVENT_CATEGORY_BY_TYPE } from "@ai-sidekicks/contracts/event/session";
import {
  TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE,
  TRANSCRIPT_RUN_LIFECYCLE_CATEGORY,
  type SupersededMarker,
  type TranscriptEventRow,
  type TranscriptRunStamp,
} from "@ai-sidekicks/contracts/transcript/row";
import type { EventCategory } from "@ai-sidekicks/contracts/event/envelope";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { EventCursor } from "@ai-sidekicks/contracts/session/event-cursor";
import { transcriptRunIdOf } from "@ai-sidekicks/contracts/transcript/run-attribution";

import { readRollbackBoundaryPayload } from "#renderer/services/daemon/payload/rollback-boundary.js";
import { type ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import { deriveChildRunSummaries } from "./child-run-summaries.js";

/**
 * What one projection pass produced. An event type with no registered category draws nothing:
 * the screen's list of rows is closed.
 */
export interface TranscriptRowProjection {
  readonly rows: readonly TranscriptEventRow[];
}

/**
 * The registered event categories, read by a free-form wire type: `ProjectedSessionEvent.kind` is a
 * `string`, and an event whose type this build does not know is the case this lookup answers.
 */
const CATEGORY_BY_WIRE_TYPE: ReadonlyMap<string, EventCategory> = SESSION_EVENT_CATEGORY_BY_TYPE;

/** Nothing projected; shared, so an empty pass allocates none. */
const EMPTY_PROJECTION: TranscriptRowProjection = { rows: [] };

/**
 * Reads this window's event log as transcript rows.
 *
 * A pure fold in log order, so the same log gives the same rows and the caller can memoize on
 * the log's identity. An event kind with no registered category is dropped, since a guessed
 * category would mis-filter every view downstream. An event is a run's when the daemon stamped
 * it; its run is the one its payload names.
 */
export function projectTranscriptRows(
  events: readonly ProjectedSessionEvent[],
): TranscriptRowProjection {
  if (events.length === 0) {
    return EMPTY_PROJECTION;
  }

  // A pass of its own: a child run's summary states where the child got to, which is not
  // known at the row the summary is stamped on.
  const childRunSummaryByEventId = deriveChildRunSummaries(events);
  const rows: TranscriptEventRow[] = [];

  for (const event of events) {
    const category = CATEGORY_BY_WIRE_TYPE.get(event.kind);
    if (category === undefined) {
      continue;
    }

    const runStamp = event.runStamp;
    const runId = runStamp === undefined ? undefined : transcriptRunIdOf(event.payload);
    if (runStamp === undefined || runId === undefined) {
      rows.push({
        ...commonRowFields(event, category),
        kind: "general",
        payload: event.payload ?? {},
      });
      continue;
    }

    if (event.kind === TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE) {
      const boundary = projectRollbackBoundary(event, runStamp);
      if (boundary !== undefined) {
        rows.push(boundary);
      }
      continue;
    }

    const childRunSummary = childRunSummaryByEventId.get(event.id);
    rows.push({
      ...commonRowFields(event, category),
      kind: "run",
      runId: runId as RunId,
      ...stampFields(runStamp),
      // Present on one row per child run (see `child-run-summaries.ts`), and absent rather than
      // `undefined`: the retention table compares own keys and would read the two as different.
      ...(childRunSummary === undefined ? {} : { childRunSummary }),
      payload: event.payload ?? {},
    });
  }

  return { rows };
}

/**
 * The boundary arm alone, extracted from the contract's union so this file makes no second
 * claim about what a boundary row carries.
 */
type RollbackBoundaryRow = Extract<TranscriptEventRow, { readonly kind: "rollback_boundary" }>;

/**
 * The stamp's members as a row carries them, the superseded marker absent rather than
 * `undefined` for the same reason as the child-run summary.
 */
function stampFields(runStamp: TranscriptRunStamp): {
  readonly position: number;
  readonly epoch: number;
  readonly superseded?: SupersededMarker;
} {
  return {
    position: runStamp.position,
    epoch: runStamp.epoch,
    ...(runStamp.superseded === undefined ? {} : { superseded: runStamp.superseded }),
  };
}

/** The members every arm spreads, all of them wire-verbatim but `summary`. */
function commonRowFields(
  event: ProjectedSessionEvent,
  category: EventCategory,
): {
  readonly id: string;
  readonly sessionId: SessionId;
  readonly sequence: number;
  readonly cursor: EventCursor;
  readonly category: EventCategory;
  readonly type: string;
  readonly summary: string;
  readonly timestamp: string;
  readonly actor?: string;
} {
  return {
    id: event.id,
    sessionId: event.sessionId as SessionId,
    sequence: event.sequence,
    cursor: event.cursor as EventCursor,
    category,
    type: event.kind,
    // The wire type restated: no registered payload carries a summary.
    summary: event.kind,
    timestamp: event.occurredAt,
    ...(event.actorId === undefined ? {} : { actor: event.actorId }),
  };
}

/**
 * Projects one rollback into the typed boundary arm, or `undefined` if it cannot be.
 *
 * The payload is read at the bridge, not cast, because the arm's schema refines `position`
 * against `payload.targetPosition`. A payload that does not satisfy the contract is dropped,
 * since superseded turns drawn from a bad cutoff hide real rows.
 */
function projectRollbackBoundary(
  event: ProjectedSessionEvent,
  runStamp: TranscriptRunStamp,
): RollbackBoundaryRow | undefined {
  const boundary = readRollbackBoundaryPayload(event.payload);
  if (boundary === undefined) {
    return undefined;
  }
  return {
    ...commonRowFields(event, TRANSCRIPT_RUN_LIFECYCLE_CATEGORY),
    kind: "rollback_boundary",
    category: TRANSCRIPT_RUN_LIFECYCLE_CATEGORY,
    type: TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE,
    runId: boundary.runId as RunId,
    ...stampFields(runStamp),
    payload: boundary,
  };
}
