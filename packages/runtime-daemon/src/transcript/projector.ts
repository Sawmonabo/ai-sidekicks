// One session's event log read as transcript rows. Every event of a run is stamped with its turn
// position, its execution epoch and, when an undo rolled its turn back, the superseded marker; a
// `run.rolled_back` becomes the typed boundary row; an event naming no run is a general row. Every
// row carries its body, read for the whole window in one statement, a large one as its size.

import type { Database, Statement } from "better-sqlite3";

import type { EventEnvelope } from "@ai-sidekicks/contracts/event/envelope";
import { encodeEventCursor } from "@ai-sidekicks/contracts/session/event-cursor";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import {
  transcriptRowContentOf,
  type TranscriptRowContent,
} from "@ai-sidekicks/contracts/transcript/content";
import {
  TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE,
  TRANSCRIPT_RUN_LIFECYCLE_CATEGORY,
  type TranscriptEventRowBase,
  type TranscriptReadRow,
  type TranscriptRunStamp,
} from "@ai-sidekicks/contracts/transcript/row";

import { hydrateStoredEvent } from "../events/content/read.js";
import type { DamagedFromSequenceReader } from "../events/session/read.js";
import { RunTurnReads, SessionTurnAttribution } from "./turn-attribution.js";

/** The bodies of a window's events, one row per event that has one stored. */
const SELECT_CONTENT_PAYLOADS_SQL = `SELECT sequence, content_payload AS contentPayload
  FROM session_events
 WHERE session_id = ? AND content_payload IS NOT NULL
   AND sequence IN (SELECT value FROM json_each(?))`;

/** Projects the session log into transcript rows and stamps each event of a run. */
export class TranscriptProjector {
  readonly #reads: RunTurnReads;
  readonly #selectContentPayloads: Statement<
    [SessionId, string],
    { readonly sequence: number; readonly contentPayload: unknown }
  >;

  /**
   * Prepares the log reads on `reader`, the daemon's read-only connection;
   * `readDamagedFromSequence` says where a damaged session's reads stop, none stop when absent.
   */
  constructor(reader: Database, readDamagedFromSequence?: DamagedFromSequenceReader) {
    this.#reads = new RunTurnReads(reader, readDamagedFromSequence);
    this.#selectContentPayloads = reader.prepare(SELECT_CONTENT_PAYLOADS_SQL);
  }

  /**
   * One row per event of `events`, a contiguous ascending stretch of one session's log, in the
   * same order, each with its body. Throws on a `run.rolled_back` whose payload does not match its
   * contract, and on a body column holding something other than text.
   */
  projectWindow(sessionId: SessionId, events: readonly EventEnvelope[]): TranscriptReadRow[] {
    const attribution = new SessionTurnAttribution(this.#reads, sessionId);
    const contentPayloadBySequence = new Map(
      this.#selectContentPayloads
        .all(sessionId, JSON.stringify(events.map((event) => event.sequence)))
        .map((row) => [row.sequence, row.contentPayload]),
    );
    return events.map((event) =>
      rowOf(
        event,
        attribution,
        transcriptRowContentOf(
          hydrateStoredEvent({
            envelope: event,
            contentPayload: contentPayloadBySequence.get(event.sequence),
          }).content,
        ),
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
