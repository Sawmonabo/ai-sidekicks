// The thread that readies a repair's fresh file, so none of its long reads holds the daemon's main
// thread while the socket answers that the service is repairing. Where a backup's database was
// copied beside the file, each session whose readable events that backup holds more of takes them
// from it; a backup that cannot be read heals nothing, and the log says why it was passed over.
// The fresh file must then hold every table, index, trigger and view of the schema; the rows the
// recovery could place in no table leave it, every session is marked for a rebuild from its
// events, and the file must pass the full integrity check.

import { parentPort, workerData, type MessagePort } from "node:worker_threads";

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";

import { START_OF_LOG_POSITION } from "@ai-sidekicks/contracts/session/event-cursor";

import { DATABASE_NOW_SQL } from "../../../database/statement.js";
import { DAEMON_SCHEMA_SQL } from "../../../session/daemon-schema.js";
import { mintUuidV7 } from "../../../uuid-v7.js";
import { carryError } from "../../../worker/carried-error.js";
import type { FreshFileReply, FreshFileWorkerData } from "./preparation.js";

// The table `.recover` puts rows in that it found no table for; the aside copy keeps their bytes.
const LOST_AND_FOUND_TABLE_PATTERN = "lost_and_found%";

// The stored columns of an event; SQLite computes a generated column and refuses a value for it.
const STORED_EVENT_COLUMNS = `id, session_id, sequence, occurred_at, monotonic_ns, category, type,
  actor, payload, content_payload, correlation_id, causation_id, version`;

// Each session whose readable events the backup holds more of than the fresh file.
const SELECT_SESSIONS_RICHER_IN_BACKUP_SQL = `SELECT backup_counts.session_id AS session_id
  FROM (SELECT session_id, COUNT(*) FILTER (WHERE json_valid(payload)) AS readable
          FROM backup.session_events GROUP BY session_id) AS backup_counts
  LEFT JOIN (SELECT session_id, COUNT(*) FILTER (WHERE json_valid(payload)) AS readable
               FROM main.session_events GROUP BY session_id) AS fresh_counts
    ON fresh_counts.session_id = backup_counts.session_id
 WHERE backup_counts.readable > COALESCE(fresh_counts.readable, 0)`;

// Marks every session with events for a rebuild: its cursor goes stale, and one the recovery lost
// is written stale.
const MARK_EVERY_SESSION_STALE_SQL = `INSERT INTO projection_cursors
    (id, session_id, last_sequence, state, updated_at)
  SELECT mint_cursor_id(), session_id, ${String(START_OF_LOG_POSITION)}, 'stale',
         ${DATABASE_NOW_SQL}
    FROM (SELECT DISTINCT session_id FROM session_events) WHERE true
  ON CONFLICT (session_id) DO UPDATE SET state = 'stale', updated_at = excluded.updated_at`;

// Every table, index, trigger and view of a database but SQLite's own and the recovery's.
const SELECT_SCHEMA_OBJECTS_SQL = `SELECT type || ' ' || name AS object FROM main.sqlite_schema
  WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '${LOST_AND_FOUND_TABLE_PATTERN}'`;

if (parentPort === null) {
  throw new Error("The fresh file's thread runs only as a worker thread");
}
const port: MessagePort = parentPort;
const post = (reply: FreshFileReply): void => {
  port.postMessage(reply);
};
const writeServiceLog = (line: string): void => {
  post({ type: "log", line });
};

const { freshPath, backupCopyPath } = workerData as FreshFileWorkerData;
try {
  const fresh = new Database(freshPath, { fileMustExist: true });
  try {
    const sessionsFromBackup =
      backupCopyPath === undefined ? 0 : takeRicherSessionsFromBackup(fresh, backupCopyPath);
    prepareFreshFile(fresh);
    post({ type: "prepared", sessionsFromBackup });
  } finally {
    fresh.close();
  }
} catch (error) {
  post({ type: "failed", error: carryError(error) });
}

