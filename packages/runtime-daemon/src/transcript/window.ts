// One `transcript.read` window: a bounded stretch of one session's log, projected into transcript
// rows and cut to one page. A cursor is a log position: `afterCursor` reads the events after it
// forward, `beforeCursor` the events at or below it backward, nearest the cursor first chosen, and
// both together the events between them, read forward. Rows run oldest to newest either way.
//
// A page stops at the caller's limit or the page byte budget, whichever trips first, and says
// whether more remain. One candidate past the limit is read to learn that, never projected.

import type { Database } from "better-sqlite3";

import type { EventEnvelope } from "@ai-sidekicks/contracts/event/envelope";
import { countEntriesFittingOneFrame } from "@ai-sidekicks/contracts/jsonrpc/page";
import { encodeEventCursor } from "@ai-sidekicks/contracts/session/event-cursor";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { TRANSCRIPT_READ_LIMIT_MAX } from "@ai-sidekicks/contracts/transcript/limits";
import type {
  TranscriptReadRequest,
  TranscriptReadResponse,
} from "@ai-sidekicks/contracts/transcript/operations";

import {
  prepareSessionEventReads,
  resolveEventCursor,
  type DamagedFromSequenceReader,
  type SessionEventReads,
} from "../events/session/read.js";
import { SessionNotFoundError } from "../ipc/session-errors.js";
import type { TranscriptProjector } from "./projector.js";

/** Answers `transcript.read` from the daemon's read-only connection. */
export class TranscriptWindowReader {
  readonly #reader: Database;
  readonly #reads: SessionEventReads;
  readonly #projector: Pick<TranscriptProjector, "projectWindow">;
  readonly #readDamagedFromSequence: DamagedFromSequenceReader;

  // `readDamagedFromSequence` stops every read at a damaged session's last good point.
  constructor(
    reader: Database,
    projector: Pick<TranscriptProjector, "projectWindow">,
    readDamagedFromSequence: DamagedFromSequenceReader,
  ) {
    this.#reader = reader;
    this.#reads = prepareSessionEventReads(reader, readDamagedFromSequence);
    this.#projector = projector;
    this.#readDamagedFromSequence = readDamagedFromSequence;
  }

  /**
   * Reads one window, its head, events and projection in one snapshot; a session whose history is
   * damaged before its first readable event reads as an empty log. Throws `SessionNotFoundError`
   * for a session this daemon holds no events for, and
   * `EventCursorUnresolvableError` for a cursor that names no position or one past the session's
   * newest event. A page whose one row alone is over the page budget is returned as that row, for
   * the response schema to refuse.
   */
  read(request: TranscriptReadRequest): TranscriptReadResponse {
    return this.#reader.transaction(() => this.#readInSnapshot(request))();
  }

  #readInSnapshot(request: TranscriptReadRequest): TranscriptReadResponse {
    const { sessionId } = request;
    const head = this.#reads.readHead(sessionId);
    if (head === undefined && this.#readDamagedFromSequence(sessionId) === undefined) {
      throw new SessionNotFoundError("This daemon holds no such session.", { sessionId });
    }
    const afterPosition = resolveEventCursor(request.afterCursor, head);
    const beforePosition =
      request.beforeCursor === undefined
        ? undefined
        : resolveEventCursor(request.beforeCursor, head);
    const limit = request.limit ?? TRANSCRIPT_READ_LIMIT_MAX;
    if (beforePosition !== undefined && request.afterCursor === undefined) {
      return this.#readBackward(sessionId, beforePosition, limit);
    }
    return this.#readForward(sessionId, afterPosition, beforePosition, limit);
  }

  // The oldest rows after `afterPosition`, up to `beforePosition` when one bounds the window.
  #readForward(
    sessionId: SessionId,
    afterPosition: number,
    beforePosition: number | undefined,
    limit: number,
  ): TranscriptReadResponse {
    let candidates: readonly EventEnvelope[] = [];
    if (beforePosition === undefined) {
      candidates = this.#reads.readAfter(sessionId, afterPosition, limit + 1);
    } else if (beforePosition > afterPosition) {
      // Ascending, so the events past the bound are a suffix and what stays is contiguous.
      candidates = this.#reads
        .readAfter(sessionId, afterPosition, limit + 1)
        .filter((event) => event.sequence <= beforePosition);
    }
    const stretch = candidates.slice(0, limit);
    const rows = this.#projector.projectWindow(sessionId, stretch);
    // Counted from the oldest end, so a budget cut keeps the rows nearest `afterCursor`, whether
    // or not `beforeCursor` bounds the window.
    const pageCount = countEntriesFittingOneFrame(rows, limit);
    const entries = rows.slice(0, pageCount);
    const newestKept = stretch[pageCount - 1];
    // An empty page leaves the reader where it asked to read after.
    const nextCursor = encodeEventCursor(
      newestKept === undefined ? afterPosition : newestKept.sequence,
    );
    return pageCount < candidates.length
      ? { entries, hasMore: true, nextCursor }
      : { entries, hasMore: false, nextCursor };
  }

  // The newest rows at or below `beforePosition`, returned oldest first.
  #readBackward(
    sessionId: SessionId,
    beforePosition: number,
    limit: number,
  ): TranscriptReadResponse {
    const candidates = this.#reads.readBefore(sessionId, beforePosition, limit + 1);
    const stretch = candidates.slice(-limit);
    const rows = this.#projector.projectWindow(sessionId, stretch);
    // Counted from the newest end, so a budget cut drops the rows farthest from the cursor.
    const pageCount = countEntriesFittingOneFrame([...rows].reverse(), limit);
    const entries = rows.slice(rows.length - pageCount);
    const oldestKept = stretch[stretch.length - pageCount];
    // Every candidate made the page (an empty one included, where `oldestKept` is undefined): the
    // page reached the start of the log, so no earlier window remains to name.
    if (pageCount === candidates.length || oldestKept === undefined) {
      return { entries, hasMore: false };
    }
    return { entries, hasMore: true, nextCursor: encodeEventCursor(oldestKept.sequence - 1) };
  }
}
