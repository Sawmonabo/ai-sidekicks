// A session's own console settings, over the `session_console_state` table: the advisor a Claude
// Code session keeps from its creation, changed only by `/advisor` in that session, and the Build
// or Plan mode the provider last took. Every process the daemon starts for the session reads the
// advisor at launch, and a restart resumes in the mode.

import type { Database } from "better-sqlite3";

import type { SessionMode } from "@ai-sidekicks/contracts/session/controls/methods";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { WriteStatement } from "../database/statement.js";

/** The row a Claude Code session is born with, its advisor copied from the machine's default. */
export const INSERT_CONSOLE_STATE_SQL = `INSERT INTO session_console_state
  (session_id, advisor_model, updated_at) VALUES (?, ?, ?)`;

// A session that was not born on Claude Code has no row until its first change needs one.
const UPSERT_ADVISOR_MODEL_SQL = `INSERT INTO session_console_state
  (session_id, advisor_model, updated_at) VALUES (@sessionId, @advisorModel, @updatedAt)
  ON CONFLICT(session_id) DO UPDATE
    SET advisor_model = excluded.advisor_model, updated_at = excluded.updated_at`;

/** The statement storing the advisor `/advisor` set, committed in its event's own write. */
export function advisorModelChangeStatement(
  sessionId: SessionId,
  advisorModel: string | null,
  updatedAt: string,
): WriteStatement {
  return { sql: UPSERT_ADVISOR_MODEL_SQL, bindings: { sessionId, advisorModel, updatedAt } };
}

/** The session's own advisor, or `null` when it is off or the session never had one. */
export function readSessionAdvisorModel(reader: Database, sessionId: SessionId): string | null {
  const row = reader
    .prepare<
      [string],
      { advisorModel: string | null }
    >("SELECT advisor_model AS advisorModel FROM session_console_state WHERE session_id = ?")
    .get(sessionId);
  return row?.advisorModel ?? null;
}

const UPSERT_SESSION_MODE_SQL = `INSERT INTO session_console_state
  (session_id, session_mode, updated_at) VALUES (@sessionId, @sessionMode, @updatedAt)
  ON CONFLICT(session_id) DO UPDATE
    SET session_mode = excluded.session_mode, updated_at = excluded.updated_at`;

/** The statement storing the mode a `session.modeUpdate` moved the provider to. */
export function sessionModeChangeStatement(
  sessionId: SessionId,
  sessionMode: SessionMode,
  updatedAt: string,
): WriteStatement {
  return { sql: UPSERT_SESSION_MODE_SQL, bindings: { sessionId, sessionMode, updatedAt } };
}

/** The mode the session was last moved to, Build for a session never moved. */
export function readSessionMode(reader: Database, sessionId: SessionId): SessionMode {
  const row = reader
    .prepare<
      [string],
      { sessionMode: SessionMode }
    >("SELECT session_mode AS sessionMode FROM session_console_state WHERE session_id = ?")
    .get(sessionId);
  return row?.sessionMode ?? "build";
}
