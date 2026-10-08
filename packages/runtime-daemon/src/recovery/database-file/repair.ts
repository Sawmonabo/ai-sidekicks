// The database file's repair at a start, before anything opens it for writing. A quick structural
// check reads the file; a damaged one is copied aside untouched with its write-ahead log, its rows
// are recovered into a fresh file with SQLite's own recovery, and where the person keeps backups,
// each session whose events the newest backup holds more of takes them from the backup. The fresh
// file must hold every table of the schema and pass the full integrity check before it replaces
// the damaged one; every session's projections are then rebuilt from its events.

import { access, open, rename, rm } from "node:fs/promises";
import * as path from "node:path";

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";

import { DAEMON_SCHEMA_SQL } from "../../session/daemon-schema.js";
import { hasSqliteErrorCode } from "../../session/sqlite-error-code.js";
import { copyDatabaseFilesAside } from "./aside-copy.js";
import { findNewestBackupDatabase } from "./newest-backup.js";
import { recoverIntoFreshFile } from "./sqlite-shell.js";

/** What the repair reads and where it writes. */
export interface DatabaseFileRepairOptions {
  readonly databasePath: string;
  readonly dataFolder: string;
  /** The folder the person's backups go to; read only when the file is damaged. */
  readonly readBackupFolder: () => Promise<string>;
  readonly now: () => Date;
  readonly writeServiceLog: (line: string) => void;
}

/**
 * How the repair ended: the file was sound or absent, it was replaced by a repaired one, or it is
 * damaged and stays as it was, with why. A damaged file was copied aside first, into
 * `asideFolder`.
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

// The companion files SQLite keeps beside a database in write-ahead-log mode; the damaged file's
// would be replayed into the fresh one.
const COMPANION_FILE_SUFFIXES = ["-wal", "-shm"] as const;

// Each session whose readable events the backup holds more of than the fresh file.
const SELECT_SESSIONS_RICHER_IN_BACKUP_SQL = `SELECT backup_counts.session_id AS session_id
  FROM (SELECT session_id, COUNT(*) FILTER (WHERE json_valid(payload)) AS readable
          FROM backup.session_events GROUP BY session_id) AS backup_counts
  LEFT JOIN (SELECT session_id, COUNT(*) FILTER (WHERE json_valid(payload)) AS readable
               FROM main.session_events GROUP BY session_id) AS fresh_counts
    ON fresh_counts.session_id = backup_counts.session_id
 WHERE backup_counts.readable > COALESCE(fresh_counts.readable, 0)`;

/**
 * Checks the database file and repairs it when it is damaged. Never throws for a damaged file:
 * one it could not repair comes back `unrepaired` and stays in place. Throws when the file cannot
 * be checked or copied aside at all.
 */
