// A small session directory written into a test database with every kind of row the search index
// holds (a person's and an assistant's messages, tool calls, titles, group names and tags) beside
// a thinking update it never holds, the text of each kept here as the test wrote it. The rows come
// from fixed arithmetic over a short vocabulary, so every run writes the same directory, and a
// test ranks the rows itself without the daemon's own reading of the database.

import type { Database } from "better-sqlite3";

import {
  START_OF_LOG_POSITION,
  encodeEventCursor,
  type EventCursor,
  type SessionId,
} from "@ai-sidekicks/contracts/session/id";

import { indexKeyOf } from "../index/columns.js";
import {
  insertEvent,
  insertGroup,
  insertSession,
  insertTag,
  purgeSession,
  sessionIdOf,
} from "./index-rows.js";

// Lowercase words both FTS5's `unicode61 remove_diacritics 2` and the index's tokenizer split and
// fold alike; `café` folds to `cafe` in both. A typed `deploy` matches `deploy` and `deployed`, a
// prefix longer than the index's prefix fields, so a row's count of it sums two words.
const VOCABULARY = [
  "deploy",
  "deployed",
  "worker",
  "billing",
  "stripe",
  "webhook",
  "retry",
  "release",
  "review",
  "cache",
  "queue",
  "schema",
  "cursor",
  "signal",
  "branch",
  "commit",
  "café",
  "token",
  "thread",
];
const GROUP_NAMES = ["release train", "billing work", "cache review notes"];
// Nested tags, one written in capitals, and `deployment`, which no search for `tag:deploy` keeps.
const TAGS = [
  "billing",
  "billing/stripe",
  "infra",
  "deploy/worker",
  "Billing/Webhook",
  "deployment",
];

/** A row the index holds, as the test wrote it, and the sessions it counts toward. */
export interface DirectoryRow {
  readonly key: number;
  readonly text: string;
  /** Where a hit on the row opens its session. */
  readonly cursor: EventCursor;
  /** Its session; for a group's name, every member in session id order. */
  readonly sessionIds: readonly SessionId[];
}

interface SeededEvent {
  readonly eventId: string;
  readonly sequence: number;
  readonly text: string;
}

interface SeededSession {
  name: string | null;
  groupId: string | undefined;
  readonly tags: string[];
  readonly events: SeededEvent[];
  // The sequence the session's next log row takes, past the rows the index never holds too.
  nextSequence: number;
}

const SESSION_START = encodeEventCursor(START_OF_LOG_POSITION);

/** The seeded directory in a test database, and the rows as written. */
export class SeededDirectory {
  readonly #database: Database;
  readonly #sessions = new Map<SessionId, SeededSession>();
  readonly #groups = new Map<string, string>();

  constructor(database: Database) {
    this.#database = database;
  }

  /** Writes the groups and `sessionCount` sessions with their titles, tags and log rows. */
  seed(sessionCount: number): void {
    GROUP_NAMES.forEach((name, index) => {
      this.#groups.set(insertGroup(this.#database, `group-${String(index)}`, name), name);
    });
    for (let index = 1; index <= sessionCount; index += 1) {
      const sessionId = sessionIdOf(index);
      const session: SeededSession = {
        name: index % 3 === 0 ? null : wordsAt(index * 5, 1 + (index % 3)),
        groupId: index % 4 === 0 ? undefined : `group-${String(index % GROUP_NAMES.length)}`,
        tags: [],
        events: [],
        nextSequence: 0,
      };
      insertSession(this.#database, sessionId, {
        ...(session.name === null ? {} : { name: session.name }),
        ...(session.groupId === undefined ? {} : { groupId: session.groupId }),
      });
      this.#sessions.set(sessionId, session);
      for (let place = 0; place < index % TAGS.length; place += 1) {
        const tag = TAGS[(index + place) % TAGS.length]!;
        insertTag(this.#database, sessionId, tag);
        session.tags.push(tag);
      }
      for (let place = 0; place < 2 + (index % 6); place += 1) {
        this.#appendEvent(sessionId, session, index * 31 + place * 17);
      }
    }
  }

  /** Every session the directory holds, in session id order. */
  sessionIds(): SessionId[] {
    return [...this.#sessions.keys()].sort();
  }

  /** Renames a session, or clears its title with `null`. */
  rename(sessionId: SessionId, name: string | null): void {
    this.#database.prepare("UPDATE sessions SET name = ? WHERE id = ?").run(name, sessionId);
    this.#sessionOf(sessionId).name = name;
  }

  /** Moves a session into a group, or out of every group with `undefined`. */
  moveToGroup(sessionId: SessionId, groupId: string | undefined): void {
    this.#database
      .prepare("UPDATE sessions SET group_id = ? WHERE id = ?")
      .run(groupId ?? null, sessionId);
    this.#sessionOf(sessionId).groupId = groupId;
  }

  /** Takes a tag off a session. */
  removeTag(sessionId: SessionId, tag: string): void {
    this.#database
      .prepare("DELETE FROM session_tags WHERE session_id = ? AND tag = ?")
      .run(sessionId, tag);
    const { tags } = this.#sessionOf(sessionId);
    tags.splice(tags.indexOf(tag), 1);
  }

  /** Writes a session with a title and one person's message, in no group and with no tag. */
  addSession(sessionId: SessionId, name: string, message: string): void {
    insertSession(this.#database, sessionId, { name });
    this.#sessions.set(sessionId, {
      name,
      groupId: undefined,
      tags: [],
      events: [],
      nextSequence: 0,
    });
    this.addMessage(sessionId, message);
  }

