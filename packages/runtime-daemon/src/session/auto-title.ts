// A session names itself after its first completed exchange: the first words of its first message,
// written through the rename path only while the session is still unnamed, so a name the person
// typed, before or during, always wins. A session whose first exchange completed while the daemon
// was not following it is named at the next start.

import type { Database, Statement } from "better-sqlite3";

import type { EventEnvelope } from "@ai-sidekicks/contracts/event/envelope";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { ServiceLogWriter } from "../daemon/service-log.js";
import type { EventLogService } from "../events/log-service.js";
import type { SessionChanges } from "./changes.js";
import { cutToCodeUnits } from "../text-cut.js";
import { describeRejection } from "../rejection.js";

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
  readonly #selectUntitledCompleted: Statement<[], { readonly sessionId: SessionId }>;
  // Each title still on its way to the rename path.
  readonly #namesInFlight = new Set<Promise<void>>();

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
    // A session never renamed whose exchange completed; one the person cleared has a rename and
    // stays unnamed.
    this.#selectUntitledCompleted = deps.reader.prepare(
      `SELECT session.id AS sessionId FROM sessions AS session
        WHERE session.name IS NULL AND session.first_message_preview IS NOT NULL
          AND EXISTS (SELECT 1 FROM session_events
                       WHERE session_id = session.id AND type = 'run.completed')
          AND NOT EXISTS (SELECT 1 FROM session_events
                           WHERE session_id = session.id AND type = 'session.renamed')`,
    );
  }

  /**
   * Follows every session's committed events, then names each session whose first exchange
   * completed while none was followed. The returned stop ends the follow and settles once every
   * title on its way has been written or reported.
   */
  start(): () => Promise<void> {
    const detach = this.#events.followAll((event) => {
      this.#titleAfter(event);
    });
    for (const { sessionId } of this.#selectUntitledCompleted.all()) {
      this.#titleFromFirstMessage(sessionId);
    }
    return async () => {
      detach();
      await Promise.all(this.#namesInFlight);
    };
  }

  #titleAfter(event: EventEnvelope): void {
    if (event.type !== "run.completed") {
      return;
    }
    if (this.#selectEarlierCompletion.get(event.sessionId, event.sequence) !== undefined) {
      return;
    }
    this.#titleFromFirstMessage(event.sessionId);
  }

  #titleFromFirstMessage(sessionId: SessionId): void {
    const source = this.#selectTitleSource.get(sessionId);
    if (source === undefined || source.name !== null || source.firstMessagePreview === null) {
      return;
    }
    const title = firstWordsOf(source.firstMessagePreview);
    if (title.length === 0) {
      return;
    }
    const naming = this.#name(sessionId, title);
    this.#namesInFlight.add(naming);
    void naming.finally(() => this.#namesInFlight.delete(naming));
  }

  async #name(sessionId: SessionId, title: string): Promise<void> {
    try {
      await this.#changes.nameUnnamed(sessionId, title);
    } catch (error) {
      this.#writeServiceLog(
        `Naming session ${sessionId} after its first exchange failed: ` +
          `${describeRejection(error)}`,
      );
    }
  }
}

/**
 * The title a session takes from its first message: the message's whole words, separated by
 * single spaces, up to the title's length; a first word longer than that is cut at it, never inside
 * a surrogate pair. Empty when the message has no words.
 */
export function firstWordsOf(message: string): string {
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
  return cutToCodeUnits(words[0], TITLE_MAX_LENGTH);
}
