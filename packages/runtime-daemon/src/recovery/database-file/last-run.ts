// The record of how the daemon's last run on the database file ended, kept beside the file. A start
// writes that it runs in this boot of the system; a clean stop, once every connection has closed,
// replaces that with the file's facts as it left them. A process that ends any other way within
// one boot cannot damage the file, since SQLite keeps every committed transaction across a crash
// of the program; a crash of the system or a power loss can, on storage that does not write in the
// order it was asked, so a start that finds another boot's record, or a clean stop's facts the
// file no longer matches, cannot vouch for the file. SQLite keeps no such flag of its own, and a
// missing write-ahead log proves nothing. The facts come from `stat` alone, since opening and
// closing the database file in this process would drop the locks SQLite holds on it.

import { readFile, stat } from "node:fs/promises";

import { writeFileAtomically } from "../../file/atomic-write.js";
import { isMissingFileError } from "../../file/missing-error.js";

/**
 * How the last run on the database file ended, as its record tells: `new-file` when there is no
 * file yet, `clean` after a clean stop that left the file as it is, `process-ended` when the run
 * ended without one within the system's current boot, and `unknown` otherwise.
 */
export type LastRunEnd = "new-file" | "clean" | "process-ended" | "unknown";

const RUNNING_PREFIX = "running ";
const CLEAN_PREFIX = "clean ";

/**
 * Reads how the last run on the file ended, as the system's boot `bootId` sees it. Rejects with
 * the file system's error.
 */
export async function readLastRunEnd(databasePath: string, bootId: string): Promise<LastRunEnd> {
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
  return recordText === `${RUNNING_PREFIX}${bootId}` ? "process-ended" : "unknown";
}

/**
 * Records that a run on the file has started in the system's boot `bootId`, replacing the last
 * run's record. Rejects with the file system's error.
 */
export async function recordRunStart(databasePath: string, bootId: string): Promise<void> {
  await writeFileAtomically(lastRunRecordPath(databasePath), `${RUNNING_PREFIX}${bootId}`, 0o600);
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
