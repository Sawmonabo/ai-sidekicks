// One session's event log read as transcript rows. Every event of a run is stamped with its turn
// position, its execution epoch and, when an undo rolled its turn back, the superseded marker; a
// `run.rolled_back` becomes the typed boundary row; an event naming no run is a general row.

import type { Database } from "better-sqlite3";

import type { EventEnvelope } from "@ai-sidekicks/contracts/event/envelope";
import { encodeEventCursor } from "@ai-sidekicks/contracts/session/event-cursor";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import {
  TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE,
  TRANSCRIPT_RUN_LIFECYCLE_CATEGORY,
  type TranscriptEventRow,
  type TranscriptEventRowBase,
  type TranscriptRunStamp,
} from "@ai-sidekicks/contracts/transcript/row";

import { RunTurnReads, SessionTurnAttribution } from "./turn-attribution.js";

/** Projects the session log into transcript rows and stamps each event of a run. */
export class TranscriptProjector {
  readonly #reads: RunTurnReads;

  /** Prepares the log reads on `reader`, the daemon's read-only connection. */
  constructor(reader: Database) {
    this.#reads = new RunTurnReads(reader);
  }

  /**
   * One row per event of `events`, a contiguous ascending stretch of one session's log, in the
   * same order. Throws on a `run.rolled_back` whose payload does not match its contract.
   */
  projectWindow(sessionId: SessionId, events: readonly EventEnvelope[]): TranscriptEventRow[] {
    const attribution = new SessionTurnAttribution(this.#reads, sessionId);
    return events.map((event) => rowOf(event, attribution));
  }

  /**
   * A stamper for one session stream: call it on every change in sequence order, catch-up pages
   * included; it answers the stamp for an event of a run and `undefined` for any other.
   */
  createLiveStamper(
    sessionId: SessionId,
  ): (event: EventEnvelope) => TranscriptRunStamp | undefined {
    const attribution = new SessionTurnAttribution(this.#reads, sessionId);
    return (event) => attribution.attribute(event)?.stamp;
  }
}

function rowOf(event: EventEnvelope, attribution: SessionTurnAttribution): TranscriptEventRow {
  const common = commonRowFieldsOf(event);
  const attributed = attribution.attribute(event);
  if (attributed === undefined) {
    return { ...common, kind: "general", payload: event.payload };
  }
  if (attributed.rollback !== undefined) {
    return {
      ...common,
      kind: "rollback_boundary",
      category: TRANSCRIPT_RUN_LIFECYCLE_CATEGORY,
      type: TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE,
      runId: attributed.runId,
      ...attributed.stamp,
      payload: attributed.rollback,
    };
  }
  return {
    ...common,
    kind: "run",
    runId: attributed.runId,
    ...attributed.stamp,
    payload: event.payload,
  };
}

function commonRowFieldsOf(
  event: EventEnvelope,
): Omit<TranscriptEventRowBase, "payload" | "childRunSummary" | "omittedPatches"> {
  return {
    id: event.id,
    sessionId: event.sessionId,
    sequence: event.sequence,
    cursor: encodeEventCursor(event.sequence),
    category: event.category,
    type: event.type,
    // The event type restated: no registered payload carries a summary.
    summary: event.type,
    timestamp: event.occurredAt,
    ...(event.actor === null || event.actor === undefined ? {} : { actor: event.actor }),
  };
}
