// Readies a repair's fresh file in the daemon's own `sqlite3` shell, each step a child process the
// service's stop ends at once, while the main thread goes on answering that the service is
// repairing; on a file of several gigabytes the full integrity check alone takes minutes. Where a
// backup's database was copied beside the file, each session whose readable events that backup
// holds more of takes them from it; a backup that cannot be read heals nothing, and the log says
// why it was passed over. The fresh file must then hold every table, index, trigger and view of
// the schema; the rows the recovery could place in no table leave it, every session is marked for
// a rebuild from its events, and the file must pass the full integrity check. Each step's writes
// commit with a full flush of the drive.

import Database from "better-sqlite3";

import { START_OF_LOG_POSITION } from "@ai-sidekicks/contracts/session/event-cursor";

import { DATABASE_NOW_SQL } from "../../database/statement.js";
import { DAEMON_SCHEMA_SQL } from "../../session/daemon-schema.js";
import { mintUuidV7 } from "../../uuid-v7.js";
import { quoteSqlIdentifier, quoteSqlText, runSqliteShellScript } from "./sqlite-shell.js";

/** The fresh file a repair readies, the backup copy it may take sessions from, and its shell. */
export interface FreshFilePreparation {
  readonly shellProgram: string;
  readonly freshPath: string;
  /** A copy of the newest backup's database beside the file, or `undefined` with none. */
  readonly backupCopyPath: string | undefined;
  readonly writeServiceLog: (line: string) => void;
  /** Ends the step under way, and with it the preparation, when it aborts. */
  readonly stopSignal: AbortSignal;
}

// The table `.recover` puts rows in that it found no table for; the aside copy keeps their bytes.
const LOST_AND_FOUND_TABLE_PATTERN = "lost_and_found%";

// The stored columns of an event; SQLite computes a generated column and refuses a value for it.
const STORED_EVENT_COLUMNS = `id, session_id, sequence, occurred_at, monotonic_ns, category, type,
  actor, payload, content_payload, correlation_id, causation_id, version`;

// What every step that writes runs first: foreign keys checked as the daemon's connections check
// them, and each commit flushed through the drive's cache.
const WRITING_STEP_PREAMBLE = `PRAGMA foreign_keys = ON;
PRAGMA fullfsync = ON;
`;

// Each session whose readable events the backup holds more of than the fresh file, kept for the
// step's statements, and then the backup's events and snapshots of each in place of the fresh
// file's, in sequence order, so their rowids keep the log's order in the session. A snapshot names
// the event it reflects, so it goes and comes with its events. Ends by writing how many sessions
// came from the backup.
const TAKE_RICHER_SESSIONS_SQL = `CREATE TEMP TABLE richer_sessions AS
  SELECT backup_counts.session_id AS session_id
    FROM (SELECT session_id, COUNT(*) FILTER (WHERE json_valid(payload)) AS readable
            FROM backup.session_events GROUP BY session_id) AS backup_counts
    LEFT JOIN (SELECT session_id, COUNT(*) FILTER (WHERE json_valid(payload)) AS readable
                 FROM main.session_events GROUP BY session_id) AS fresh_counts
      ON fresh_counts.session_id = backup_counts.session_id
   WHERE backup_counts.readable > COALESCE(fresh_counts.readable, 0);
BEGIN;
DELETE FROM main.session_snapshots
  WHERE session_id IN (SELECT session_id FROM temp.richer_sessions);
DELETE FROM main.session_events
  WHERE session_id IN (SELECT session_id FROM temp.richer_sessions);
INSERT INTO main.session_events (${STORED_EVENT_COLUMNS})
  SELECT ${STORED_EVENT_COLUMNS} FROM backup.session_events
   WHERE session_id IN (SELECT session_id FROM temp.richer_sessions)
   ORDER BY session_id, sequence;
INSERT INTO main.session_snapshots
  SELECT * FROM backup.session_snapshots
   WHERE session_id IN (SELECT session_id FROM temp.richer_sessions);
COMMIT;
SELECT COUNT(*) FROM temp.richer_sessions;
`;

