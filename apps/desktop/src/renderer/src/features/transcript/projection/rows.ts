// The log-derived row projection: this window's event log read as `TranscriptEventRow`s. Rows carry
// what the log supports (id, sequence, cursor, `type`, `actor`, `payload` and a read row's
// `content` verbatim) and a run's turn position, epoch and superseded marker as the daemon stamped
// them. The stamps are the daemon's because the window holds a share of the log: an ordinal
// counted here would change with what was loaded. The id is the daemon's opaque one, carried not composed: the hydrated-event
// read keys on {sessionId, eventId} and a row jump finds a row by it, so a `session:sequence` key
// would resolve for no caller.

import { SESSION_EVENT_CATEGORY_BY_TYPE } from "@ai-sidekicks/contracts/event/session";
import {
  TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE,
  TRANSCRIPT_RUN_LIFECYCLE_CATEGORY,
  type SupersededMarker,
  type TranscriptEventRow,
  type TranscriptRunStamp,
} from "@ai-sidekicks/contracts/transcript/row";
import type { EventCategory } from "@ai-sidekicks/contracts/event/envelope";
import type { TranscriptRowContent } from "@ai-sidekicks/contracts/transcript/content";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { EventCursor } from "@ai-sidekicks/contracts/session/event-cursor";
import { transcriptRunIdOf } from "@ai-sidekicks/contracts/transcript/run-attribution";

