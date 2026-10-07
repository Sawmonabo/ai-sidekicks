// Writes the rows the full-text index follows straight into a test database, so a search test
// sees exactly what the schema's triggers index from them.

import type { Database } from "better-sqlite3";

import { foldName } from "@ai-sidekicks/contracts/name-fold";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

const TIMESTAMP = "2026-10-06T00:00:00.000Z";

/** A session id built from a small number, unique per test. */
export function sessionIdOf(index: number): SessionId {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` as SessionId;
}

/** Inserts a session's directory row; `lastActivityAt` orders a search by tag alone. */
export function insertSession(
  database: Database,
  sessionId: SessionId,
  options: {
    readonly name?: string;
    readonly lastActivityAt?: string;
    readonly groupId?: string;
  } = {},
): void {
  database
    .prepare(
      `INSERT INTO sessions (id, shape, state, name, created_at, updated_at, last_activity_at,
                             group_id)
       VALUES (?, 'project', 'active', ?, ?, ?, ?, ?)`,
    )
    .run(
      sessionId,
      options.name ?? null,
      TIMESTAMP,
      TIMESTAMP,
      options.lastActivityAt ?? TIMESTAMP,
      options.groupId ?? null,
    );
}

/** One log row: its type, its position, and the text it carries where that type keeps it. */
export interface IndexedEventInput {
  readonly sessionId: SessionId;
  readonly sequence: number;
  readonly type: string;
  /** A person's words, which `user.message` keeps in its payload. */
  readonly message?: string;
  /** An assistant's or a tool's body, kept beside the payload. */
  readonly content?: string;
  readonly toolName?: string;
}

/** Inserts one log row and answers its id. */
export function insertEvent(database: Database, input: IndexedEventInput): string {
  const eventId = `event-${input.sessionId}-${String(input.sequence)}`;
  const payload: Record<string, unknown> = { sessionId: input.sessionId };
  if (input.message !== undefined) {
    payload["message"] = input.message;
  }
  if (input.toolName !== undefined) {
    payload["toolName"] = input.toolName;
  }
  database
    .prepare(
      `INSERT INTO session_events (id, session_id, sequence, occurred_at, monotonic_ns, category,
                                   type, payload, content_payload)
       VALUES (?, ?, ?, ?, 0, 'assistant_output', ?, ?, ?)`,
    )
    .run(
      eventId,
      input.sessionId,
      input.sequence,
      TIMESTAMP,
      input.type,
      JSON.stringify(payload),
      input.content ?? null,
    );
  return eventId;
}

/** Inserts a tag on a session, folded as the tag store folds it. */
export function insertTag(database: Database, sessionId: SessionId, tag: string): void {
  database
    .prepare(`INSERT INTO session_tags (session_id, tag, tag_folded) VALUES (?, ?, ?)`)
    .run(sessionId, tag, foldName(tag));
}

/** Inserts a project's group and answers its id. */
export function insertGroup(database: Database, groupId: string, name: string): string {
  database
    .prepare(
      `INSERT INTO session_groups (id, project_id, name, name_folded, created_at)
       VALUES (?, 'project-1', ?, ?, ?)`,
    )
    .run(groupId, name, foldName(name), TIMESTAMP);
  return groupId;
}
