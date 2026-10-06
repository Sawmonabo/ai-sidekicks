// The data-folder lock: an exclusive SQLite lock on a small file in the data folder, taken at the
// daemon's start and held for its whole life, so a second daemon never opens the same data and the
// command line can tell, without waiting, that a daemon holds it. On macOS and Linux it is an fcntl
// record lock, which no child of the daemon inherits.

import * as path from "node:path";

import Database from "better-sqlite3";

import { hasSqliteErrorCode } from "../session/sqlite-error-code.js";
import { DaemonAlreadyRunningError } from "./already-running-error.js";

const LOCK_FILE_NAME = "daemon.lock";

/** A held data-folder lock. The holder keeps it referenced: a collected handle drops the lock. */
export interface DataFolderLock {
  /** Lets the lock go; the daemon calls it last at its stop. */
  readonly release: () => void;
}

/**
 * Takes the lock on `dataFolder` without waiting. Throws `DaemonAlreadyRunningError` when another
 * daemon holds it.
 */
export function takeDataFolderLock(dataFolder: string): DataFolderLock {
  // A zero busy timeout makes a held lock refuse at once instead of retrying.
  const handle = new Database(path.join(dataFolder, LOCK_FILE_NAME), { timeout: 0 });
  try {
    // In exclusive locking mode the connection keeps the lock its first write transaction takes
    // until it closes.
    handle.pragma("locking_mode = EXCLUSIVE");
    handle.exec("BEGIN EXCLUSIVE; COMMIT;");
  } catch (error) {
    handle.close();
    if (hasSqliteErrorCode(error, "SQLITE_BUSY")) {
      throw new DaemonAlreadyRunningError(`the data folder ${dataFolder}`);
    }
    throw error;
  }
  return {
    release: () => {
      handle.close();
    },
  };
}
