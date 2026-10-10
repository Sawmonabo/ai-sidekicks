// One session's event log read as transcript rows. Every event of a run is stamped with its turn
// position, its execution epoch and, when an undo rolled its turn back, the superseded marker; a
// `run.rolled_back` becomes the typed boundary row; an event naming no run is a general row. Every
// row carries its body, read for the whole window in one statement; a large body is read as its
// size alone, so a page of large outputs costs no more than their lengths.

import type { Database, Statement } from "better-sqlite3";

import type { EventEnvelope } from "@ai-sidekicks/contracts/event/envelope";
import { encodeEventCursor } from "@ai-sidekicks/contracts/session/event-cursor";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import {
  transcriptRowContentOf,
  type StoredRowBody,
  type TranscriptRowContent,
} from "@ai-sidekicks/contracts/transcript/content";
import { TRANSCRIPT_ROW_BODY_INLINE_MAX_UTF8_BYTES } from "@ai-sidekicks/contracts/transcript/limits";
import {
  TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE,
  TRANSCRIPT_RUN_LIFECYCLE_CATEGORY,
  type TranscriptEventRowBase,
  type TranscriptReadRow,
  type TranscriptRunStamp,
} from "@ai-sidekicks/contracts/transcript/row";

import type { DamagedFromSequenceReader } from "../events/session/read.js";
import { RunTurnReads, SessionTurnAttribution } from "./turn-attribution.js";

/**
 * The bodies of a window's events, one row per event that has one stored: each body's UTF-8 size,
 * and its text only when that size lets it travel, so a large body is never read into memory.
 */
const SELECT_STORED_BODIES_SQL = `SELECT sequence, octet_length(content_payload) AS byteLength,
       CASE WHEN octet_length(content_payload) <= ? THEN content_payload END AS body
  FROM session_events
 WHERE session_id = ? AND content_payload IS NOT NULL
   AND sequence IN (SELECT value FROM json_each(?))`;

/** Projects the session log into transcript rows and stamps each event of a run. */
export class TranscriptProjector {
  readonly #reads: RunTurnReads;
  readonly #selectStoredBodies: Statement<
    [number, SessionId, string],
    { readonly sequence: number; readonly byteLength: number; readonly body: string | null }
  >;

  /**
   * Prepares the log reads on `reader`, the daemon's read-only connection;
   * `readDamagedFromSequence` says where a damaged session's reads stop, none stop when absent.
   */
  constructor(reader: Database, readDamagedFromSequence?: DamagedFromSequenceReader) {
    this.#reads = new RunTurnReads(reader, readDamagedFromSequence);
    this.#selectStoredBodies = reader.prepare(SELECT_STORED_BODIES_SQL);
  }

  /**
   * One row per event of `events`, a contiguous ascending stretch of one session's log, in the
   * same order, each with its body. Throws on a `run.rolled_back` whose payload does not match its
   * contract.
   */
  projectWindow(sessionId: SessionId, events: readonly EventEnvelope[]): TranscriptReadRow[] {
    const attribution = new SessionTurnAttribution(this.#reads, sessionId);
    const storedBodyBySequence = new Map<number, StoredRowBody>(
      this.#selectStoredBodies
        .all(
          TRANSCRIPT_ROW_BODY_INLINE_MAX_UTF8_BYTES,
          sessionId,
          JSON.stringify(events.map((event) => event.sequence)),
        )
        .map((row) => [
          row.sequence,
          { byteLength: row.byteLength, ...(row.body === null ? {} : { body: row.body }) },
        ]),
    );
    return events.map((event) =>
      rowOf(
        event,
        attribution,
        transcriptRowContentOf(event.payload, storedBodyBySequence.get(event.sequence)),
      ),
    );
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

function rowOf(
  event: EventEnvelope,
  attribution: SessionTurnAttribution,
  content: TranscriptRowContent,
): TranscriptReadRow {
  const common = { ...commonRowFieldsOf(event), content };
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
