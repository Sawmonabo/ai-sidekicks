// The database file's repair at a start, before anything opens it for writing, of the damage a
// run recorded beside it: the damaged file is copied aside untouched with its write-ahead log, its
// rows are recovered into a fresh file with SQLite's own recovery, and where the person keeps a
// backup that reads, each session whose events the newest backup holds more of takes them from it.
// While the recovery runs, the repair reports how many of the damaged file's session events it has
// recovered. The fresh file must hold every table, index, trigger and view of the schema and pass
// the full integrity check, on a thread of its own, before it replaces the damaged one; every
// session's projections are then rebuilt from its events, and the search index, built from the
// damaged file's rows, is dropped to be built again from the fresh file's. A marker written once
// the fresh file is ready lets a start that a crash cut short finish the replacement rather than
// recover again from a file whose log is gone.

import { constants } from "node:fs";
import { access, copyFile, open, rename, rm } from "node:fs/promises";
import * as path from "node:path";

import type { DaemonRepairProgress } from "@ai-sidekicks/contracts/daemon/recovery";

import { syncFolder, writeFileAtomically } from "../../file/atomic-write.js";
import { isMissingFileError } from "../../file/missing-error.js";
import { copyDatabaseFilesAside, DATABASE_COMPANION_FILE_SUFFIXES } from "./aside-copy.js";
import { readDatabaseDamage, removeDatabaseDamage } from "./damage.js";
import { prepareFreshFile } from "./fresh-file/preparation.js";
import { recordCleanStop } from "./last-run.js";
import { findNewestBackupDatabase } from "./newest-backup.js";
import { countDamagedFileEvents, recoverIntoFreshFile } from "./sqlite-shell.js";

/** What the repair reads and where it writes. */
export interface DatabaseFileRepairOptions {
  readonly databasePath: string;
  readonly dataFolder: string;
  /** The search index's folder, built from the database's rows; a replaced file drops it. */
  readonly indexFolderPath: string;
  /** The folder the person's backups go to; read only when the file is damaged. */
  readonly readBackupFolder: () => Promise<string>;
  /**
   * Runs the repair of a damaged file, which can take minutes, and returns what it returns; the
   * repair reports how far it has come, or `undefined` while the step it is on gives no count.
   */
  readonly whileRepairing: <T>(
    repair: (reportProgress: (progress: DaemonRepairProgress | undefined) => void) => Promise<T>,
  ) => Promise<T>;
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
  const { freshPath, readyMarkerPath } = freshFilePaths(databasePath);
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
  return options.whileRepairing((reportProgress) =>
    repairDamagedFile(options, damage, reportProgress),
  );
}

// Copies the damaged file aside, recovers it into a fresh file and puts that in its place.
async function repairDamagedFile(
  options: DatabaseFileRepairOptions,
  damage: string,
  reportProgress: (progress: DaemonRepairProgress | undefined) => void,
): Promise<DatabaseFileRepair> {
  const { databasePath } = options;
  const { freshPath, readyMarkerPath } = freshFilePaths(databasePath);
  options.writeServiceLog(`The database file is damaged: ${damage}`);
  const asideFolder = await copyDatabaseFilesAside(options);
  options.writeServiceLog(`The damaged database's files are copied aside in ${asideFolder}`);
  await rm(freshPath, { force: true });
  try {
    await recoverCountingEvents(options, freshPath, reportProgress);
    reportProgress(undefined);
    const sessionsFromBackup = await prepareWithNewestBackup(options, freshPath);
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

// The fresh file a repair recovers into, and the marker that says it is ready to replace the file.
function freshFilePaths(databasePath: string): { freshPath: string; readyMarkerPath: string } {
  const freshPath = `${databasePath}.recovered`;
  return { freshPath, readyMarkerPath: `${freshPath}-ready` };
}

// Recovers the damaged file into the fresh one, reporting how many of the damaged file's events
// are recovered once the file's own count of them is read. A count that cannot be read leaves the
// repair without one, and the log says why.
async function recoverCountingEvents(
  options: DatabaseFileRepairOptions,
  freshPath: string,
  reportProgress: (progress: DaemonRepairProgress) => void,
): Promise<void> {
  let total: number | undefined;
  let done = 0;
  const report = (): void => {
    if (total !== undefined) {
      reportProgress({ done: Math.min(done, total), total });
    }
  };
  const counting = countDamagedFileEvents(options.databasePath).then(
    (count) => {
      total = count;
      report();
    },
    (error: unknown) => {
      options.writeServiceLog(
        "The repair gives no count of its progress, as the damaged file's events could not be " +
          `counted: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  );
  try {
    await recoverIntoFreshFile(options.databasePath, freshPath, (recoveredEvents) => {
      done = recoveredEvents;
      report();
    });
  } finally {
    await counting;
  }
}

// Readies the fresh file with the newest backup's database, read from a copy in the data folder so
// nothing is written beside the person's backups, and returns how many sessions took their events
// from it. A backup that cannot be found or copied heals nothing, like no backup: the recovery
// alone heals the file, and the log says why the backup was passed over.
async function prepareWithNewestBackup(
  options: DatabaseFileRepairOptions,
  freshPath: string,
): Promise<number> {
  const backupCopyPath = `${options.databasePath}.backup-read`;
  let isBackupCopied = false;
  try {
    const backupDatabase = await findNewestBackupDatabase(
      await options.readBackupFolder(),
      options.writeServiceLog,
    );
    if (backupDatabase !== undefined) {
      // A clone where the file system offers one, so a large backup takes no time or space.
      await copyFile(backupDatabase, backupCopyPath, constants.COPYFILE_FICLONE);
      isBackupCopied = true;
    }
  } catch (error) {
    options.writeServiceLog(
      "The newest backup could not be read and was passed over: " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  try {
    return await prepareFreshFile(
      { freshPath, backupCopyPath: isBackupCopied ? backupCopyPath : undefined },
      options.writeServiceLog,
    );
  } finally {
    for (const suffix of ["", ...DATABASE_COMPANION_FILE_SUFFIXES]) {
      await rm(`${backupCopyPath}${suffix}`, { force: true });
    }
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
// power loss, and the file, checked whole, is recorded as a clean stop leaves one, so the start
// takes writes at once; the damage record then goes, and the marker last.
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
  await recordCleanStop(databasePath);
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
