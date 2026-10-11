// The answers an operating system gives a suite that writes owner-only files, so each case runs
// once for each.

import type { OwnerOnlyFileSystem } from "./owner-only-file.js";

/**
 * Each answer this machine can run, named for a case title: the folder flushed after the rename,
 * and left unflushed. Windows cannot flush a folder, so the flushing answer is left out there.
 */
export function folderFlushAnswers(): readonly (readonly [string, OwnerOnlyFileSystem])[] {
  const leftUnflushed = [
    "with the folder left unflushed",
    { flushesFolderAfterRename: false },
  ] as const;
  return process.platform === "win32"
    ? [leftUnflushed]
    : [["with the folder flushed", { flushesFolderAfterRename: true }], leftUnflushed];
}