// Every table, index, trigger and view of the file but SQLite's own and the recovery's, and the
// recovery's tables of rows it placed nowhere, each named by what it is.
const SELECT_SCHEMA_AND_LOST_TABLES_SQL = `SELECT 'object' AS kind, type || ' ' || name AS name
    FROM main.sqlite_schema
   WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '${LOST_AND_FOUND_TABLE_PATTERN}'
  UNION ALL
  SELECT 'lost', name FROM main.sqlite_schema
   WHERE type = 'table' AND name LIKE '${LOST_AND_FOUND_TABLE_PATTERN}';
`;

// The sessions with events that hold no cursor, which the recovery lost.
const SELECT_SESSIONS_WITHOUT_CURSOR_SQL = `SELECT DISTINCT session_id FROM session_events
  WHERE NOT EXISTS (SELECT 1 FROM projection_cursors
                     WHERE projection_cursors.session_id = session_events.session_id);
`;

// Every cursor of a session with events goes stale, so the session rebuilds from its events.
const MARK_CURSORS_STALE_SQL = `UPDATE projection_cursors
  SET state = 'stale', updated_at = ${DATABASE_NOW_SQL}
  WHERE EXISTS (SELECT 1 FROM session_events
                 WHERE session_events.session_id = projection_cursors.session_id);
`;

// The most new cursors one statement writes.
const CURSOR_ROWS_PER_STATEMENT = 500;

/**
 * Takes each session the backup copy holds more readable events of from it, then readies the
 * fresh file, and resolves with how many sessions came from the backup. Rejects when the file
 * lacks an object of the schema or fails the full integrity check, when a step fails, and when
 * `stopSignal` aborts, once the step's shell has exited.
 */
export async function prepareFreshFile(preparation: FreshFilePreparation): Promise<number> {
  const sessionsFromBackup =
    preparation.backupCopyPath === undefined
      ? 0
      : await takeRicherSessionsFromBackup(preparation, preparation.backupCopyPath);
  const { objects, lostTables } = await readSchemaAndLostTables(preparation);
  const missingObjects = listSchemaObjects().filter((object) => !objects.has(object));
  if (missingObjects.length > 0) {
    throw new Error(`The recovered file lacks ${missingObjects.join(", ")}`);
  }
  await dropLostTablesAndMarkStale(preparation, lostTables);
  await refuseFailedIntegrity(preparation);
  return sessionsFromBackup;
}

// Returns how many sessions came from the backup; a backup that cannot be read is passed over, and
// its step's transaction rolls back whole.
async function takeRicherSessionsFromBackup(
  preparation: FreshFilePreparation,
  backupPath: string,
): Promise<number> {
  try {
    const output = await runShell(
      preparation,
      `${WRITING_STEP_PREAMBLE}ATTACH DATABASE ${quoteSqlText(backupPath)} AS backup;\n` +
        TAKE_RICHER_SESSIONS_SQL,
      { step: "taking sessions from the newest backup" },
    );
    const count = Number(output.trim().split("\n").at(-1));
    if (!Number.isSafeInteger(count)) {
      throw new Error(`The shell answered the count of sessions taken with ${output.trim()}`);
    }
    return count;
  } catch (error) {
    if (preparation.stopSignal.aborted) {
      throw error;
    }
    preparation.writeServiceLog(
      "The newest backup could not be read and was passed over: " +
        (error instanceof Error ? error.message : String(error)),
    );
    return 0;
  }
}

async function readSchemaAndLostTables(
  preparation: FreshFilePreparation,
): Promise<{ objects: ReadonlySet<string>; lostTables: readonly string[] }> {
  const rows = parseJsonRows(
    await runShell(preparation, SELECT_SCHEMA_AND_LOST_TABLES_SQL, {
      step: "reading the fresh file's schema",
      isReadOnly: true,
      isJson: true,
    }),
  ) as readonly { kind: "object" | "lost"; name: string }[];
  return {
    objects: new Set(rows.filter((row) => row.kind === "object").map((row) => row.name)),
    lostTables: rows.filter((row) => row.kind === "lost").map((row) => row.name),
  };
}

