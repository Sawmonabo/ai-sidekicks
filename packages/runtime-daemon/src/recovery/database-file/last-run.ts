// The record of how the daemon's last run on the database file ended, kept beside the file. A start
// writes that it runs; a clean stop, once every connection has closed, replaces that with the
// file's facts as it left them. A run that ends any other way leaves the file sound: SQLite keeps
// every committed transaction across a crash of the program, and in WAL mode a crash of the
// machine or a power loss can damage the file only through a checkpoint whose syncs the storage
// did not honor, which the writer's checkpoints rule out by flushing the drive. A file whose facts
// no longer match a clean stop's, or with no record, was changed by something else, so a start
// cannot vouch for it. SQLite keeps no such flag of its own, and a missing write-ahead log proves
// nothing. The facts come from `stat` alone, since opening and closing the database file in this
// process would drop the locks SQLite holds on it.

import { readFile, stat } from "node:fs/promises";

import { writeFileAtomically } from "../../file/atomic-write.js";
import { isMissingFileError } from "../../file/missing-error.js";

/**
 * How the last run on the database file ended, as its record tells: `new-file` when there is no
 * file yet, `clean` after a clean stop that left the file as it is, `unclean` when the run ended
 * without one, and `unknown` when there is no record or the file changed since a clean stop.
 */
export type LastRunEnd = "new-file" | "clean" | "unclean" | "unknown";

const RUNNING_RECORD = "running";
const CLEAN_PREFIX = "clean ";

/** Reads how the last run on the file ended. Rejects with the file system's error. */
export async function readLastRunEnd(databasePath: string): Promise<LastRunEnd> {
  if ((await statOrMissing(databasePath)) === undefined) {
    return "new-file";
  }
  let recordText: string;
  try {
    recordText = await readFile(lastRunRecordPath(databasePath), "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return "unknown";
    }
    throw error;
  }
  if (recordText === `${CLEAN_PREFIX}${await describeDatabaseFile(databasePath)}`) {
    return "clean";
  }
  return recordText === RUNNING_RECORD ? "unclean" : "unknown";
}

/**
 * Records that a run on the file has started, replacing the last run's record. Rejects with the
 * file system's error.
 */
export async function recordRunStart(databasePath: string): Promise<void> {
  await writeFileAtomically(lastRunRecordPath(databasePath), RUNNING_RECORD, 0o600);
}

/**
 * Records that the run stopped cleanly, with the database file's facts as it left them. Call only
 * once every connection to the file has closed. Rejects with the file system's error.
 */
export async function recordCleanStop(databasePath: string): Promise<void> {
  await writeFileAtomically(
    lastRunRecordPath(databasePath),
    `${CLEAN_PREFIX}${await describeDatabaseFile(databasePath)}`,
    0o600,
  );
}

// The file's device, inode, size, modification and change times, and its log's size. A missing
// log reads as size 0.
async function describeDatabaseFile(databasePath: string): Promise<string> {
  const file = await statOrMissing(databasePath);
  const log = await statOrMissing(`${databasePath}-wal`);
  return [
    file?.dev ?? 0,
    file?.ino ?? 0,
    file?.size ?? 0,
    file?.mtimeMs ?? 0,
    file?.ctimeMs ?? 0,
    log?.size ?? 0,
  ].join(" ");
}

async function statOrMissing(filePath: string) {
  try {
    return await stat(filePath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
}

function lastRunRecordPath(databasePath: string): string {
  return `${databasePath}.last-run`;
}
