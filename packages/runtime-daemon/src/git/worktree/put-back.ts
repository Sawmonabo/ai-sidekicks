// Putting a kept copy back where its tree lived, and undoing a put-back. A put-back across volumes
// copies the tree and leaves the kept copy whole until the caller has recorded the tree.
//
// A put-back takes its folder's name by making that folder empty, and git's record under a free
// name, then has the caller write down what it is doing, so one a crash cut short is undone from
// that mark. A new branch is made next, git refusing a name another branch took; a folder or branch
// name taken this way is the caller's to retry with the next number. Its steps then run side by
// side: the tree by
// one rename (across volumes a copy), then the target's `.git` file; the record copied, cloned
// where the volume can, then its location files written afresh and, on a new branch, its HEAD put
// on that branch through git, since a reftable repository keeps it in the record's ref table; the
// pack and the LFS objects back into the repository; and the new branch made. Every step settles
// before an undo starts, and after a copy the index is refreshed. Then everything the put-back
// wrote, and the folders that name it, is flushed to disk, the new branch first, so the kept copy,
// the only other copy, is deleted after the answer only once all of it would survive a power loss.
//
// The tree takes its own branch while it still points at the recorded commit (in a rebase, the
// recorded `orig-head`) and no tree git lists has it checked out, and a new numbered
// `<branch>-restored` otherwise. One git read takes the pins and the branch, beside the removal of
// the tree's old record in the repository when it is still the kept copy's own, so git never
// counts it a duplicate of the tree put back; a branch only that record held counts as free.
//
// The undo works from the mark alone, so it undoes any mix of finished and unfinished steps. It
// moves the tree back into the kept folder; after a copy, which left the kept tree whole, it
// removes the copy, renamed aside first so a removal cut short leaves a leftover the sweep removes,
// and the empty folder that took the name before the tree moved; a target that is not the
// put-back's is left alone and written to the service log. Beside
// that it removes the record while the record names the put-back's tree or nothing. Then it deletes
// the branch while the branch still points at the commit it was made at, no tree git lists has it
// checked out, and in its repository no live worktree row is on it and no other put-back makes it.

