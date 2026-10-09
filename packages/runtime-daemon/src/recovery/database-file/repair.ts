// The database file's repair at a start, before anything opens it for writing, of the damage a
// run recorded beside it: the damaged file is copied aside untouched with its write-ahead log, its
// rows are recovered into a fresh file with SQLite's own recovery, and where the person keeps a
// backup that reads, each session whose events the newest backup holds more of takes them from it.
// The fresh file must hold every table, index, trigger and view of the schema and pass the full
// integrity check before it replaces the damaged one; every session's projections are then
// rebuilt from its events, and the search index, built from the damaged file's rows, is dropped
// to be built again from the fresh file's. A marker written once the fresh file is ready lets a
// start that a crash cut short finish the replacement rather than recover again from a file whose
// log is gone.

import { access, copyFile, open, rename, rm } from "node:fs/promises";
import * as path from "node:path";

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";

import { syncFolder, writeFileAtomically } from "../../file/atomic-write.js";
import { isMissingFileError } from "../../file/missing-error.js";
import { DAEMON_SCHEMA_SQL } from "../../session/daemon-schema.js";
import { copyDatabaseFilesAside, DATABASE_COMPANION_FILE_SUFFIXES } from "./aside-copy.js";
import { readDatabaseDamage, removeDatabaseDamage } from "./damage.js";
import { findNewestBackupDatabase } from "./newest-backup.js";
import { recoverIntoFreshFile } from "./sqlite-shell.js";

/** What the repair reads and where it writes. */
export interface DatabaseFileRepairOptions {
  readonly databasePath: string;
  readonly dataFolder: string;
  /** The search index's folder, built from the database's rows; a replaced file drops it. */
  readonly indexFolderPath: string;
  /** The folder the person's backups go to; read only when the file is damaged. */
  readonly readBackupFolder: () => Promise<string>;
  readonly now: () => Date;
  readonly writeServiceLog: (line: string) => void;
}

/**
 * How the repair ended: no damage was recorded or the file is absent, it was replaced by a
 * repaired one, or it is damaged and stays as it was, with why. A damaged file was copied aside
 * first, into `asideFolder`.
 */
export type DatabaseFileRepair =
  | { readonly outcome: "intact" }
  | {
      readonly outcome: "repaired";
      readonly asideFolder: string;
      /** The sessions whose events came from the newest backup. */
      readonly sessionsFromBackup: number;
    }
  | { readonly outcome: "unrepaired"; readonly asideFolder: string; readonly reason: string };

// The table `.recover` puts rows in that it found no table for; the aside copy keeps their bytes.
const LOST_AND_FOUND_TABLE_PATTERN = "lost_and_found%";

// Each session whose readable events the backup holds more of than the fresh file.
const SELECT_SESSIONS_RICHER_IN_BACKUP_SQL = `SELECT backup_counts.session_id AS session_id
  FROM (SELECT session_id, COUNT(*) FILTER (WHERE json_valid(payload)) AS readable
          FROM backup.session_events GROUP BY session_id) AS backup_counts
  LEFT JOIN (SELECT session_id, COUNT(*) FILTER (WHERE json_valid(payload)) AS readable
               FROM main.session_events GROUP BY session_id) AS fresh_counts
    ON fresh_counts.session_id = backup_counts.session_id
 WHERE backup_counts.readable > COALESCE(fresh_counts.readable, 0)`;

// Every table, index, trigger and view of a database but SQLite's own and the recovery's.
const SELECT_SCHEMA_OBJECTS_SQL = `SELECT type || ' ' || name AS object FROM main.sqlite_schema
  WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '${LOST_AND_FOUND_TABLE_PATTERN}'`;

/**
 * Repairs the database file when a run recorded damage to it, and finishes a replacement a crash
 * cut short. Never throws for a damaged file: one it could not repair comes back `unrepaired`,
 * stays in place and keeps its record, so the next start tries again. Throws when the record
 * cannot be read or the file cannot be copied aside at all.
 */
