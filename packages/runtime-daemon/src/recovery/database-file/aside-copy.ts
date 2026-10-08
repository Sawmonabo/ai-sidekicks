// The store's files copied aside, untouched, before anything repairs them: the database, its
// write-ahead log and its shared-memory index, each as it stands, into a folder of its own under
// the data folder. Nothing the repair does ever deletes the copy.

import { constants } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import * as path from "node:path";

/** The folder inside the data folder that holds each copy, one folder per copy. */
const ASIDE_FOLDER_NAME = "damaged";

// The two files SQLite keeps beside a database in write-ahead-log mode.
const COMPANION_FILE_SUFFIXES = ["-wal", "-shm"] as const;

/** Where the copy goes and the clock that names its folder. */
export interface DatabaseFilesAsideOptions {
  readonly databasePath: string;
  readonly dataFolder: string;
  readonly now: () => Date;
}

/**
 * Copies the database and the companion files that exist into a new folder named for the moment,
 * readable by the person alone, and returns the folder. Throws the file system's error; a copy
 * never overwrites an earlier one.
 */
export async function copyDatabaseFilesAside(options: DatabaseFilesAsideOptions): Promise<string> {
  // A colon is no part of a Windows file name.
  const folderName = options.now().toISOString().replaceAll(":", "-");
  const folder = path.join(options.dataFolder, ASIDE_FOLDER_NAME, folderName);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const fileName = path.basename(options.databasePath);
  await copyFile(options.databasePath, path.join(folder, fileName), constants.COPYFILE_EXCL);
  for (const suffix of COMPANION_FILE_SUFFIXES) {
    try {
      await copyFile(
        `${options.databasePath}${suffix}`,
        path.join(folder, `${fileName}${suffix}`),
        constants.COPYFILE_EXCL,
      );
    } catch (error) {
      // A database closed cleanly keeps no log beside it.
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  }
  return folder;
}
