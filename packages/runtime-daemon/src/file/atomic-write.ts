// Replaces a file so that a crash at any moment leaves the old contents or the new, never half of
// either and never neither: a temporary file beside it is written and flushed to disk, renamed
// over it, and then the folder itself is flushed, since until then the rename lives only in
// memory and a power loss can undo it. Windows has no flush for a folder; its rename is already on
// disk when it returns.

import { randomBytes } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

/** An open file, as much of Node's `FileHandle` as the write uses. */
interface AtomicWriteFileHandle {
  writeFile(text: string, encoding: "utf8"): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/** The file-system calls the write makes; Node's own unless a test records them. */
export interface AtomicWriteFileSystem {
  open(filePath: string, flags: "wx" | "r", mode?: number): Promise<AtomicWriteFileHandle>;
  rename(fromPath: string, toPath: string): Promise<void>;
  rm(filePath: string, options: { force: true }): Promise<void>;
}

const NODE_FILE_SYSTEM: AtomicWriteFileSystem = { open, rename, rm };

/**
 * Replaces `filePath` with `text`, created with `mode`, durably and all at once. The folder must
 * exist; a failure before the rename removes the temporary file and leaves the old one in place.
 * Rejects with the file system's error, or with an `AggregateError` holding it first and the
 * failure of the cleanup after it.
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
    await useThenClose(file, async () => {
      await file.writeFile(text, "utf8");
      await file.sync();
    });
    await fileSystem.rename(temporaryPath, filePath);
  } catch (error) {
    try {
      await fileSystem.rm(temporaryPath, { force: true });
    } catch (cleanupFailure) {
      throw withCleanupFailure(error, cleanupFailure);
    }
    throw error;
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
  if (process.platform === "win32") {
    return;
  }
  const folder = await fileSystem.open(folderPath, "r");
  await useThenClose(folder, () => folder.sync());
}

// Closes the file after `use`, whose failure stays the one a caller reads first.
async function useThenClose(file: AtomicWriteFileHandle, use: () => Promise<void>): Promise<void> {
  try {
    await use();
  } catch (error) {
    try {
      await file.close();
    } catch (cleanupFailure) {
      throw withCleanupFailure(error, cleanupFailure);
    }
    throw error;
  }
  await file.close();
}

function withCleanupFailure(failure: unknown, cleanupFailure: unknown): AggregateError {
  return new AggregateError(
    [failure, cleanupFailure],
    "The file was not written, and cleaning up after it failed too.",
    { cause: failure },
  );
}