// Takes each session the backup holds more readable events of from it, and returns how many.
function takeRicherSessionsFromBackup(fresh: DatabaseType, backupPath: string): number {
  try {
    fresh.prepare("ATTACH DATABASE ? AS backup").run(backupPath);
    try {
      const sessionIds = fresh
        .prepare<[], { session_id: string }>(SELECT_SESSIONS_RICHER_IN_BACKUP_SQL)
        .all()
        .map((row) => row.session_id);
      fresh.transaction(() => {
        for (const sessionId of sessionIds) {
          takeSessionFromBackup(fresh, sessionId);
        }
      })();
      return sessionIds.length;
    } finally {
      fresh.exec("DETACH DATABASE backup");
    }
  } catch (error) {
    writeServiceLog(
      "The newest backup could not be read and was passed over: " +
        (error instanceof Error ? error.message : String(error)),
    );
    return 0;
  }
}

// A snapshot names the event it reflects, so the session's snapshots go and come with its events.
// Its events are inserted in sequence order, so their rowids keep the log's order in the session.
function takeSessionFromBackup(fresh: DatabaseType, sessionId: string): void {
  fresh.prepare("DELETE FROM main.session_snapshots WHERE session_id = ?").run(sessionId);
  fresh.prepare("DELETE FROM main.session_events WHERE session_id = ?").run(sessionId);
  fresh
    .prepare(
      `INSERT INTO main.session_events (${STORED_EVENT_COLUMNS})
         SELECT ${STORED_EVENT_COLUMNS} FROM backup.session_events WHERE session_id = ?
         ORDER BY sequence`,
    )
    .run(sessionId);
  fresh
    .prepare(
      "INSERT INTO main.session_snapshots SELECT * FROM backup.session_snapshots WHERE session_id = ?",
    )
    .run(sessionId);
}

// Refuses a fresh file that lacks an object of the schema, drops the recovery's table of rows it
// could place nowhere, marks every session for a rebuild from its events, and refuses a file that
// fails the full integrity check.
function prepareFreshFile(fresh: DatabaseType): void {
  const missingObjects = listMissingSchemaObjects(fresh);
  if (missingObjects.length > 0) {
    throw new Error(`The recovered file lacks ${missingObjects.join(", ")}`);
  }
  dropLostAndFound(fresh);
  fresh.function("mint_cursor_id", { deterministic: false }, mintUuidV7);
  fresh.exec(MARK_EVERY_SESSION_STALE_SQL);
  const integrity = fresh.pragma("integrity_check") as { integrity_check: string }[];
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
    throw new Error(
      `The recovered file fails its integrity check: ${integrity
        .map((row) => row.integrity_check)
        .join("; ")}`,
    );
  }
}

// The schema's objects the file does not hold, each as its type and name.
function listMissingSchemaObjects(database: DatabaseType): string[] {
  const schema = new Database(":memory:");
  try {
    schema.exec(DAEMON_SCHEMA_SQL);
    const held = new Set(listSchemaObjects(database));
    return listSchemaObjects(schema).filter((object) => !held.has(object));
  } finally {
    schema.close();
  }
}

function listSchemaObjects(database: DatabaseType): string[] {
  return database
    .prepare<[], { object: string }>(SELECT_SCHEMA_OBJECTS_SQL)
    .all()
    .map((row) => row.object);
}

// The rows stay in the aside copy, so the live file keeps no table the schema does not name.
function dropLostAndFound(fresh: DatabaseType): void {
  const tables = fresh
    .prepare<[string], { name: string }>(
      "SELECT name FROM main.sqlite_schema WHERE type = 'table' AND name LIKE ?",
    )
    .all(LOST_AND_FOUND_TABLE_PATTERN)
    .map((row) => row.name);
  for (const table of tables) {
    const { count } = fresh.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as {
      count: number;
    };
    writeServiceLog(
      `The recovery found ${String(count)} rows it could place in no table; they stay in the ` +
        "copy aside",
    );
    fresh.exec(`DROP TABLE "${table}"`);
  }
}
