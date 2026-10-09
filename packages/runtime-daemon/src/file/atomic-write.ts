// Replaces a file so that a crash at any moment leaves the old contents or the new, never half of
// either and never neither: a temporary file beside it is written and flushed to disk, renamed
// over it, and then the folder itself is flushed, since until then the rename lives only in
// memory and a power loss can undo it.

import { randomBytes } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { withCleanupFailures } from "../cleanup-failures.js";
import { CAN_FLUSH_FOLDER, flushPath, useThenClose, type FlushOpenFlags } from "../disk-flush.js";

/** An open file, as much of Node's `FileHandle` as the write uses. */
interface AtomicWriteFileHandle {
  writeFile(text: string, encoding: "utf8"): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/** The file-system calls the write makes; Node's own unless a test records them. */
export interface AtomicWriteFileSystem {
  open(
    filePath: string,
    flags: "wx" | FlushOpenFlags,
    mode?: number,
  ): Promise<AtomicWriteFileHandle>;
  rename(fromPath: string, toPath: string): Promise<void>;
  rm(filePath: string, options: { force: true }): Promise<void>;
}

const NODE_FILE_SYSTEM: AtomicWriteFileSystem = { open, rename, rm };

/**
 * Replaces `filePath` with `text`, created with `mode`, durably and all at once. The folder must
 * exist; a failure before the rename removes the temporary file and leaves the old one in place.
 * Rejects with the file system's error, a failed cleanup after it attached to its `cause`.
 */
export async function writeFileAtomically(
  filePath: string,
  text: string,
  mode: number,
  fileSystem: AtomicWriteFileSystem = NODE_FILE_SYSTEM,
): Promise<void> {
  const temporaryPath = `${filePath}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const file = await fileSystem.open(temporaryPath, "wx", mode);
    await useThenClose(
      file,
      async () => {
        await file.writeFile(text, "utf8");
        await file.sync();
      },
      "writing the file",
    );
    await fileSystem.rename(temporaryPath, filePath);
  } catch (error) {
    const cleanupFailures: unknown[] = [];
    await fileSystem
      .rm(temporaryPath, { force: true })
      .catch((cleanupFailure: unknown) => cleanupFailures.push(cleanupFailure));
    throw withCleanupFailures(error, cleanupFailures, "writing the file");
  }
  await syncFolder(dirname(filePath), fileSystem);
}

/**
 * Flushes `folderPath`'s entries to disk, so a rename or removal in it survives a power loss. On
 * Windows it does nothing: there is no flush for a folder, and a rename is on disk when it returns.
 */
export async function syncFolder(
  folderPath: string,
  fileSystem: AtomicWriteFileSystem = NODE_FILE_SYSTEM,
): Promise<void> {
  if (CAN_FLUSH_FOLDER) {
    await flushPath(folderPath, (folder, flags) => fileSystem.open(folder, flags));
  }
}
