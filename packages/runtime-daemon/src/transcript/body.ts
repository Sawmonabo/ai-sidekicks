// The stored row `transcript.bodyRead` opens: one event of one session by its id, with the body its
// `content_payload` column holds, read whole only when a client asks for it.

import type { Database } from "better-sqlite3";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { StoredEventContentRow } from "../events/content/read.js";
import {
  prepareSessionEventReads,
  type DamagedFromSequenceReader,
  type SessionEventReads,
} from "../events/session/read.js";
import { readTranscriptHead } from "./window.js";

/** Reads a transcript row's stored event and body from the daemon's read-only connection. */
export class TranscriptBodyReader {
  readonly #reads: SessionEventReads;
  readonly #readDamagedFromSequence: DamagedFromSequenceReader;

  // `readDamagedFromSequence` keeps a damaged session's rows past its last good point unread.
  constructor(reader: Database, readDamagedFromSequence: DamagedFromSequenceReader) {
    this.#reads = prepareSessionEventReads(reader, readDamagedFromSequence);
    this.#readDamagedFromSequence = readDamagedFromSequence;
  }

  /**
   * The stored row of the event with id `eventId`, or `undefined` when the session reads none.
   * Throws `SessionNotFoundError` for a session this daemon holds no events for.
   */
  readStoredEventRow(sessionId: SessionId, eventId: string): StoredEventContentRow | undefined {
    const storedRow = this.#reads.readStoredRow(sessionId, eventId);
    if (storedRow === undefined) {
      // Tells a session this daemon lacks from a row its session lacks.
      readTranscriptHead(this.#reads, this.#readDamagedFromSequence, sessionId);
    }
    return storedRow;
  }
}
