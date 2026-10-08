// The newest backup's database copy, where the person keeps backups. Each backup is a folder of
// the backup folder holding its manifest and its database copy side by side; the newest is the
// one whose manifest was taken last. A folder whose manifest does not read is no backup.

import { access, readdir, readFile } from "node:fs/promises";
import * as path from "node:path";

import {
  BACKUP_DATABASE_FILE_NAME,
  BACKUP_MANIFEST_FILE_NAME,
  BackupManifestSchema,
} from "@ai-sidekicks/contracts/daemon/backup";

import { isMissingFileError } from "../../missing-file-error.js";

/**
 * The newest backup's database copy in `backupFolder`, `undefined` when the folder holds none.
 * A folder whose manifest is missing or does not parse is passed over and named in the service
 * log; any other file-system failure rejects.
 */
export async function findNewestBackupDatabase(
  backupFolder: string,
  writeServiceLog: (line: string) => void,
): Promise<string | undefined> {
  let entries;
  try {
    entries = await readdir(backupFolder, { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
  let newest: { readonly takenAt: number; readonly databasePath: string } | undefined;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const backupPath = path.join(backupFolder, entry.name);
    const takenAt = await readTakenAt(backupPath, writeServiceLog);
    const databasePath = path.join(backupPath, BACKUP_DATABASE_FILE_NAME);
    if (takenAt === undefined || (newest !== undefined && takenAt <= newest.takenAt)) {
      continue;
    }
    try {
      await access(databasePath);
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
      writeServiceLog(`The backup ${backupPath} holds no database copy and is passed over`);
      continue;
    }
    newest = { takenAt, databasePath };
  }
  return newest?.databasePath;
}

// When the backup in `backupPath` was taken, by its manifest; `undefined` when it has none that
// reads.
async function readTakenAt(
  backupPath: string,
  writeServiceLog: (line: string) => void,
): Promise<number | undefined> {
  let manifestText: string;
  try {
    manifestText = await readFile(path.join(backupPath, BACKUP_MANIFEST_FILE_NAME), "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(manifestText);
  } catch {
    writeServiceLog(`The backup ${backupPath} has a manifest that is not JSON and is passed over`);
    return undefined;
  }
  const manifest = BackupManifestSchema.safeParse(manifestJson);
  if (!manifest.success) {
    writeServiceLog(
      `The backup ${backupPath} has a manifest that does not parse and is passed over`,
    );
    return undefined;
  }
  return Date.parse(manifest.data.takenAt);
}