import { readRollbackBoundaryPayload } from "#renderer/services/daemon/payload/rollback-boundary.js";
import { type ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import { ChildRunSummaries } from "./child-run-summaries.js";

/**
 * What one projection pass produced. An event type with no registered category draws nothing:
 * the screen's list of rows is closed.
 */
export interface TranscriptRowProjection {
  readonly rows: readonly TranscriptEventRow[];
}

/** What projecting one stretch appended to a log produced. */
export interface TranscriptRowBatch {
  /** The stretch's own rows, in log order. */
  readonly rows: readonly TranscriptEventRow[];
  /**
   * The creation events of the child runs the stretch moved, whose rows an earlier stretch
   * projected and which now carry a stale summary.
   */
  readonly movedSummaryEventIds: ReadonlySet<string>;
}

/**
 * The registered event categories, read by a free-form wire type: `ProjectedSessionEvent.kind` is a
 * `string`, and an event whose type this build does not know is the case this lookup answers.
 */
const CATEGORY_BY_WIRE_TYPE: ReadonlyMap<string, EventCategory> = SESSION_EVENT_CATEGORY_BY_TYPE;

/**
 * Reads one log as transcript rows, one appended stretch at a time, so a stretch costs its own
 * events and the child runs they name.
 *
 * A fold in log order, so the same log gives the same rows whether it arrives whole or a stretch
 * at a time. An event kind with no registered category is dropped, since a guessed category would
 * mis-filter every view downstream. An event is a run's when the daemon stamped it; its run is the
 * one its payload names.
 */
export class TranscriptRowProjector {
  // Folded ahead of the rows: a child run's summary states where the child got to, which is not
  // known at the row the summary is stamped on.
  readonly #childRunSummaries = new ChildRunSummaries();
  readonly #rowByEvent: WeakMap<ProjectedSessionEvent, TranscriptEventRow>;

  /**
   * `rowByEvent` holds the row each event was last read as, and may outlive this projector: the
   * store keeps an event's object while the event is unchanged, so a log read again takes each held
   * event's row as it stands instead of reading the event anew.
   */
  public constructor(
    rowByEvent: WeakMap<ProjectedSessionEvent, TranscriptEventRow> = new WeakMap(),
  ) {
    this.#rowByEvent = rowByEvent;
  }

  /**
   * Project the next stretch of the log, every event after the ones projected before. A row read
   * anew passes through `retain`, which may answer an equal row to publish in its place.
   */
  public project(
    events: readonly ProjectedSessionEvent[],
    retain: (row: TranscriptEventRow) => TranscriptEventRow = (row) => row,
  ): TranscriptRowBatch {
    const stretchEventIds = new Set<string>();
    const movedSummaryEventIds = new Set<string>();
    for (const event of events) {
      stretchEventIds.add(event.id);
      const movedEventId = this.#childRunSummaries.admit(event);
      if (movedEventId !== undefined) {
        movedSummaryEventIds.add(movedEventId);
      }
    }
    const rows: TranscriptEventRow[] = [];
    for (const event of events) {
      const row = this.#rowOf(event, retain);
      if (row !== undefined) {
        rows.push(row);
      }
    }
    // A creation row in this stretch was projected with its summary as it now stands.
    for (const eventId of stretchEventIds) {
      movedSummaryEventIds.delete(eventId);
    }
    return { rows, movedSummaryEventIds };
  }

  /**
   * `row` carrying its child run's summary as it now stands, or `row` itself when it carries
   * none. Only a row that already carries a summary takes the newer one.
   */
  public withCurrentSummary(row: TranscriptEventRow): TranscriptEventRow {
    if (row.childRunSummary === undefined) {
      return row;
    }
    const childRunSummary = this.#childRunSummaries.summaryOf(row.id);
    return childRunSummary === undefined || childRunSummary === row.childRunSummary
      ? row
      : { ...row, childRunSummary };
  }

  /**
   * The row `event` reads as: the one it was last read as while the child-run summary that row
   * carries is still the current one, which is the only member not read from the event itself.
   */
  #rowOf(
    event: ProjectedSessionEvent,
    retain: (row: TranscriptEventRow) => TranscriptEventRow,
  ): TranscriptEventRow | undefined {
    const heldRow = this.#rowByEvent.get(event);
    if (
      heldRow !== undefined &&
      heldRow.childRunSummary === this.#childRunSummaries.summaryOf(event.id)
    ) {
      return heldRow;
    }
    const projectedRow = this.#projectEvent(event);
    if (projectedRow === undefined) {
      return undefined;
    }
    const row = retain(projectedRow);
    this.#rowByEvent.set(event, row);
    return row;
  }

  #projectEvent(event: ProjectedSessionEvent): TranscriptEventRow | undefined {
    const category = CATEGORY_BY_WIRE_TYPE.get(event.kind);
    if (category === undefined) {
      return undefined;
    }

    const runStamp = event.runStamp;
    const runId = runStamp === undefined ? undefined : transcriptRunIdOf(event.payload);
    if (runStamp === undefined || runId === undefined) {
      return {
        ...commonRowFields(event, category),
        kind: "general",
        payload: event.payload ?? {},
      };
    }

    if (event.kind === TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE) {
      return projectRollbackBoundary(event, runStamp);
    }

    const childRunSummary = this.#childRunSummaries.summaryOf(event.id);
    return {
      ...commonRowFields(event, category),
      kind: "run",
      runId: runId as RunId,
      ...stampFields(runStamp),
      // Present on one row per child run (see `child-run-summaries.ts`), and absent rather than
      // `undefined`: the retention table compares own keys and would read the two as different.
      ...(childRunSummary === undefined ? {} : { childRunSummary }),
      payload: event.payload ?? {},
    };
  }
}

/** Reads a whole log as transcript rows, for a caller that projects a log once. */
export function projectTranscriptRows(
  events: readonly ProjectedSessionEvent[],
): TranscriptRowProjection {
  return { rows: new TranscriptRowProjector().project(events).rows };
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

/** The members every arm spreads, all of them wire-verbatim. */
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
  readonly timestamp: string;
  readonly actor?: string;
  readonly content?: TranscriptRowContent;
} {
  return {
    id: event.id,
    sessionId: event.sessionId as SessionId,
    sequence: event.sequence,
    cursor: event.cursor as EventCursor,
    category,
    type: event.kind,
    timestamp: event.occurredAt,
    ...(event.actorId === undefined ? {} : { actor: event.actorId }),
    // Absent rather than `undefined`, as `actor` is: the retention table compares own keys.
    ...(event.content === undefined ? {} : { content: event.content }),
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