export async function repairDatabaseFile(
  options: DatabaseFileRepairOptions,
): Promise<DatabaseFileRepair> {
  const { databasePath } = options;
  if (!(await fileExists(databasePath))) {
    return { outcome: "intact" };
  }
  const damage = findStructuralDamage(databasePath);
  if (damage === undefined) {
    return { outcome: "intact" };
  }
  options.writeServiceLog(`The database file is damaged: ${damage}`);
  const asideFolder = await copyDatabaseFilesAside(options);
  options.writeServiceLog(`The damaged database's files were copied aside to ${asideFolder}`);
  const freshPath = `${databasePath}.recovered`;
  await rm(freshPath, { force: true });
  try {
    await recoverIntoFreshFile(databasePath, freshPath);
    const backupDatabase = await findNewestBackupDatabase(
      await options.readBackupFolder(),
      options.writeServiceLog,
    );
    const sessionsFromBackup = prepareFreshFile(freshPath, backupDatabase, options.writeServiceLog);
    await replaceDatabaseFile(databasePath, freshPath);
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

// What the quick structural check finds wrong with the file, `undefined` when it is sound. SQLite
// reports a page it cannot read by throwing rather than by a row.
function findStructuralDamage(databasePath: string): string | undefined {
  let database: DatabaseType | undefined;
  try {
    database = new Database(databasePath, { readonly: true, fileMustExist: true });
    const rows = database.pragma("quick_check") as { quick_check: string }[];
    return rows.length === 1 && rows[0]?.quick_check === "ok"
      ? undefined
      : rows.map((row) => row.quick_check).join("; ");
  } catch (error) {
    if (hasSqliteErrorCode(error, "SQLITE_CORRUPT") || hasSqliteErrorCode(error, "SQLITE_NOTADB")) {
      return error instanceof Error ? error.message : String(error);
    }
    throw error;
  } finally {
    database?.close();
  }
}

// Takes each session the newest backup holds more readable events of from the backup, clears
// every projection cursor so every session is rebuilt from its events, then refuses a file that
// lacks a table of the schema or fails the full integrity check. Returns the sessions taken from
// the backup.
function prepareFreshFile(
  freshPath: string,
  backupDatabase: string | undefined,
  writeServiceLog: (line: string) => void,
): number {
  const fresh = new Database(freshPath, { fileMustExist: true });
  try {
    const sessionsFromBackup =
      backupDatabase === undefined
        ? 0
        : takeRicherSessionsFromBackup(fresh, backupDatabase, writeServiceLog);
    fresh.exec("DELETE FROM projection_cursors");
    const missingTables = listMissingSchemaTables(fresh);
    if (missingTables.length > 0) {
      throw new Error(`The recovered file lacks the tables ${missingTables.join(", ")}`);
    }
    const integrity = fresh.pragma("integrity_check") as { integrity_check: string }[];
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
      throw new Error(
        `The recovered file fails its integrity check: ${integrity
          .map((row) => row.integrity_check)
          .join("; ")}`,
      );
    }
    return sessionsFromBackup;
  } finally {
    fresh.close();
  }
}

// A backup SQLite cannot read (a drive that is gone, a damaged copy) heals nothing, like no backup:
// the recovery alone heals the file, and the log says why the backup was passed over.
function takeRicherSessionsFromBackup(
  fresh: DatabaseType,
  backupDatabase: string,
  writeServiceLog: (line: string) => void,
): number {
  try {
    // Only read: every write below names `main`. The binding is built without URI file names,
    // so a read-only open cannot be asked for here.
    fresh.prepare("ATTACH DATABASE ? AS backup").run(backupDatabase);
  } catch (error) {
    return passOverBackup(error, backupDatabase, writeServiceLog);
  }
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
  } catch (error) {
    return passOverBackup(error, backupDatabase, writeServiceLog);
  } finally {
    fresh.exec("DETACH DATABASE backup");
  }
}

// Rethrows anything but SQLite's own refusal to read the backup.
function passOverBackup(
  error: unknown,
  backupDatabase: string,
  writeServiceLog: (line: string) => void,
): 0 {
  if (!hasSqliteErrorCode(error, "SQLITE_")) {
    throw error;
  }
  const reason = error instanceof Error ? error.message : String(error);
  writeServiceLog(
    `The newest backup ${backupDatabase} could not be read and was passed over: ${reason}`,
  );
  return 0;
}

// A snapshot names the event it reflects, so the session's snapshots go and come with its events.
function takeSessionFromBackup(fresh: DatabaseType, sessionId: string): void {
  fresh.prepare("DELETE FROM main.session_snapshots WHERE session_id = ?").run(sessionId);
  fresh.prepare("DELETE FROM main.session_events WHERE session_id = ?").run(sessionId);
  fresh
    .prepare(
      "INSERT INTO main.session_events SELECT * FROM backup.session_events WHERE session_id = ?",
    )
    .run(sessionId);
  fresh
    .prepare(
      "INSERT INTO main.session_snapshots SELECT * FROM backup.session_snapshots WHERE session_id = ?",
    )
    .run(sessionId);
}

// The tables the schema creates that the file does not hold.
function listMissingSchemaTables(database: DatabaseType): string[] {
  const schema = new Database(":memory:");
  try {
    schema.exec(DAEMON_SCHEMA_SQL);
    const held = new Set(listTables(database));
    return listTables(schema).filter((table) => !held.has(table));
  } finally {
    schema.close();
  }
}

function listTables(database: DatabaseType): string[] {
  return database
    .prepare<[], { name: string }>(
      "SELECT name FROM main.sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all()
    .map((row) => row.name);
}

// The damaged file's log and index go first, so SQLite never replays them into the fresh file;
// both are in the aside copy. The folder is flushed so the rename survives a power loss.
async function replaceDatabaseFile(databasePath: string, freshPath: string): Promise<void> {
  for (const suffix of COMPANION_FILE_SUFFIXES) {
    await rm(`${databasePath}${suffix}`, { force: true });
  }
  await rename(freshPath, databasePath);
  if (process.platform !== "win32") {
    const folder = await open(path.dirname(databasePath), "r");
    try {
      await folder.sync();
    } finally {
      await folder.close();
    }
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
