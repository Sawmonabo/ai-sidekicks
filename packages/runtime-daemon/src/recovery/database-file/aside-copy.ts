// The store's files copied aside, untouched, before anything repairs them: the database, its
// write-ahead log and its shared-memory index, each as it stands, into a folder of its own under
// the data folder, as a clone where the file system can make one, and flushed to disk before
// anything removes the files it copies. Nothing the repair does ever deletes a copy. Each copy's
// folder keeps a record of the files' sizes and times as they were copied and of the damaged
// sessions healed after it, so a start that meets the same damage again finds that copy rather
// than making another. A stop ends a copy at once and removes what it had copied.

import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import * as path from "node:path";

import { z } from "zod";

import { withCleanupFailures } from "../../cleanup-failures.js";
import { flushPath } from "../../disk-flush.js";
import { syncFolder, writeFileAtomically } from "../../file/atomic-write.js";
import { isMissingFileError } from "../../file/missing-error.js";
import { pathExists } from "../../git/filesystem.js";
import type { DatabaseFileOperatingSystem } from "./operating-system.js";

/** The two files SQLite keeps beside a database in write-ahead-log mode. */
export const DATABASE_COMPANION_FILE_SUFFIXES = ["-wal", "-shm"] as const;

// The folder inside the data folder that holds each copy, one folder per copy.
const ASIDE_FOLDER_NAME = "damaged";

// The record beside each copy's files.
const RECORD_FILE_NAME = "copy.json";

const StoredFileSchema = z
  .object({ name: z.string(), size: z.number(), modifiedAtMs: z.number() })
  .strict();
type StoredFile = z.infer<typeof StoredFileSchema>;

const AsideCopyRecordSchema = z
  .object({
    files: z.array(StoredFileSchema),
    sessions: z.array(z.object({ sessionId: z.string(), headSequence: z.number() }).strict()),
  })
  .strict();
type AsideCopyRecord = z.infer<typeof AsideCopyRecordSchema>;

/**
 * Where the store's files are, where copies go, the clock that names a copy's folder, and the
 * system's copy.
 */
export interface DatabaseFilesAsideOptions {
  readonly databasePath: string;
  readonly dataFolder: string;
  readonly operatingSystem: Pick<DatabaseFileOperatingSystem, "copyFile">;
  readonly now: () => Date;
  readonly writeServiceLog: (line: string) => void;
}

/**
 * Returns the folder of a copy of the database and its companion files as they stand now: an
 * earlier copy whose record matches them, or a new one, readable by the person alone and on disk.
 * Throws the file system's error, and the abort's when `stopSignal` ends the copy, with the new
 * folder removed; a copy never overwrites another.
 */
export async function copyDatabaseFilesAside(
  options: DatabaseFilesAsideOptions,
  stopSignal: AbortSignal,
): Promise<string> {
  const files = await describeDatabaseFiles(options.databasePath);
  for (const copy of await readAsideCopies(options)) {
    if (isSameFiles(copy.record.files, files)) {
      return copy.folder;
    }
  }
  const asideRoot = path.join(options.dataFolder, ASIDE_FOLDER_NAME);
  await mkdir(asideRoot, { recursive: true, mode: 0o700 });
  // A colon is no part of a Windows file name; the random tail keeps two copies apart.
  const folder = await mkdtemp(
    path.join(asideRoot, `${options.now().toISOString().replaceAll(":", "-")}-`),
  );
  try {
    await copyFilesInto(folder, files, options, stopSignal);
  } catch (error) {
    const cleanupFailures: unknown[] = [];
    await rm(folder, { recursive: true, force: true }).catch((removeFailure: unknown) =>
      cleanupFailures.push(removeFailure),
    );
    throw withCleanupFailures(error, cleanupFailures, "Copying the store's files aside");
  }
  // The new folder's own entry, so the copy is found after a power loss.
  await syncFolder(asideRoot);
  return folder;
}