  /** Appends a person's message with `text` to a session. */
  addMessage(sessionId: SessionId, text: string): void {
    const session = this.#sessionOf(sessionId);
    const sequence = session.nextSequence;
    session.nextSequence += 1;
    const eventId = insertEvent(this.#database, {
      sessionId,
      sequence,
      type: "user.message",
      message: text,
    });
    session.events.push({ eventId, sequence, text });
  }

  /** Appends a thinking update with `text` to a session, which the index never holds. */
  addThinkingUpdate(sessionId: SessionId, text: string): void {
    const session = this.#sessionOf(sessionId);
    insertEvent(this.#database, {
      sessionId,
      sequence: session.nextSequence,
      type: "assistant.thinking_update",
      content: text,
    });
    session.nextSequence += 1;
  }

  /** Purges a session with every row it holds. */
  purge(sessionId: SessionId): void {
    purgeSession(this.#database, sessionId);
    this.#sessions.delete(sessionId);
  }

  /** Every row the index should hold now, keyed by the rowids the database gave them. */
  rows(): DirectoryRow[] {
    const rowidOf = (sql: string, ...bindings: string[]): number =>
      this.#database
        .prepare<string[], number>(sql)
        .pluck()
        .get(...bindings)!;
    const rows: DirectoryRow[] = [];
    for (const [groupId, name] of this.#groups) {
      rows.push({
        key: indexKeyOf(rowidOf("SELECT rowid FROM session_groups WHERE id = ?", groupId), "group"),
        text: name,
        cursor: SESSION_START,
        sessionIds: this.sessionIds().filter(
          (sessionId) => this.#sessionOf(sessionId).groupId === groupId,
        ),
      });
    }
    for (const [sessionId, session] of this.#sessions) {
      const sessionIds = [sessionId];
      const sessionRowid = rowidOf("SELECT rowid FROM sessions WHERE id = ?", sessionId);
      if (session.name !== null) {
        const key = indexKeyOf(sessionRowid, "title");
        rows.push({ key, text: session.name, cursor: SESSION_START, sessionIds });
      }
      for (const tag of session.tags) {
        const tagRowid = rowidOf(
          "SELECT rowid FROM session_tags WHERE session_id = ? AND tag = ?",
          sessionId,
          tag,
        );
        rows.push({
          key: indexKeyOf(tagRowid, "tag"),
          text: tag,
          cursor: SESSION_START,
          sessionIds,
        });
      }
      for (const event of session.events) {
        const eventRowid = rowidOf("SELECT rowid FROM session_events WHERE id = ?", event.eventId);
        rows.push({
          key: indexKeyOf(eventRowid, "event"),
          text: event.text,
          cursor: encodeEventCursor(event.sequence),
          sessionIds,
        });
      }
    }
    return rows;
  }

  // One log row of each kind in turn: a person's message, an assistant's, a tool call and a
  // thinking update, which the index never holds and so is not kept.
  #appendEvent(sessionId: SessionId, session: SeededSession, seed: number): void {
    const sequence = session.nextSequence;
    session.nextSequence += 1;
    const words = wordsAt(seed, 3 + (seed % 9));
    switch (sequence % 4) {
      case 0: {
        const eventId = insertEvent(this.#database, {
          sessionId,
          sequence,
          type: "user.message",
          message: words,
        });
        session.events.push({ eventId, sequence, text: words });
        return;
      }
      case 1: {
        const eventId = insertEvent(this.#database, {
          sessionId,
          sequence,
          type: "assistant.message",
          content: words,
        });
        session.events.push({ eventId, sequence, text: words });
        return;
      }
      case 2: {
        const content = JSON.stringify({ command: `git ${wordsAt(seed, 2)}` });
        const eventId = insertEvent(this.#database, {
          sessionId,
          sequence,
          type: "tool.invoked",
          toolName: "Bash",
          content,
        });
        session.events.push({ eventId, sequence, text: `Bash ${content}` });
        return;
      }
      default:
        insertEvent(this.#database, {
          sessionId,
          sequence,
          type: "assistant.thinking_update",
          content: words,
        });
    }
  }

  #sessionOf(sessionId: SessionId): SeededSession {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      throw new Error(`The seeded directory holds no session ${sessionId}.`);
    }
    return session;
  }
}

// `count` words of the vocabulary from a place `seed` picks, stepping by a stride coprime to its
// length so a text seldom repeats a word.
function wordsAt(seed: number, count: number): string {
  const words: string[] = [];
  for (let place = 0; place < count; place += 1) {
    words.push(VOCABULARY[(seed + place * 7) % VOCABULARY.length]!);
  }
  return words.join(" ");
}