export async function repairDatabaseFile(
  options: DatabaseFileRepairOptions,
): Promise<DatabaseFileRepair> {
  const { databasePath } = options;
  const freshPath = `${databasePath}.recovered`;
  const readyMarkerPath = `${freshPath}-ready`;
  if (await fileExists(readyMarkerPath)) {
    options.writeServiceLog("A repaired database file was ready; its replacement is finished now");
    await replaceDatabaseFile(options, freshPath, readyMarkerPath);
  }
  const damage = await readDatabaseDamage(databasePath);
  if (damage === undefined) {
    return { outcome: "intact" };
  }
  if (!(await fileExists(databasePath))) {
    await removeDatabaseDamage(databasePath);
    return { outcome: "intact" };
  }
  options.writeServiceLog(`The database file is damaged: ${damage}`);
  const asideFolder = await copyDatabaseFilesAside(options);
  options.writeServiceLog(`The damaged database's files are copied aside in ${asideFolder}`);
  await rm(freshPath, { force: true });
  try {
    await recoverIntoFreshFile(databasePath, freshPath);
    const sessionsFromBackup = await takeRicherSessionsFromBackup(freshPath, options);
    prepareFreshFile(freshPath, options.writeServiceLog);
    await syncFile(freshPath);
    await writeFileAtomically(readyMarkerPath, "", 0o600);
    await replaceDatabaseFile(options, freshPath, readyMarkerPath);
    options.writeServiceLog(
      `The database file was recovered; ${String(sessionsFromBackup)} sessions took their ` +
        "events from the newest backup",
    );
    return { outcome: "repaired", asideFolder, sessionsFromBackup };
  } catch (error) {
    await rm(freshPath, { force: true });
    const reason = error instanceof Error ? error.message : String(error);
    options.writeServiceLog(`The database file could not be repaired: ${reason}`);
    return { outcome: "unrepaired", asideFolder, reason };
  }
}

// Takes each session the newest backup holds more readable events of from it, and returns how
// many. The backup's database is read from a copy in the data folder, so nothing is written
// beside the person's backups. A backup that cannot be found or read heals nothing, like no
// backup: the recovery alone heals the file, and the log says why the backup was passed over.
async function takeRicherSessionsFromBackup(
  freshPath: string,
  options: DatabaseFileRepairOptions,
): Promise<number> {
  const backupCopyPath = `${options.databasePath}.backup-read`;
  try {
    const backupDatabase = await findNewestBackupDatabase(
      await options.readBackupFolder(),
      options.writeServiceLog,
    );
    if (backupDatabase === undefined) {
      return 0;
    }
    await copyFile(backupDatabase, backupCopyPath);
    const fresh = new Database(freshPath, { fileMustExist: true });
    try {
      fresh.prepare("ATTACH DATABASE ? AS backup").run(backupCopyPath);
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
      fresh.close();
    }
  } catch (error) {
    options.writeServiceLog(
      "The newest backup could not be read and was passed over: " +
        (error instanceof Error ? error.message : String(error)),
    );
    return 0;
  } finally {
    for (const suffix of ["", ...DATABASE_COMPANION_FILE_SUFFIXES]) {
      await rm(`${backupCopyPath}${suffix}`, { force: true });
    }
  }
}

// The stored columns of an event; SQLite computes a generated column and refuses a value for it.
const STORED_EVENT_COLUMNS = `id, session_id, sequence, occurred_at, monotonic_ns, category, type,
  actor, payload, content_payload, correlation_id, causation_id, version`;

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
// could place nowhere, clears every projection cursor so every session is rebuilt from its
// events, and refuses a file that fails the full integrity check.
function prepareFreshFile(freshPath: string, writeServiceLog: (line: string) => void): void {
  const fresh = new Database(freshPath, { fileMustExist: true });
  try {
    const missingObjects = listMissingSchemaObjects(fresh);
    if (missingObjects.length > 0) {
      throw new Error(`The recovered file lacks ${missingObjects.join(", ")}`);
    }
    dropLostAndFound(fresh, writeServiceLog);
    fresh.exec("DELETE FROM projection_cursors");
    const integrity = fresh.pragma("integrity_check") as { integrity_check: string }[];
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
      throw new Error(
        `The recovered file fails its integrity check: ${integrity
          .map((row) => row.integrity_check)
          .join("; ")}`,
      );
    }
  } finally {
    fresh.close();
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
function dropLostAndFound(fresh: DatabaseType, writeServiceLog: (line: string) => void): void {
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

// Opened for writing because Windows refuses to flush a file opened only for reading.
async function syncFile(filePath: string): Promise<void> {
  const file = await open(filePath, "r+");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

// The damaged file's log and index go first, so SQLite never replays them into the fresh file;
// both are in the aside copy. The search index goes too, before the marker, so no start opens an
// index of rows the fresh file lost or took from a backup. A start a crash cut short after the
// rename finds the fresh file already in place. The folder is flushed so the rename survives a
// power loss; the damage record then goes, and the marker last.
async function replaceDatabaseFile(
  options: Pick<DatabaseFileRepairOptions, "databasePath" | "indexFolderPath">,
  freshPath: string,
  readyMarkerPath: string,
): Promise<void> {
  const { databasePath } = options;
  for (const suffix of DATABASE_COMPANION_FILE_SUFFIXES) {
    await rm(`${databasePath}${suffix}`, { force: true });
  }
  await rm(options.indexFolderPath, { recursive: true, force: true });
  if (await fileExists(freshPath)) {
    await rename(freshPath, databasePath);
  }
  await syncFolder(path.dirname(databasePath));
  await removeDatabaseDamage(databasePath);
  await rm(readyMarkerPath);
  await syncFolder(path.dirname(databasePath));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}
