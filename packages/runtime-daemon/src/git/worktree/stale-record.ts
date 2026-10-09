// Git's record of a kept tree, which a crash or a failed removal can leave behind in the
// repository. It is found again by the folder git named at the discard, and removed only while it
// is still the kept copy's own. It is renamed aside first and judged again, so a record a put-back
// or a live tree took under that name since goes back, never away, and a removal a crash cut short
// is finished at the record's next look. A record goes back under its name only while that name is
// free. When another record has taken it for the same tree, the one aside is a duplicate git would
// still list, holding its branch, so it is removed; one for another tree stays there, and the
// service log says so.

import { mkdir, rmdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { withCleanupFailures } from "../../cleanup-failures.js";
import type { ServiceLogWriter } from "../../daemon/service-log.js";
import { mintUuidV7 } from "../../uuid-v7.js";
import { canonicalFolderPath } from "../../workspace/folder/canonical-path.js";
import {
  pathExists,
  readFolderNamesOptional,
  readOptional,
  type GitFilesystem,
} from "../filesystem.js";
import type { KeptCopyClaims } from "./claims.js";
import { LEFTOVER_ID_PATTERN } from "./kept-copy.js";
import { readRecordNamedBy } from "./reads.js";

/** The seams a stale record's removal runs through, and what live trees and put-backs hold. */
interface StaleRecordTools {
  readonly filesystem: Pick<GitFilesystem, "rename" | "removePath">;
  readonly writeServiceLog: ServiceLogWriter;
  readonly claims: KeptCopyClaims;
}

// A stale record is renamed beside itself, its name with `.removing-<its own id>` added, before it
// is judged again and removed, so a removal cut short leaves a folder the next look finishes.
const RECORD_REMOVAL_INFIX = ".removing-";
const RECORD_REMOVAL_ID_PATTERN = new RegExp(`^${LEFTOVER_ID_PATTERN}$`);

// The record removals this process is making now, so no look takes one for a crash's leftover.
const recordRemovalsInProgress = new Set<string>();

/**
 * Removes `recordFolder`, git's record of the kept tree as named at the discard, only while it is
 * the copy's own: it names `<originalPath>/.git`, where no live row or `.git` claims it, and no
 * put-back is making it, so another tree's record is never reached. Answers whether it is gone.
 */
export async function removeStaleTreeRecord(
  tools: StaleRecordTools,
  recordFolder: string,
  originalPath: string,
): Promise<boolean> {
  await finishRecordRemovalsCutShort(tools, recordFolder);
  const judgedGitdir = await readOwnStaleRecordGitdir(tools.claims, recordFolder, originalPath);
  if (judgedGitdir === null) {
    return false;
  }
  const removingFolder = `${recordFolder}${RECORD_REMOVAL_INFIX}${mintUuidV7()}`;
  recordRemovalsInProgress.add(removingFolder);
  try {
    try {
      await tools.filesystem.rename(recordFolder, removingFolder);
    } catch (renameFailure) {
      // Another removal of the same record took it first.
      if ((renameFailure as NodeJS.ErrnoException).code === "ENOENT") {
        return true;
      }
      throw renameFailure;
    }
    // Judged again once renamed: a record a put-back or a live tree took since goes back.
    const isClaimedSince =
      (await readRecordGitdir(removingFolder)) !== judgedGitdir ||
      tools.claims.isLiveTreeAt(originalPath) ||
      (await isRecordBeingRestored(tools.claims, recordFolder));
    if (isClaimedSince) {
      await putRecordBack(tools, removingFolder, recordFolder);
      return false;
    }
    await tools.filesystem.removePath(removingFolder);
    return true;
  } finally {
    recordRemovalsInProgress.delete(removingFolder);
  }
}

// The record's `gitdir` when the record is the kept copy's own and stale, as
// `removeStaleTreeRecord` describes; `null` otherwise.
async function readOwnStaleRecordGitdir(
  claims: KeptCopyClaims,
  recordFolder: string,
  originalPath: string,
): Promise<string | null> {
  const gitdir = await readRecordGitdir(recordFolder);
  if (gitdir === undefined || gitdir.length === 0) {
    return null;
  }
  // A relative link names the tree's `.git` from the record folder.
  const gitFile = resolve(recordFolder, gitdir);
  if (basename(gitFile) !== ".git" || claims.isLiveTreeAt(originalPath)) {
    return null;
  }
  const [namedTreeKey, ownTreeKey, isRestoring] = await Promise.all([
    canonicalFolderPath(dirname(gitFile)),
    canonicalFolderPath(originalPath),
    isRecordBeingRestored(claims, recordFolder),
  ]);
  if (namedTreeKey !== ownTreeKey || isRestoring) {
    return null;
  }
  return (await isRecordNamedBy(gitFile, recordFolder)) ? null : gitdir;
}

// Whether a put-back's mark names the record, which that put-back is making.
async function isRecordBeingRestored(
  claims: KeptCopyClaims,
  recordFolder: string,
): Promise<boolean> {
  const [recordKey, ...restoringKeys] = await Promise.all([
    canonicalFolderPath(recordFolder),
    ...claims.listRestoringRecords().map(canonicalFolderPath),
  ]);
  return restoringKeys.includes(recordKey);
}

// Finishes each removal of the record at `recordFolder` a crash cut short, left under the record's
// name with `.removing-<id>` added: one whose tree's `.git` names the record goes back under the
// record's name, since that tree lives on it, and any other is removed.
async function finishRecordRemovalsCutShort(
  tools: StaleRecordTools,
  recordFolder: string,
): Promise<void> {
  const recordsFolder = dirname(recordFolder);
  const leftoverPrefix = `${basename(recordFolder)}${RECORD_REMOVAL_INFIX}`;
  const leftovers = (await readFolderNamesOptional(recordsFolder))
    .filter(
      (name) =>
        name.startsWith(leftoverPrefix) &&
        RECORD_REMOVAL_ID_PATTERN.test(name.slice(leftoverPrefix.length)),
    )
    .map((name) => join(recordsFolder, name))
    .filter((leftover) => !recordRemovalsInProgress.has(leftover));
  for (const leftover of leftovers) {
    const gitFile = await readRecordGitFile(leftover);
    const isTreeLive = gitFile !== undefined && (await isRecordNamedBy(gitFile, recordFolder));
    if (isTreeLive) {
      await putRecordBack(tools, leftover, recordFolder);
    } else {
      await tools.filesystem.removePath(leftover);
    }
  }
}

// Puts a record set aside back under its name while the name is free. A name another record has
// taken is left to it, since the live tree reads that one: the record aside is removed when the
// taken one names the same `.git`, and otherwise stays where it is.
async function putRecordBack(
  tools: StaleRecordTools,
  asideFolder: string,
  recordFolder: string,
): Promise<void> {
  if (await takeRecordName(tools, asideFolder, recordFolder)) {
    return;
  }
  const [asideGitFile, takenGitFile] = await Promise.all([
    readRecordGitFile(asideFolder),
    readRecordGitFile(recordFolder),
  ]);
  if (await isSameGitFile(asideGitFile, takenGitFile)) {
    await tools.filesystem.removePath(asideFolder);
    return;
  }
  tools.writeServiceLog(
    `git's record ${recordFolder} was taken again while an earlier copy of it was set ` +
      `aside, so that copy is left at ${asideFolder}`,
  );
}

// Moves the record set aside to `recordFolder` while that name is free, answering whether it did.
// Off Windows the name is taken by `mkdir` first, so a put-back's `mkdir` of it fails and takes the
// next number, and the rename then replaces that empty folder; Windows refuses to rename a folder
// onto one that exists, so there the rename alone takes the name.
async function takeRecordName(
  tools: StaleRecordTools,
  asideFolder: string,
  recordFolder: string,
): Promise<boolean> {
  if (process.platform === "win32") {
    try {
      await tools.filesystem.rename(asideFolder, recordFolder);
      return true;
    } catch (renameFailure) {
      if (await pathExists(recordFolder)) {
        return false;
      }
      throw renameFailure;
    }
  }
  try {
    await mkdir(recordFolder);
  } catch (mkdirFailure) {
    if ((mkdirFailure as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw mkdirFailure;
  }
  try {
    await tools.filesystem.rename(asideFolder, recordFolder);
  } catch (renameFailure) {
    const cleanupFailures: unknown[] = [];
    await rmdir(recordFolder).catch((rmdirFailure: unknown) => cleanupFailures.push(rmdirFailure));
    throw withCleanupFailures(renameFailure, cleanupFailures, "putting git's record back");
  }
  return true;
}

async function readRecordGitdir(recordFolder: string): Promise<string | undefined> {
  return (await readOptional(join(recordFolder, "gitdir")))?.trim();
}

// The `.git` a record's `gitdir` names, resolved from the record folder; `undefined` for none.
async function readRecordGitFile(recordFolder: string): Promise<string | undefined> {
  const gitdir = await readRecordGitdir(recordFolder);
  return gitdir === undefined || gitdir.length === 0 ? undefined : resolve(recordFolder, gitdir);
}

async function isSameGitFile(
  first: string | undefined,
  second: string | undefined,
): Promise<boolean> {
  if (first === undefined || second === undefined || basename(first) !== basename(second)) {
    return false;
  }
  const [firstKey, secondKey] = await Promise.all([
    canonicalFolderPath(dirname(first)),
    canonicalFolderPath(dirname(second)),
  ]);
  return firstKey === secondKey;
}

// Whether the `.git` at `gitFile` names `recordFolder`.
async function isRecordNamedBy(gitFile: string, recordFolder: string): Promise<boolean> {
  const namedRecord = await readRecordNamedBy(gitFile);
  if (namedRecord === undefined) {
    return false;
  }
  const [namedKey, ownKey] = await Promise.all([
    canonicalFolderPath(namedRecord),
    canonicalFolderPath(recordFolder),
  ]);
  return namedKey === ownKey;
}
