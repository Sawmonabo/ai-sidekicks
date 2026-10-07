// A session names itself after its first completed exchange: the first words of its first message,
// written through the rename path only while the session is still unnamed, so a name the person
// typed, before or during, always wins.

import type { Database, Statement } from "better-sqlite3";

import type { EventEnvelope } from "@ai-sidekicks/contracts/event/envelope";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { ServiceLogWriter } from "../daemon/service-log.js";
import type { EventLogService } from "../events/log-service.js";
import type { SessionChanges } from "./changes.js";

// A title reads as a few words: whole words up to this many UTF-16 units.
const TITLE_MAX_LENGTH = 40;

/** What the self-naming follows, reads and writes through. */
export interface SessionAutoTitleDeps {
  /** The read-only connection the session's name and first message are read on. */
  readonly reader: Database;
  /** The log whose committed events say when an exchange completed. */
  readonly events: Pick<EventLogService, "followAll">;
  /** The rename path the title is written through. */
  readonly changes: Pick<SessionChanges, "nameUnnamed">;
  /** Where a title that could not be written is reported. */
  readonly writeServiceLog: ServiceLogWriter;
}

/** Names each unnamed session after its first completed exchange, from `start` until stopped. */
export class SessionAutoTitle {
  readonly #events: Pick<EventLogService, "followAll">;
  readonly #changes: Pick<SessionChanges, "nameUnnamed">;
  readonly #writeServiceLog: ServiceLogWriter;
  readonly #selectEarlierCompletion: Statement<[string, number]>;
  readonly #selectTitleSource: Statement<
    [string],
    { readonly name: string | null; readonly firstMessagePreview: string | null }
  >;

  constructor(deps: SessionAutoTitleDeps) {
    this.#events = deps.events;
    this.#changes = deps.changes;
    this.#writeServiceLog = deps.writeServiceLog;
    this.#selectEarlierCompletion = deps.reader.prepare(
      `SELECT 1 FROM session_events
        WHERE session_id = ? AND type = 'run.completed' AND sequence < ?
        LIMIT 1`,
    );
    this.#selectTitleSource = deps.reader.prepare(
      "SELECT name, first_message_preview AS firstMessagePreview FROM sessions WHERE id = ?",
    );
  }

  /** Follows every session's committed events; the returned function stops it. */
  start(): () => void {
    return this.#events.followAll((event) => {
      this.#titleAfter(event);
    });
  }

  #titleAfter(event: EventEnvelope): void {
    if (event.type !== "run.completed") {
      return;
    }
    if (this.#selectEarlierCompletion.get(event.sessionId, event.sequence) !== undefined) {
      return;
    }
    const source = this.#selectTitleSource.get(event.sessionId);
    if (source === undefined || source.name !== null || source.firstMessagePreview === null) {
      return;
    }
    const title = firstWordsOf(source.firstMessagePreview);
    if (title.length === 0) {
      return;
    }
    void this.#name(event.sessionId, title);
  }

  async #name(sessionId: SessionId, title: string): Promise<void> {
    try {
      await this.#changes.nameUnnamed(sessionId, title);
    } catch (error) {
      this.#writeServiceLog(
        `Naming session ${sessionId} after its first exchange failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

// The message's whole words, separated by single spaces, up to the title's length; a first word
// longer than that is cut at it, never inside a surrogate pair.
function firstWordsOf(message: string): string {
  const words = message.split(/\s+/u).filter((word) => word.length > 0);
  let title = "";
  for (const word of words) {
    const extended = title.length === 0 ? word : `${title} ${word}`;
    if (extended.length > TITLE_MAX_LENGTH) {
      break;
    }
    title = extended;
  }
  if (title.length > 0 || words[0] === undefined) {
    return title;
  }
  const firstWord = words[0];
  const lastUnit = firstWord.charCodeAt(TITLE_MAX_LENGTH - 1);
  const cutsPair = lastUnit >= 0xd800 && lastUnit <= 0xdbff;
  return firstWord.slice(0, cutsPair ? TITLE_MAX_LENGTH - 1 : TITLE_MAX_LENGTH);
}
