// The record of a clean stop: written once the daemon's connections have closed with every write
// committed, and taken at the next start, which then trusts the file enough to write before its
// check answers. SQLite keeps no such flag of its own, and a missing write-ahead log proves
// nothing, so the record holds the file's facts as the stop left them: a start that finds them
// changed, by a restore, a copy or another program, trusts the file no more than after a crash.
// The facts come from `stat` alone, since opening and closing the database file in this process
// would drop the locks SQLite holds on it.

import { readFile, rm, stat } from "node:fs/promises";

import { writeFileAtomically } from "../../file/atomic-write.js";
import { isMissingFileError } from "../../file/missing-error.js";

/**
 * Records that the daemon stopped cleanly, with the database file's facts as it left them. Call
 * only once every connection to the file has closed. Rejects with the file system's error.
 */
export async function recordCleanStop(databasePath: string): Promise<void> {
  await writeFileAtomically(
    cleanStopRecordPath(databasePath),
    await describeDatabaseFile(databasePath),
    0o600,
  );
}

/**
 * Takes the clean-stop record, so a run that ends without a clean stop leaves none, and answers
 * whether the last stop was clean and the file is as it left it.
 */
export async function takeCleanStop(databasePath: string): Promise<boolean> {
  const recordPath = cleanStopRecordPath(databasePath);
  let recordText: string;
  try {
    recordText = await readFile(recordPath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
  // Not flushed: a removal a power loss undoes leaves a record the file's own changes since
  // contradict, and when nothing changed the file is as the clean stop left it.
  await rm(recordPath);
  return recordText === (await describeDatabaseFile(databasePath));
}

// The file's device, inode, size, modification and change times, and its log's size. A missing
// file or log reads as size 0, so a file removed since the stop reads as changed.
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

function cleanStopRecordPath(databasePath: string): string {
  return `${databasePath}.clean-stop`;
}