// A clone keeps the bytes as they were when the file is replaced, at no cost in time or space. The
// log goes when the last connection closes, folded into the file first, so the companions are
// copied before the file: a log gone by its copy is in the file copied after it. Each copy is
// flushed before the record names it.
async function copyFilesInto(
  folder: string,
  files: readonly StoredFile[],
  options: DatabaseFilesAsideOptions,
  stopSignal: AbortSignal,
): Promise<void> {
  const copied: StoredFile[] = [];
  for (const file of files.toReversed()) {
    const copyPath = path.join(folder, file.name);
    try {
      await options.operatingSystem.copyFile(
        path.join(path.dirname(options.databasePath), file.name),
        copyPath,
        stopSignal,
      );
    } catch (error) {
      if (stopSignal.aborted) {
        throw error;
      }
      // A companion the last close removed since the listing is passed over.
      if (
        file.name === path.basename(options.databasePath) ||
        (await pathExists(path.join(path.dirname(options.databasePath), file.name)))
      ) {
        throw error;
      }
      continue;
    }
    await flushPath(copyPath);
    copied.push(file);
  }
  await writeRecord(folder, { files: copied, sessions: [] });
}

/**
 * The folder of a copy taken while the session was damaged with its head at `headSequence`, so
 * the same damage needs no second copy; `undefined` when there is none.
 */
export async function findAsideCopyOfSession(
  options: Pick<DatabaseFilesAsideOptions, "dataFolder" | "writeServiceLog">,
  sessionId: string,
  headSequence: number,
): Promise<string | undefined> {
  for (const copy of await readAsideCopies(options)) {
    if (
      copy.record.sessions.some(
        (session) => session.sessionId === sessionId && session.headSequence === headSequence,
      )
    ) {
      return copy.folder;
    }
  }
  return undefined;
}

/** Records in the copy at `folder` that it holds the session damaged with its head there. */
export async function recordSessionInAsideCopy(
  folder: string,
  sessionId: string,
  headSequence: number,
): Promise<void> {
  const record = AsideCopyRecordSchema.parse(
    JSON.parse(await readFile(path.join(folder, RECORD_FILE_NAME), "utf8")),
  );
  await writeRecord(folder, {
    ...record,
    sessions: [...record.sessions, { sessionId, headSequence }],
  });
}

// The database and the companion files that exist, with their sizes and times.
async function describeDatabaseFiles(databasePath: string): Promise<StoredFile[]> {
  const databaseName = path.basename(databasePath);
  const files: StoredFile[] = [];
  for (const name of [
    databaseName,
    ...DATABASE_COMPANION_FILE_SUFFIXES.map((suffix) => `${databaseName}${suffix}`),
  ]) {
    try {
      const stats = await stat(path.join(path.dirname(databasePath), name));
      files.push({ name, size: stats.size, modifiedAtMs: stats.mtimeMs });
    } catch (error) {
      // A database closed cleanly keeps no log beside it.
      if (name === databaseName || !isMissingFileError(error)) {
        throw error;
      }
    }
  }
  return files;
}

function isSameFiles(recorded: readonly StoredFile[], current: readonly StoredFile[]): boolean {
  return (
    recorded.length === current.length &&
    current.every((file) =>
      recorded.some(
        (copied) =>
          copied.name === file.name &&
          copied.size === file.size &&
          copied.modifiedAtMs === file.modifiedAtMs,
      ),
    )
  );
}

// Every earlier copy with a record that reads; one whose record does not is named in the log and
// never reused.
async function readAsideCopies(
  options: Pick<DatabaseFilesAsideOptions, "dataFolder" | "writeServiceLog">,
): Promise<{ folder: string; record: AsideCopyRecord }[]> {
  const asideRoot = path.join(options.dataFolder, ASIDE_FOLDER_NAME);
  let entries;
  try {
    entries = await readdir(asideRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  }
  const copies: { folder: string; record: AsideCopyRecord }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const folder = path.join(asideRoot, entry.name);
    try {
      const record = AsideCopyRecordSchema.parse(
        JSON.parse(await readFile(path.join(folder, RECORD_FILE_NAME), "utf8")),
      );
      copies.push({ folder, record });
    } catch (error) {
      options.writeServiceLog(
        `The copy aside in ${folder} has no record that reads and is not reused: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
  return copies;
}

async function writeRecord(folder: string, record: AsideCopyRecord): Promise<void> {
  await writeFileAtomically(path.join(folder, RECORD_FILE_NAME), JSON.stringify(record), 0o600);
}