import { constants as fsConstants } from "node:fs";
import { copyFile, cp, mkdir, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import type { WorktreeCopySubject } from "@ai-sidekicks/contracts/worktree/copy-progress";

import { withCleanupFailures } from "../../cleanup-failures.js";
import type { ServiceLogWriter } from "../../daemon/service-log.js";
import { CAN_FLUSH_FOLDER, flushPath } from "../../disk-flush.js";
import { settleAll } from "../../settle-all.js";
import { canonicalFolderPath } from "../../workspace/folder/canonical-path.js";
import { flushToDisk, readdirOptional, readOptional } from "../filesystem.js";
import { pathExists } from "../../file/path-exists.js";
import type { GitCommand } from "../process.js";
import type { KeptCopyClaims } from "./claims.js";
import {
  isKeptRebase,
  KEPT_LFS_ENTRY,
  KEPT_OBJECTS_ENTRY,
  KEPT_RECORD_ENTRY,
  KEPT_TREE_ENTRY,
  lfsObjectPath,
  listPinRefNames,
  moveFolder,
  pickPins,
  readRebaseFolder,
  removeFolderAsLeftover,
  renameOrCopyFolder,
  type KeptCopyTools,
} from "./kept-copy.js";
import {
  BRANCH_REF_PREFIX,
  commonFolderOfRecord,
  hasBranch,
  LINKED_RECORDS_FOLDER_NAME,
  readRecordNamedBy,
  readRefHeads,
} from "./reads.js";
import { GIT_TAKEN_BRANCH_NAME_PATTERNS, readGitRefusalLine } from "./naming.js";
import { removeStaleTreeRecord } from "./stale-record.js";

// The name a put-back gives a folder or a branch whose own is taken: `<name>-restored` first, then
// `<name>-restored-2`, `<name>-restored-3` and on.
function restoredName(name: string, ordinal: number): string {
  return ordinal === 1 ? `${name}-restored` : `${name}-restored-${String(ordinal)}`;
}

// A put-back's folder or new branch was taken as the put-back made it; the put-back is undone, and
// the next name is tried.
class PutBackNameTakenError extends Error {
  /** Which name was taken. */
  readonly takenName: "folder" | "branch";

  constructor(takenName: "folder" | "branch") {
    super(`the put-back's ${takenName} name was taken as it was made`);
    this.name = new.target.name;
    this.takenName = takenName;
  }
}

/** Where a kept copy goes back to, and the branch it takes there. */
interface PutWorktreeBackInput {
  readonly keptFolder: string;
  readonly targetFolder: string;
  readonly canonicalRoot: string;
  /** The repository's git common folder, the mount's identity anchor. */
  readonly commonFolder: string;
  /**
   * The branch to create at `commit` and put the tree on, when its own branch has moved or another
   * tree holds it; `null` keeps the recorded HEAD as it is.
   */
  readonly newBranch: PutBackBranch | null;
  /** The kept copy's row, which a copy across volumes and its undo name in their progress. */
  readonly copySubject: WorktreeCopySubject;
}

/** A branch a put-back creates, and the commit it creates it at. */
interface PutBackBranch {
  readonly name: string;
  readonly commit: string;
}

/** What a put-back is doing, written down before its tree moves so a crash after is undone. */
export interface PutBackMark extends Pick<
  PutWorktreeBackInput,
  "keptFolder" | "targetFolder" | "newBranch"
> {
  /** Git's record of the tree, which the put-back made under `<common folder>/worktrees/`. */
  readonly recordFolder: string;
}

/** Where a put-back writes down what it is doing, and clears it once every step is undone. */
export interface PutBackMarkWriter {
  /** Writes the mark; runs before the tree moves, and a failure stops the put-back. */
  write(mark: PutBackMark): Promise<void>;
  /** Clears the mark once the put-back is undone whole. */
  clear(): Promise<void>;
}

/**
 * The seams a put-back runs through: the kept copy's, the service log its undo writes to, and what
 * other trees and put-backs hold, which its undo never takes.
 */
export interface PutBackTools extends KeptCopyTools {
  readonly writeServiceLog: ServiceLogWriter;
  readonly claims: KeptCopyClaims;
}

/** The kept copy whose branch a put-back chooses, as its row records it. */
export interface PutBackBranchInput {
  readonly removedWorktreeId: string;
  /** The branch the kept HEAD names, or in a rebase the one being rebased; else the tree's own. */
  readonly branch: string;
  /** Whether `branch` is the one the kept HEAD names, `false` for a detached HEAD. */
  readonly isOnBranch: boolean;
  readonly keptFolder: string;
  /** Git's record of the tree as git named it at the discard. */
  readonly recordFolder: string;
  readonly originalPath: string;
  /** The repository's main checkout, which holds the pins and the branches. */
  readonly canonicalRoot: string;
  /** The repository's git common folder, in which a live tree or a put-back claims the branch. */
  readonly commonFolder: string;
}

/**
 * The kept tree's own branch when it goes back on it, or the recorded commit a new numbered
 * `<branch>-restored` is made at.
 */
export type PutBackBranchChoice = { readonly ownBranch: string } | { readonly newBranchAt: string };

/** A tree put back, with the way to undo the put-back before anything records it. */
interface PutBackWorktree {
  /** Undoes every step, objects copied into the repository too, then clears the mark. */
  undo(): Promise<void>;
}

/** A kept copy to put back at its own folder and branch, or at the first numbered names free. */
export interface PutBackAtFreeNameInput {
  readonly keptFolder: string;
  readonly originalPath: string;
  /** The kept tree's branch, which a new branch's name is numbered from. */
  readonly branch: string;
  readonly canonicalRoot: string;
  /** The repository's git common folder, the mount's identity anchor. */
  readonly commonFolder: string;
  readonly choice: PutBackBranchChoice;
  /** The kept copy's row, which a copy across volumes and its undo name in their progress. */
  readonly copySubject: WorktreeCopySubject;
  /** Whether a folder is taken: on disk, or still owned by a retired tree's cleanup. */
  readonly isFolderTaken: (folder: string) => Promise<boolean>;
}

/** Where a tree was put back, the new branch it went on, if any, and the way to undo it. */
export interface PlacedPutBack {
  readonly putBack: PutBackWorktree;
  readonly targetFolder: string;
  readonly newBranch: PutBackBranch | null;
}

/**
 * Puts a kept copy back at its own folder, or the first numbered `-restored` folder free, on its
 * own branch or the new branch of the same number, the lowest free for both. A name taken as the
 * put-back makes it moves to the next number. Throws what {@link putWorktreeBack} throws otherwise.
 */
export async function putWorktreeBackAtFreeName(
  tools: PutBackTools,
  input: PutBackAtFreeNameInput,
  marks: PutBackMarkWriter,
): Promise<PlacedPutBack> {
  let isFolderRenamed = await input.isFolderTaken(input.originalPath);
  // Each number is a new name and only finitely many are taken, so the walk ends.
  for (let ordinal = 1; ; ) {
    const targetFolder = isFolderRenamed
      ? restoredName(input.originalPath, ordinal)
      : input.originalPath;
    const newBranch =
      "newBranchAt" in input.choice
        ? { name: restoredName(input.branch, ordinal), commit: input.choice.newBranchAt }
        : null;
    if (
      (isFolderRenamed && (await input.isFolderTaken(targetFolder))) ||
      (newBranch !== null &&
        ((await hasBranch(tools.runGit, input.canonicalRoot, newBranch.name)) ||
          tools.claims.isBranchClaimed(newBranch.name, input.commonFolder, "")))
    ) {
      ordinal += 1;
      continue;
    }
    try {
      const putBack = await putWorktreeBack(
        tools,
        {
          keptFolder: input.keptFolder,
          targetFolder,
          canonicalRoot: input.canonicalRoot,
          commonFolder: input.commonFolder,
          newBranch,
          copySubject: input.copySubject,
        },
        marks,
      );
      return { putBack, targetFolder, newBranch };
    } catch (putBackFailure) {
      if (!(putBackFailure instanceof PutBackNameTakenError)) {
        throw putBackFailure;
      }
      // The own folder, taken since it was read, is renamed at the same number; any other taken
      // name moves to the next.
      if (putBackFailure.takenName === "folder" && !isFolderRenamed) {
        isFolderRenamed = true;
      } else {
        ordinal += 1;
      }
    }
  }
}

/**
 * Puts a kept copy back at `targetFolder`, as the file header describes. A failure undoes every
 * step taken, so the kept copy stands whole, and is thrown, `PutBackNameTakenError` when the
 * folder or the new branch was taken as the put-back made it; the pins and what is left of the
 * kept folder stay until the caller has recorded the tree, then go with `deleteKeptCopy`.
 */
async function putWorktreeBack(
  tools: PutBackTools,
  input: PutWorktreeBackInput,
  marks: PutBackMarkWriter,
): Promise<PutBackWorktree> {
  const { runGit } = tools;
  const { commonFolder, newBranch, targetFolder } = input;
  // The names are taken before the mark names them, so two put-backs never take one name. A crash
  // between leaves an empty folder, which git does not list; the next put-back takes the next
  // number.
  try {
    await mkdir(targetFolder);
  } catch (mkdirFailure) {
    if ((mkdirFailure as NodeJS.ErrnoException).code === "EEXIST") {
      throw new PutBackNameTakenError("folder");
    }
    throw mkdirFailure;
  }
  let takenRecord: FreeRecordFolder;
  try {
    takenRecord = await freeRecordFolder(commonFolder, basename(targetFolder));
  } catch (recordFailure) {
    const cleanupFailures: unknown[] = [];
    try {
      await rmdir(targetFolder);
    } catch (rmdirFailure) {
      cleanupFailures.push(rmdirFailure);
    }
    throw withCleanupFailures(recordFailure, cleanupFailures, "taking the put-back's record");
  }
  const { recordFolder } = takenRecord;
  const mark: PutBackMark = { keptFolder: input.keptFolder, targetFolder, recordFolder, newBranch };
  const restoredObjects: string[] = [];
  let isMarked = false;
  let isBranchMade = false;
  const undo = async (): Promise<void> => {
    await settleAll(
      [
        // A branch of that name this put-back did not make is someone's, whatever it points at.
        undoPutBack(tools, isBranchMade ? mark : { ...mark, newBranch: null }, input.copySubject),
        ...restoredObjects.map((restoredObject) => rm(restoredObject, { force: true })),
      ],
      "undoing the put-back",
    );
    restoredObjects.length = 0;
    isBranchMade = false;
    if (isMarked) {
      await marks.clear();
      isMarked = false;
    }
  };

  try {
    await marks.write(mark);
    isMarked = true;
    // Before anything moves: git refuses a name another branch has taken since it was chosen.
    if (newBranch !== null) {
      try {
        await runGit(["-C", input.canonicalRoot, "branch", newBranch.name, newBranch.commit]);
      } catch (branchFailure) {
        if (readGitRefusalLine(branchFailure, GIT_TAKEN_BRANCH_NAME_PATTERNS) !== null) {
          throw new PutBackNameTakenError("branch");
        }
        throw branchFailure;
      }
      isBranchMade = true;
    }
    const [placement, , isLfsFolderMade] = await settleAll(
      [
        (async () => {
          // Windows refuses to rename a folder onto one that exists, so there the empty folder that
          // took the name goes just before the move.
          if (process.platform === "win32") {
            await rmdir(targetFolder);
          }
          const placed = await renameOrCopyFolder(
            tools,
            join(input.keptFolder, KEPT_TREE_ENTRY),
            targetFolder,
            input.copySubject,
            (cause) => cause as Error,
          );
          await writeFile(join(targetFolder, ".git"), `gitdir: ${recordFolder}\n`);
          return placed;
        })(),
        (async () => {
          await cp(join(input.keptFolder, KEPT_RECORD_ENTRY), recordFolder, {
            recursive: true,
            mode: fsConstants.COPYFILE_FICLONE,
          });
          await settleAll(
            [
              writeFile(join(recordFolder, "gitdir"), `${join(targetFolder, ".git")}\n`),
              writeFile(join(recordFolder, "commondir"), "../..\n"),
            ],
            "writing the put-back's record",
          );
          // Once `commondir` names the repository, so git can open the record.
          if (newBranch !== null) {
            await pointRecordAtBranch(runGit, recordFolder, newBranch.name);
          }
        })(),
        restoreObjects(input.keptFolder, commonFolder, restoredObjects),
      ],
      "putting the worktree back",
    );
    // A copy gives every file a new inode and change time, so the index is refreshed to save the
    // next read a rehash; a rename keeps both, and the index it carried is already fresh.
    if (placement === "copied") {
      await runGit(["-C", targetFolder, "update-index", "-q", "--refresh"]);
    }
    await flushPutBackWrites(input, takenRecord, placement, restoredObjects, isLfsFolderMade);
  } catch (putBackFailure) {
    const cleanupFailures: unknown[] = [];
    try {
      await undo();
    } catch (undoFailure) {
      cleanupFailures.push(undoFailure);
    }
    throw withCleanupFailures(putBackFailure, cleanupFailures, "putting the worktree back");
  }
  return { undo };
}

/**
 * Chooses whether a kept tree goes back on its own branch or a new one at the recorded commit, and
 * removes the tree's old record beside the read, as the file header describes. Throws when the
 * recorded commit's pin is gone.
 */
export async function choosePutBackBranch(
  tools: PutBackTools,
  kept: PutBackBranchInput,
): Promise<PutBackBranchChoice> {
  const ownBranchRef = `${BRANCH_REF_PREFIX}${kept.branch}`;
  const [refs, isRebase, isStaleRecordRemoved] = await settleAll(
    [
      readRefHeads(tools.runGit, kept.canonicalRoot, [
        ...listPinRefNames(kept.removedWorktreeId),
        ...(kept.isOnBranch ? [ownBranchRef] : []),
      ]),
      isKeptRebase(kept.keptFolder),
      removeStaleTreeRecord(tools, kept.recordFolder, kept.originalPath),
    ],
    "reading the kept worktree",
  );
  if (!kept.isOnBranch) {
    return { ownBranch: kept.branch };
  }
  const pins = pickPins(refs, kept.removedWorktreeId);
  const recordedCommit = isRebase ? pins["rebase-orig-head"] : pins.head;
  if (recordedCommit === undefined) {
    throw new Error(
      `kept worktree "${kept.removedWorktreeId}" lost the pin of the commit it stood on`,
    );
  }
  const ownHead = refs.get(ownBranchRef);
  const holder = ownHead?.checkedOutAt ?? null;
  // The removed record named the tree's old folder, so a branch only it held is free.
  const isHeldByRemovedRecord =
    holder !== null &&
    isStaleRecordRemoved &&
    (await canonicalFolderPath(holder)) === (await canonicalFolderPath(kept.originalPath));
  // A live tree's row on the branch holds it too, though git no longer reads that tree.
  if (
    ownHead?.commit === recordedCommit &&
    (holder === null || isHeldByRemovedRecord) &&
    !tools.claims.isBranchClaimed(kept.branch, kept.commonFolder, kept.recordFolder)
  ) {
    return { ownBranch: kept.branch };
  }
  return { newBranchAt: recordedCommit };
}

/**
 * Throws unless the tree put back at `treeFolder` stands sound: its `.git` names a record that
 * exists and git reads its HEAD there. Its kept copy is deleted only once this passes.
 */
export async function requireSoundRestoredTree(
  runGit: GitCommand,
  treeFolder: string,
): Promise<void> {
  const namedRecord = await readRecordNamedBy(join(treeFolder, ".git"));
  if (namedRecord === undefined || !(await pathExists(namedRecord))) {
    throw new Error(`the tree put back at ${treeFolder} names no record git keeps`);
  }
  try {
    await runGit(["--no-optional-locks", "-C", treeFolder, "rev-parse", "--verify", "-q", "HEAD"]);
  } catch (gitFailure) {
    throw new Error(`git cannot read HEAD in the tree put back at ${treeFolder}`, {
      cause: gitFailure,
    });
  }
}

/**
 * Undoes a put-back from its mark, whatever mix of its steps finished, as the file header
 * describes, a copy back across volumes reporting its progress for `copySubject`. Each step already
 * undone is no failure, so a second call finishes one that failed part way; a kept copy whose tree
 * is in neither folder is thrown.
 */
export async function undoPutBack(
  tools: PutBackTools,
  mark: PutBackMark,
  copySubject: WorktreeCopySubject,
): Promise<void> {
  await settleAll(
    [undoTreePlacement(tools, mark, copySubject), removeOwnRecord(mark)],
    "undoing the put-back",
  );
  if (mark.newBranch !== null) {
    await deleteOwnBranch(tools, mark.recordFolder, mark.newBranch);
  }
}

async function undoTreePlacement(
  tools: PutBackTools,
  mark: PutBackMark,
  copySubject: WorktreeCopySubject,
): Promise<void> {
  const keptTree = join(mark.keptFolder, KEPT_TREE_ENTRY);
  const [hasKeptTree, hasTarget] = await Promise.all([
    pathExists(keptTree),
    pathExists(mark.targetFolder),
  ]);
  if (hasTarget && hasKeptTree) {
    // The tree never moved, so the folder is the empty one that took the name.
    if ((await readdirOptional(mark.targetFolder)).length === 0) {
      await rmdir(mark.targetFolder);
      return;
    }
    // The kept tree is whole, so only the put-back's own copy goes: it carries the kept tree's
    // `.git` file or the one the put-back wrote.
    const [targetGitFile, keptGitFile] = await Promise.all([
      readOptional(join(mark.targetFolder, ".git")),
      readOptional(join(keptTree, ".git")),
    ]);
    if (targetGitFile === keptGitFile || targetGitFile === `gitdir: ${mark.recordFolder}\n`) {
      await removeFolderAsLeftover(tools.filesystem, mark.targetFolder);
      return;
    }
    tools.writeServiceLog(
      `put-back of ${mark.keptFolder}: ${mark.targetFolder} holds no copy of the kept tree, so ` +
        "it is left as it is; the kept tree is whole",
    );
  } else if (hasTarget) {
    await moveFolder(tools, mark.targetFolder, keptTree, copySubject, (cause) => cause as Error);
  } else if (!hasKeptTree) {
    throw new Error("the put-back's tree is neither in the kept folder nor where it went");
  }
}

// The record is the put-back's own only while it names the put-back's tree or nothing yet; one a
// later tree took after an earlier undo removed it is left alone.
async function removeOwnRecord(mark: PutBackMark): Promise<void> {
  // The stored folder comes from the database, so a recursive delete reaches only a record.
  if (
    !isAbsolute(mark.recordFolder) ||
    basename(dirname(mark.recordFolder)) !== LINKED_RECORDS_FOLDER_NAME
  ) {
    throw new Error("the put-back's stored record folder is not a worktree record");
  }
  const gitdir = await readOptional(join(mark.recordFolder, "gitdir"));
  if (gitdir === undefined || gitdir === `${join(mark.targetFolder, ".git")}\n`) {
    await rm(mark.recordFolder, { recursive: true, force: true });
  }
}

// Runs once the put-back's record is gone, so a tree git still lists on the branch is another's.
// By its ref, at the commit it was made at: a branch moved since is someone's work, and one a live
// tree's row or another put-back's mark names in this repository is that tree's.
async function deleteOwnBranch(
  tools: PutBackTools,
  recordFolder: string,
  branch: PutBackBranch,
): Promise<void> {
  const commonFolder = commonFolderOfRecord(recordFolder);
  if (tools.claims.isBranchClaimed(branch.name, commonFolder, recordFolder)) {
    return;
  }
  const refName = `${BRANCH_REF_PREFIX}${branch.name}`;
  const head = (await readRefHeads(tools.runGit, commonFolder, [refName])).get(refName);
  if (head === undefined || head.commit !== branch.commit || head.checkedOutAt !== null) {
    return;
  }
  // Read again just before the delete, so a put-back that marked the branch since keeps it.
  if (tools.claims.isBranchClaimed(branch.name, commonFolder, recordFolder)) {
    return;
  }
  await tools.runGit(["-C", commonFolder, "update-ref", "-d", refName, branch.commit]);
}

// Puts the record's HEAD, or a rebase's branch, on `branch`. HEAD goes through git, which writes
// it wherever the repository keeps refs; a rebase's `head-name` is a file in either ref store.
async function pointRecordAtBranch(
  runGit: GitCommand,
  recordFolder: string,
  branch: string,
): Promise<void> {
  const rebaseFolder = await readRebaseFolder(recordFolder);
  if (rebaseFolder === null) {
    await runGit([
      `--git-dir=${recordFolder}`,
      "symbolic-ref",
      "HEAD",
      `${BRANCH_REF_PREFIX}${branch}`,
    ]);
    return;
  }
  await writeFile(join(recordFolder, rebaseFolder, "head-name"), `${BRANCH_REF_PREFIX}${branch}\n`);
}

// The record folder a put-back takes, and whether it made the folder of records too.
interface FreeRecordFolder {
  readonly recordFolder: string;
  readonly isRecordsFolderMade: boolean;
}

// The record folder a put-back writes: git's own naming, the folder's name with the first free
// number after it when another record has it.
async function freeRecordFolder(commonFolder: string, treeName: string): Promise<FreeRecordFolder> {
  const recordsFolder = join(commonFolder, LINKED_RECORDS_FOLDER_NAME);
  // `mkdir` answers the first folder it made, so a new folder of records is flushed with the rest.
  const isRecordsFolderMade = (await mkdir(recordsFolder, { recursive: true })) !== undefined;
  for (let ordinal = 0; ; ordinal += 1) {
    const candidate = join(recordsFolder, ordinal === 0 ? treeName : `${treeName}${ordinal}`);
    try {
      await mkdir(candidate);
      return { recordFolder: candidate, isRecordsFolderMade };
    } catch (mkdirFailure) {
      if ((mkdirFailure as NodeJS.ErrnoException).code !== "EEXIST") {
        throw mkdirFailure;
      }
    }
  }
}

// Copies the kept pack and LFS objects into the repository, adding each file it writes to `written`
// as it goes, so a failure part way still names every one for the undo. A copy works across
// volumes, and git objects never change, so the kept ones stay whole for an undo and go with the
// kept copy once the put-back is recorded. Answers whether it made the repository's `lfs` folder.
async function restoreObjects(
  keptFolder: string,
  commonFolder: string,
  written: string[],
): Promise<boolean> {
  const objectsFolder = join(keptFolder, KEPT_OBJECTS_ENTRY);
  for (const { name } of await readdirOptional(objectsFolder)) {
    const target = join(commonFolder, "objects", "pack", name);
    if (!(await pathExists(target))) {
      written.push(target);
      await copyFile(join(objectsFolder, name), target, fsConstants.COPYFILE_FICLONE);
    }
  }
  const lfsFolder = join(keptFolder, KEPT_LFS_ENTRY);
  let isLfsFolderMade = false;
  for (const { name: lfsObjectId } of await readdirOptional(lfsFolder)) {
    const target = lfsObjectPath(commonFolder, lfsObjectId);
    if (!(await pathExists(target))) {
      // `mkdir` answers the first folder it made, and of those it can make only one is `lfs`.
      const madeFolder = await mkdir(dirname(target), { recursive: true });
      isLfsFolderMade ||= madeFolder !== undefined && basename(madeFolder) === "lfs";
      written.push(target);
      await copyFile(join(lfsFolder, lfsObjectId), target, fsConstants.COPYFILE_FICLONE);
    }
  }
  return isLfsFolderMade;
}

// Flushes everything a put-back wrote: a new branch first, then the target's `.git`, the record,
// the objects and, after a copy, the tree, each with the folders that name it.
async function flushPutBackWrites(
  input: PutWorktreeBackInput,
  { recordFolder, isRecordsFolderMade }: FreeRecordFolder,
  placement: "renamed" | "copied",
  restoredObjects: readonly string[],
  isLfsFolderMade: boolean,
): Promise<void> {
  const { newBranch, targetFolder } = input;
  const commonFolder = resolve(input.commonFolder);
  // The branch is flushed while the rest is listed, so a ref write elsewhere in the repository has
  // the least time to move it.
  const [record, copiedTree] = await settleAll(
    [
      listFolderEntries(recordFolder),
      placement === "copied" ? listFolderEntries(targetFolder) : NO_ENTRIES,
      newBranch === null ? undefined : flushNewBranch(commonFolder, newBranch.name),
    ],
    "flushing the put-back",
  );
  // A copied object's folders up to the repository's git folder, which an LFS copy may have made.
  const objectFolders = restoredObjects.flatMap((restoredObject) =>
    listFoldersBelow(restoredObject, commonFolder),
  );
  await flushToDisk(
    [join(targetFolder, ".git"), ...record.files, ...copiedTree.files, ...restoredObjects],
    [
      dirname(targetFolder),
      targetFolder,
      dirname(recordFolder),
      ...(isRecordsFolderMade || isLfsFolderMade ? [commonFolder] : []),
      ...record.folders,
      ...copiedTree.folders,
      ...objectFolders,
    ],
  );
}

// Flushes where git wrote a new branch. A reftable repository keeps every ref in the tables under
// `reftable/`, a folder no other ref store makes; otherwise the branch has its own ref file.
async function flushNewBranch(commonFolder: string, branch: string): Promise<void> {
  const reftableFolder = join(commonFolder, "reftable");
  if (await pathExists(reftableFolder)) {
    await flushRefTables(reftableFolder);
    return;
  }
  await flushLooseBranchRef(commonFolder, branch);
}

// Three passes: the list changes between a pass's read and its check only when a ref write lands
// in that window, rare even twice.
const REF_TABLE_PASS_LIMIT = 3;

// Flushes each table `tables.list` names, then the list, then reads the list again. A ref write
// elsewhere can compact the tables meanwhile into a new table that holds the branch, so a pass
// repeats while the list names a table not yet flushed, and the folder is flushed last.
async function flushRefTables(reftableFolder: string): Promise<void> {
  const tableList = join(reftableFolder, "tables.list");
  const readTableList = async (): Promise<string[]> =>
    (await readFile(tableList, "utf8")).split("\n").filter((name) => name !== "");
  const flushedTables = new Set<string>();
  let tables = await readTableList();
  for (let pass = 1; ; pass += 1) {
    const unflushedTables = tables.filter((table) => !flushedTables.has(table));
    // A table compacted away mid-flush is gone, and the list read after this pass no longer
    // names it.
    const flushOutcomes = await settleAll(
      unflushedTables.map((table) => flushUnlessGone(join(reftableFolder, table))),
      "flushing the ref tables",
    );
    for (const [index, table] of unflushedTables.entries()) {
      if (flushOutcomes[index] === true) {
        flushedTables.add(table);
      }
    }
    await flushPath(tableList);
    tables = await readTableList();
    if (tables.every((table) => flushedTables.has(table))) {
      break;
    }
    if (pass === REF_TABLE_PASS_LIMIT) {
      throw new Error(`the ref tables in ${reftableFolder} kept changing while they were flushed`);
    }
  }
  if (CAN_FLUSH_FOLDER) {
    await flushPath(reftableFolder);
  }
}

// Flushes the branch's ref file and, when git keeps one, its reflog, each with its folders. A ref
// file gone, before its flush or after it, was packed into `packed-refs` since git wrote it
// (`git gc --auto` packs refs), so that file and the folder that names it are flushed as well.
async function flushLooseBranchRef(commonFolder: string, branch: string): Promise<void> {
  const refFile = join(commonFolder, `${BRANCH_REF_PREFIX}${branch}`);
  const reflogFile = join(commonFolder, "logs", `${BRANCH_REF_PREFIX}${branch}`);
  const [isRefFlushed, hasReflog] = await settleAll(
    [flushUnlessGone(refFile), pathExists(reflogFile)],
    "flushing the new branch",
  );
  const reflog: FolderEntries = hasReflog
    ? { files: [reflogFile], folders: listFoldersBelow(reflogFile, commonFolder) }
    : NO_ENTRIES;
  await flushToDisk(reflog.files, [
    ...(isRefFlushed ? listFoldersBelow(refFile, join(commonFolder, "refs")) : []),
    ...reflog.folders,
  ]);
  if (!isRefFlushed || !(await pathExists(refFile))) {
    await flushToDisk([join(commonFolder, "packed-refs")], [commonFolder]);
  }
}

// Flushes the file at `path`, answering `false` when it is gone.
async function flushUnlessGone(path: string): Promise<boolean> {
  try {
    await flushPath(path);
    return true;
  } catch (flushFailure) {
    if ((flushFailure as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw flushFailure;
  }
}

// The folders that hold `path`, from its own up to, not including, `top`.
function listFoldersBelow(path: string, top: string): string[] {
  const folders: string[] = [];
  for (let folder = dirname(path); folder.length > top.length; folder = dirname(folder)) {
    folders.push(folder);
  }
  return folders;
}

// The files and folders a flush reaches.
interface FolderEntries {
  readonly files: readonly string[];
  readonly folders: readonly string[];
}

const NO_ENTRIES: FolderEntries = { files: [], folders: [] };

// `folder` and every file and folder under it; a link or any other entry is left out.
async function listFolderEntries(folder: string): Promise<FolderEntries> {
  const files: string[] = [];
  const folders = [folder];
  for (const entry of await readdir(folder, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      files.push(join(entry.parentPath, entry.name));
    } else if (entry.isDirectory()) {
      folders.push(join(entry.parentPath, entry.name));
    }
  }
  return { files, folders };
}
