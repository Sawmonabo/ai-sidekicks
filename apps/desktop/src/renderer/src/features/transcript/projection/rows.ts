// The log-derived row projection: this window's event log read as `TranscriptEventRow`s. The app
// receives raw events, not the daemon's read projection, so rows carry what the log supports
// (id, sequence, cursor, `type`, `actor` and `payload` verbatim) and `summary` is the wire type
// restated, since no registered payload carries one. The id is the daemon's opaque one, carried not
// composed: the hydrated-event read keys on {sessionId, eventId} and a row jump finds a row by it,
// so a `session:sequence` key would resolve for no caller.

import { SESSION_EVENT_CATEGORY_BY_TYPE } from "@ai-sidekicks/contracts/event/session";
import {
  TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE,
  TRANSCRIPT_RUN_LIFECYCLE_CATEGORY,
  type TranscriptEventRow,
} from "@ai-sidekicks/contracts/transcript/row";
import type { EventCategory } from "@ai-sidekicks/contracts/event/envelope";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { EventCursor, SessionId } from "@ai-sidekicks/contracts/session/id";

import { readRollbackBoundaryPayload } from "#renderer/services/daemon/payload/rollback-boundary.js";
import { type ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import { attributedRunIdOf } from "./run-attribution.js";
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
 * the log's identity. An event kind with no registered category is dropped,
 * since a guessed category would mis-filter every view downstream. `position` is the row's
 * ordinal within its run in this window, and `epoch` counts the rollback boundaries seen
 * before it, since re-execution reuses ordinals.
 */
export function projectTranscriptRows(
  events: readonly ProjectedSessionEvent[],
): TranscriptRowProjection {
  if (events.length === 0) {
    return EMPTY_PROJECTION;
  }

  const progressionByRunId = new Map<string, RunProgression>();
  // A pass of its own: a child run's summary states where the child got to, which is not
  // known at the row the summary is stamped on.
  const childRunSummaryByEventId = deriveChildRunSummaries(events);
  const rows: TranscriptEventRow[] = [];

  for (const event of events) {
    const category = CATEGORY_BY_WIRE_TYPE.get(event.kind);
    if (category === undefined) {
      continue;
    }

    const runId = attributedRunIdOf(event.payload);
    if (runId === undefined) {
      rows.push({
        ...commonRowFields(event, category),
        kind: "general",
        payload: event.payload ?? {},
      });
      continue;
    }

    const existing = progressionByRunId.get(runId);
    const progression = existing ?? { nextPosition: 0, epoch: 0 };
    if (existing === undefined) {
      progressionByRunId.set(runId, progression);
    }

    if (event.kind === TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE) {
      const boundary = projectRollbackBoundary(event, progression);
      if (boundary === undefined) {
        continue;
      }
      rows.push(boundary);
      // Later rows are a later execution of the same run; the increment lands after the boundary
      // is pushed because the boundary belongs to the epoch it ended.
      progression.epoch += 1;
      // The count returns to the anchor the rewind landed on, so the first re-executed row takes
      // the boundary's position in the new epoch; running on instead would let a second rewind to
      // the same anchor find every row of the new epoch above its cutoff and dim it all.
      progression.nextPosition = boundary.position;
      continue;
    }

    const childRunSummary = childRunSummaryByEventId.get(event.id);
    rows.push({
      ...commonRowFields(event, category),
      kind: "run",
      runId: runId as RunId,
      position: progression.nextPosition,
      epoch: progression.epoch,
      // Present on one row per child run (see `child-run-summaries.ts`), and absent rather than
      // `undefined`: the retention table compares own keys and would read the two as different.
      ...(childRunSummary === undefined ? {} : { childRunSummary }),
      payload: event.payload ?? {},
    });
    progression.nextPosition += 1;
  }

  return { rows };
}

/** How far one run has got: its next ordinal, and how many rewinds it has taken. */
interface RunProgression {
  nextPosition: number;
  epoch: number;
}

/**
 * The boundary arm alone, extracted from the contract's union so this file makes no second
 * claim about what a boundary row carries.
 */
type RollbackBoundaryRow = Extract<TranscriptEventRow, { readonly kind: "rollback_boundary" }>;

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
  progression: RunProgression,
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
    // Wire-verbatim, and the one the arm's own refinement compares against.
    position: boundary.targetPosition,
    epoch: progression.epoch,
    payload: boundary,
  };
}