// The rows of the recovery's tables of lost rows stay in the aside copy, so the live file keeps
// no table the schema does not name. Every session with events is marked for a rebuild: its
// cursor goes stale, and one the recovery lost is written stale, all in one transaction.
async function dropLostTablesAndMarkStale(
  preparation: FreshFilePreparation,
  lostTables: readonly string[],
): Promise<void> {
  const sessionsWithoutCursor = (
    parseJsonRows(
      await runShell(preparation, SELECT_SESSIONS_WITHOUT_CURSOR_SQL, {
        step: "listing the sessions the recovery left without a cursor",
        isReadOnly: true,
        isJson: true,
      }),
    ) as readonly { session_id: string }[]
  ).map((row) => row.session_id);
  const lostRowCounts = lostTables.map(
    (table) => `SELECT COUNT(*) FROM ${quoteSqlIdentifier(table)};\n`,
  );
  const output = await runShell(
    preparation,
    `${WRITING_STEP_PREAMBLE}BEGIN;\n${lostRowCounts.join("")}` +
      lostTables.map((table) => `DROP TABLE ${quoteSqlIdentifier(table)};\n`).join("") +
      MARK_CURSORS_STALE_SQL +
      insertStaleCursorsSql(sessionsWithoutCursor) +
      "COMMIT;\n",
    { step: "dropping the lost rows and marking every session for a rebuild" },
  );
  const counts = output.trim() === "" ? [] : output.trim().split("\n");
  for (const count of counts) {
    preparation.writeServiceLog(
      `The recovery found ${count} rows it could place in no table; they stay in the copy aside`,
    );
  }
}

// A stale cursor at the start of the log for each session, its id minted as every cursor's is.
function insertStaleCursorsSql(sessionIds: readonly string[]): string {
  const statements: string[] = [];
  for (let start = 0; start < sessionIds.length; start += CURSOR_ROWS_PER_STATEMENT) {
    const rows = sessionIds
      .slice(start, start + CURSOR_ROWS_PER_STATEMENT)
      .map(
        (sessionId) =>
          `(${quoteSqlText(mintUuidV7())}, ${quoteSqlText(sessionId)}, ` +
          `${String(START_OF_LOG_POSITION)}, 'stale', ${DATABASE_NOW_SQL})`,
      );
    statements.push(
      "INSERT INTO projection_cursors (id, session_id, last_sequence, state, updated_at) " +
        `VALUES ${rows.join(", ")};\n`,
    );
  }
  return statements.join("");
}

async function refuseFailedIntegrity(preparation: FreshFilePreparation): Promise<void> {
  const output = await runShell(preparation, "PRAGMA integrity_check;\n", {
    step: "checking the fresh file's integrity",
    isReadOnly: true,
  });
  const lines = output.trim().split("\n");
  if (lines.length !== 1 || lines[0] !== "ok") {
    throw new Error(`The recovered file fails its integrity check: ${lines.join("; ")}`);
  }
}

// Every table, index, trigger and view of the daemon's schema, each as its type and name.
function listSchemaObjects(): string[] {
  const schema = new Database(":memory:");
  try {
    schema.exec(DAEMON_SCHEMA_SQL);
    return schema
      .prepare<[], { object: string }>(
        "SELECT type || ' ' || name AS object FROM main.sqlite_schema " +
          "WHERE name NOT LIKE 'sqlite_%'",
      )
      .all()
      .map((row) => row.object);
  } finally {
    schema.close();
  }
}

function runShell(
  preparation: FreshFilePreparation,
  script: string,
  options: { step: string; isReadOnly?: boolean; isJson?: boolean },
): Promise<string> {
  return runSqliteShellScript(preparation.shellProgram, preparation.freshPath, script, {
    ...options,
    stopSignal: preparation.stopSignal,
  });
}

// The shell writes nothing in JSON form for a query that answers no row.
function parseJsonRows(output: string): unknown[] {
  return output.trim() === "" ? [] : (JSON.parse(output) as unknown[]);
}
