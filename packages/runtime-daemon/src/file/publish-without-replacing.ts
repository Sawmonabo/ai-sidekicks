// Gives a whole file its real name without replacing a file that already has it. The file, written
// under a temporary name beside the target, is hard-linked to the target's name, which refuses a
// name already taken in the same step, and the temporary name is then removed. A volume with no
// hard links (exFAT on macOS answers the link `ENOTSUP`) takes a check that the name is free and a
// rename instead: a file made under the name between the two is the one case that is replaced.

import { link, lstat, rename, unlink } from "node:fs/promises";

/** How a publish ended: the file has the target's name, or another file had it already. */
export type PublishOutcome = "published" | "target_exists";

/** The file-system calls a publish makes; Node's own unless a test swaps one. */
export interface PublishFileSystem {
  link(existingPath: string, newPath: string): Promise<void>;
  lstat(filePath: string): Promise<unknown>;
  rename(fromPath: string, toPath: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
}

const NODE_FILE_SYSTEM: PublishFileSystem = { link, lstat, rename, unlink };

/**
 * Names the whole file at `temporaryPath` `targetPath` and removes `temporaryPath` either way. A
 * file already at `targetPath` is never replaced, but for one made there, on a volume with no hard
 * links, between the name check and the rename. A failure rejects with its error once
 * `temporaryPath` is removed, or with an `AggregateError` of it and the removal's.
 */
export async function publishWithoutReplacing(
  temporaryPath: string,
  targetPath: string,
  fileSystem: PublishFileSystem = NODE_FILE_SYSTEM,
): Promise<PublishOutcome> {
  try {
    await fileSystem.link(temporaryPath, targetPath);
  } catch (linkFailure) {
    const code = errnoOf(linkFailure);
    if (code === "ENOTSUP") {
      return await renameIntoFreeName(temporaryPath, targetPath, fileSystem);
    }
    if (code !== "EEXIST") {
      await removeTemporaryAfter(linkFailure, temporaryPath, fileSystem);
      throw linkFailure;
    }
    await fileSystem.unlink(temporaryPath);
    return "target_exists";
  }
  await fileSystem.unlink(temporaryPath);
  return "published";
}

async function renameIntoFreeName(
  temporaryPath: string,
  targetPath: string,
  fileSystem: PublishFileSystem,
): Promise<PublishOutcome> {
  try {
    if (!(await isNameTaken(targetPath, fileSystem))) {
      await fileSystem.rename(temporaryPath, targetPath);
      return "published";
    }
  } catch (failure) {
    await removeTemporaryAfter(failure, temporaryPath, fileSystem);
    throw failure;
  }
  await fileSystem.unlink(temporaryPath);
  return "target_exists";
}

// Anything under the name takes it, a link included; only its absence leaves it free.
async function isNameTaken(filePath: string, fileSystem: PublishFileSystem): Promise<boolean> {
  try {
    await fileSystem.lstat(filePath);
    return true;
  } catch (error) {
    if (errnoOf(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
}

// Removes the temporary file after `failure`; a removal that fails too is thrown with it.
async function removeTemporaryAfter(
  failure: unknown,
  temporaryPath: string,
  fileSystem: PublishFileSystem,
): Promise<void> {
  try {
    await fileSystem.unlink(temporaryPath);
  } catch (removalFailure) {
    throw new AggregateError(
      [failure, removalFailure],
      "A publish failed, and its temporary file could not be removed",
      { cause: removalFailure },
    );
  }
}

function errnoOf(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}
