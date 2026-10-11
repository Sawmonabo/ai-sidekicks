// The kept copy of a discarded worktree, on disk and in the repository: moving the tree aside whole
// with git's record of it, the objects its index needs and the commits its state names, reading
// and deleting what it keeps, and the folder moves and reads that putting it back shares. The kept
// folder holds the tree under `worktree/`, git's per-worktree record under `record/`, the index's
// objects HEAD's tree lacks as one pack under `objects/`, and the LFS objects its staged pointers
// name under `lfs-objects/`. The commits are pinned as refs under
// `refs/sidekicks/removed/<removed id>/`, which `git gc` keeps.
//
// A move aside writes the kept copy's row first, so a crash leaves nothing the row does not list.
// Beside that write it reads git's record of the tree, HEAD and `ORIG_HEAD` through git in the
// tree, since either ref store may keep them, and the index's objects HEAD's tree lacks. Each step
// after waits only for what it reads: the kept folder for the row, the record's copy (cloned where
// the volume can, its location files left out) for the folder and the record's name, the pack and
// the LFS objects for the folder and the object list, and the pins and the branch for HEAD and the
// record's copy, whose state files (`MERGE_HEAD`, a rebase's) are files in either ref store and are
// read from the copy so they match what is kept. Every step settles before a failure cleans up, and
// the row goes only once that cleanup succeeded, so one that fails leaves the row for the repair.
// The row is then filled in with what the copy records, and the folder moves by one rename. A move
// across volumes copies first and removes the original only once the copy is complete; when that
// removal fails, both are kept and the move throws `FolderMoveIncompleteError`. The caller removes
// git's record once the move is recorded.
//
// A copy across volumes reports its progress: one walk of the source first sums the size of every
// regular file by path, since the copy copies a hard-linked file once per path and a link as a
// link, and each file's size is added once the copy is done with it. Node's `cp` copies one entry
// at a time and asks its filter about each before copying it, so a file is done once the filter
// is asked about the next entry, and the last one once the copy resolves. While a file copies, its
// destination's size grows as the bytes are written, and each progress tick reads it.

import { constants as fsConstants } from "node:fs";
import { copyFile, cp, mkdir, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import type { ProjectId } from "@ai-sidekicks/contracts/project";
import type { WorktreeCopySubject } from "@ai-sidekicks/contracts/worktree/copy-progress";
import type { WorktreeId } from "@ai-sidekicks/contracts/worktree/lifecycle";

import { withCleanupFailures } from "../../cleanup-failures.js";
import { mapWithProcessorBound } from "../../processor-bound.js";
import { settleAll } from "../../settle-all.js";
import { mintUuidV7 } from "../../uuid-v7.js";
import { readFolderNamesOptional, readOptional, type GitFilesystem } from "../filesystem.js";
import { pathExists } from "../../file/path-exists.js";
import type { GitCommand } from "../process.js";
import type { WorktreeCopiesUnderWay, WorktreeCopyReport } from "./copy-progress.js";
import { WorktreeRetireFolderHeldError } from "./errors.js";
import { REMOVED_WORKTREES_FOLDER_NAME } from "./naming.js";
import {
  commonFolderOfRecord,
  readCurrentBranch,
  readLinkedTreeRecord,
  type RefHead,
} from "./reads.js";

/** The entry of a kept folder that holds the tree itself. */
export const KEPT_TREE_ENTRY = "worktree";
// Where a deletion moves the kept tree first, a name nothing else reads; a rename within one
// folder is atomic, so the tree is either whole under its own name or no longer under it.
const KEPT_TREE_DELETING_ENTRY = `${KEPT_TREE_ENTRY}.deleting`;
/** The entry of a kept folder that holds git's per-worktree record of the tree. */
export const KEPT_RECORD_ENTRY = "record";
/** The entry of a kept folder that holds the pack of the index's objects HEAD's tree lacks. */
export const KEPT_OBJECTS_ENTRY = "objects";
/** The entry of a kept folder that holds the LFS objects the tree's staged pointers name. */
export const KEPT_LFS_ENTRY = "lfs-objects";

// A gitlink's mode: its commit lives in the submodule's repository, not this one.
const SUBMODULE_MODE = "160000";

// What a record holds that names where its tree lives; a put-back writes them afresh. A `locked`
// file is kept, so a locked tree comes back locked.
const RECORD_LOCATION_FILES: ReadonlySet<string> = new Set(["gitdir", "commondir"]);

const PIN_REF_PREFIX = "refs/sidekicks/removed";

// How the system refuses a rename while a program holds a file in the tree open: Windows answers
// EPERM, EACCES or EBUSY, other systems EBUSY alone, where a permission refusal surfaces as itself.
const HELD_FILE_ERROR_CODES: ReadonlySet<string> = new Set(
  process.platform === "win32" ? ["EPERM", "EACCES", "EBUSY"] : ["EBUSY"],
);
const CROSS_VOLUME_ERROR_CODE = "EXDEV";

/** The id a leftover folder's name ends in, as a pattern, so no other folder is taken for one. */
export const LEFTOVER_ID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

// A copy across volumes is made under its folder's name with `.copying-<its own id>` added and
// renamed into place once whole, so a crash partway never leaves a partial copy under the real
// name, and no copy ever starts in, or is taken for, another copy's leftover.
const COPY_IN_PROGRESS_INFIX = ".copying-";
const COPY_IN_PROGRESS_PATTERN = new RegExp(`\\${COPY_IN_PROGRESS_INFIX}${LEFTOVER_ID_PATTERN}$`);

// The in-progress copies this process is making now, so the leftover sweep never takes one for a
// copy a crash cut short.
const copiesInProgress = new Set<string>();

// A git LFS pointer is a small text blob; anything larger is never one.
const LFS_POINTER_MAX_BYTES = 1024;
const LFS_POINTER_OID_PATTERN = /^oid sha256:([0-9a-f]{64})$/m;
const LFS_POINTER_VERSION_LINE = "version https://git-lfs.github.com/spec/v1";

const OBJECT_ID_PATTERN = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
// The object id git prints for a side that has none, such as a deleted or unmerged path.
const NO_OBJECT_PATTERN = /^0+$/;

// The name each pin ref takes under the kept copy's prefix, one per commit its saved state names.
const KEPT_WORKTREE_PIN_NAMES = [
  "head",
  "orig-head",
  "merge-head",
  "rebase-onto",
  "rebase-orig-head",
] as const;
type KeptWorktreePinName = (typeof KEPT_WORKTREE_PIN_NAMES)[number];

/** The commits a kept copy pins, by the name its pin ref takes. */
export type KeptWorktreePins = Readonly<Partial<Record<KeptWorktreePinName, string>>>;

/** Where a tree is and where its kept copy goes. */
export interface MoveWorktreeAsideInput {
  readonly worktreeId: WorktreeId;
  /** The tree's project, which a copy across volumes names in its progress. */
  readonly projectId: ProjectId;
  readonly treeFolder: string;
  /** The repository's main checkout, where the pins are written. */
  readonly canonicalRoot: string;
  readonly keptFolder: string;
  readonly removedWorktreeId: string;
}

/** What a tree's kept copy records about it, known before the folder moves. */
export interface KeptWorktreeState {
  readonly headCommit: string;
  /** The branch the tree's HEAD names, or in a rebase the branch being rebased; `null` detached. */
  readonly branch: string | null;
  /** Git's record of the tree in the repository, as git named it from inside the live tree. */
  readonly recordFolder: string;
}

/** The writes a move aside makes to the kept copy's row, each before what it names is made. */
export interface KeptCopyRowWrites {
  /** Writes the row naming the kept folder and the pins; runs before either is made. */
  recordPending(): Promise<void>;
  /** Fills in what the copy records; runs before the tree moves. */
  recordState(state: KeptWorktreeState): Promise<void>;
  /** Deletes the row of a move that failed, once everything the row lists is gone. */
  forgetPending(): Promise<void>;
}

/** A tree moved aside, whose record the caller removes once the move is kept, with the undo. */
export interface MovedAsideWorktree extends KeptWorktreeState {
  /** Moves the tree back, deletes the pins and the kept folder, leaving git's record as it was. */
  undo(): Promise<void>;
}

/** The git and filesystem seams the kept copy runs through, and where its copies report. */
export interface KeptCopyTools {
  readonly runGit: GitCommand;
  readonly filesystem: Pick<GitFilesystem, "rename" | "removePath">;
  /** Where a copy across volumes reports its progress. */
  readonly copies: Pick<WorktreeCopiesUnderWay, "begin" | "logUnmeasuredCopy">;
}

type FolderMoveTools = Pick<KeptCopyTools, "filesystem" | "copies">;

/**
 * A move across volumes copied the folder whole but could not remove the original completely:
 * both are kept, the copy complete and the original partly left, and nothing was deleted to undo
 * it.
 */
export class FolderMoveIncompleteError extends Error {
  constructor(cause: unknown) {
    super(
      "the folder was copied whole to its new place, but the original could not be removed " +
        "completely; both are kept",
      { cause },
    );
    this.name = "FolderMoveIncompleteError";
  }
}

/**
 * Moves a tree aside whole into its kept folder, as the file header describes. Throws
 * {@link WorktreeRetireFolderHeldError} when the system refuses the move while a program holds a
 * file open, and any other failure before the move, having removed what it made and then its row,
 * which stays when that cleanup fails; throws {@link FolderMoveIncompleteError} with both kept.
 */
export async function moveWorktreeAside(
  tools: KeptCopyTools,
  input: MoveWorktreeAsideInput,
  rowWrites: KeptCopyRowWrites,
): Promise<MovedAsideWorktree> {
  const { runGit } = tools;
  const { treeFolder, keptFolder } = input;
  const keptRecord = join(keptFolder, KEPT_RECORD_ENTRY);
  const keptTree = join(keptFolder, KEPT_TREE_ENTRY);
  const discardKeptCopy = (): Promise<void> =>
    deleteKeptCopy(tools, keptFolder, input.canonicalRoot, input.removedWorktreeId);
  const refuseHeld = (cause: unknown): Error =>
    new WorktreeRetireFolderHeldError(input.worktreeId, cause);
  // The worktree's row, which the move and its undo both draw on.
  const copySubject: WorktreeCopySubject = {
    kind: "removing",
    worktreeId: input.worktreeId,
    projectId: input.projectId,
    name: basename(treeFolder),
  };
  let isPendingWritten = false;
  try {
    const keptFolderMade = (async () => {
      await rowWrites.recordPending();
      isPendingWritten = true;
      await mkdir(keptFolder, { recursive: true });
    })();
    const recordRead = (async () => {
      const linkedRecord = await readLinkedTreeRecord(runGit, treeFolder);
      if (linkedRecord === null) {
        throw new Error(
          `worktree "${input.worktreeId}" has no record of its own in the repository`,
        );
      }
      return linkedRecord;
    })();
    const headRead = readHeadRefs(runGit, treeFolder);
    const missingFromHeadRead = listIndexObjectsMissingFromHead(runGit, treeFolder);
    const recordCopied = (async () => {
      const liveRecordFolder = await recordRead;
      await keptFolderMade;
      await cp(liveRecordFolder, keptRecord, {
        recursive: true,
        mode: fsConstants.COPYFILE_FICLONE,
        filter: (source) => !RECORD_LOCATION_FILES.has(relativeEntry(liveRecordFolder, source)),
      });
    })();
    const objectsPacked = (async () => {
      const missingFromHead = await missingFromHeadRead;
      await keptFolderMade;
      await packObjects(runGit, treeFolder, join(keptFolder, KEPT_OBJECTS_ENTRY), missingFromHead);
    })();
    const lfsObjectsKept = (async () => {
      const [liveRecordFolder, missingFromHead] = await Promise.all([
        recordRead,
        missingFromHeadRead,
        keptFolderMade,
      ]);
      const commonFolder = commonFolderOfRecord(liveRecordFolder);
      await keepLfsObjects(runGit, treeFolder, commonFolder, keptFolder, missingFromHead);
    })();
    const pinsWritten = (async () => {
      const [head] = await Promise.all([headRead, recordCopied]);
      const pins = await readStatePins(keptRecord, head);
      await writePins(runGit, input.canonicalRoot, input.removedWorktreeId, pins);
    })();
    const branchRead = (async () => {
      const [head] = await Promise.all([headRead, recordCopied]);
      return readKeptBranch(keptRecord, head.branch);
    })();
    const [recordFolder, { commit: headCommit }, , , , , , , branch] = await settleAll(
      [
        recordRead,
        headRead,
        missingFromHeadRead,
        keptFolderMade,
        recordCopied,
        objectsPacked,
        lfsObjectsKept,
        pinsWritten,
        branchRead,
      ],
      "keeping the worktree",
    );
    await rowWrites.recordState({ headCommit, branch, recordFolder });
    await moveFolder(tools, treeFolder, keptTree, copySubject, refuseHeld);
    return {
      headCommit,
      branch,
      recordFolder,
      undo: async () => {
        // Its copy back still reads as the removal: the removal is under way until it ends or
        // fails. The tree is whole once back, so the kept tree goes by the deletion's rename
        // aside, never removed in place under its own name.
        await renameOrCopyFolder(tools, keptTree, treeFolder, copySubject, refuseHeld);
        await discardKeptCopy();
      },
    };
  } catch (keepFailure) {
    // Both copies stand, so nothing of either is deleted.
    if (keepFailure instanceof FolderMoveIncompleteError) {
      throw keepFailure;
    }
    const cleanupFailures: unknown[] = [];
    try {
      await discardKeptCopy();
      // Only once nothing it lists is left: a row kept after a failed cleanup lets the repair
      // delete what is left.
      if (isPendingWritten) {
        await rowWrites.forgetPending();
      }
    } catch (cleanupFailure) {
      cleanupFailures.push(cleanupFailure);
    }
    throw withCleanupFailures(keepFailure, cleanupFailures, "moving the worktree aside");
  }
}

/**
 * Deletes a kept copy for good: first takes its tree off the kept tree's name, so a deletion that
 * fails part way never leaves a partial tree that reads as whole, then deletes its pins and its
 * folder at once. A failed rename deletes nothing and is thrown; any part already gone is no
 * failure, so a second call finishes one that failed part way.
 */
export async function deleteKeptCopy(
  tools: Pick<KeptCopyTools, "runGit" | "filesystem">,
  keptFolder: string,
  canonicalRoot: string | null,
  removedWorktreeId: string,
): Promise<void> {
  try {
    await tools.filesystem.rename(
      join(keptFolder, KEPT_TREE_ENTRY),
      join(keptFolder, KEPT_TREE_DELETING_ENTRY),
    );
  } catch (renameFailure) {
    // A copy put back by a move, a discard undone or cut short, or a deletion tried before, has no
    // tree there.
    if ((renameFailure as NodeJS.ErrnoException).code !== "ENOENT") {
      throw renameFailure;
    }
  }
  await settleAll(
    [
      canonicalRoot === null
        ? Promise.resolve()
        : deletePins(tools.runGit, canonicalRoot, removedWorktreeId),
      tools.filesystem.removePath(keptFolder),
    ],
    "deleting the kept copy",
  );
}

/** The full names of every pin ref a kept copy may have, for one read of the refs. */
export function listPinRefNames(removedWorktreeId: string): readonly string[] {
  return KEPT_WORKTREE_PIN_NAMES.map((name) => pinRefName(removedWorktreeId, name));
}

/** The pinned commits of a kept copy, picked from refs read by their full names. */
export function pickPins(
  refs: ReadonlyMap<string, RefHead>,
  removedWorktreeId: string,
): KeptWorktreePins {
  const pins: Partial<Record<KeptWorktreePinName, string>> = {};
  for (const name of KEPT_WORKTREE_PIN_NAMES) {
    const commit = refs.get(pinRefName(removedWorktreeId, name))?.commit;
    if (commit !== undefined) {
      pins[name] = commit;
    }
  }
  return pins;
}

/** Whether the saved state is a rebase, whose own branch is judged by its recorded `orig-head`. */
export async function isKeptRebase(keptFolder: string): Promise<boolean> {
  return (await readRebaseFolder(join(keptFolder, KEPT_RECORD_ENTRY))) !== null;
}

/** The kept copy's size on disk: every file under its folder, a file hard-linked twice once. */
export async function measureKeptCopy(keptFolder: string): Promise<number> {
  let total = 0;
  const counted = new Set<string>();
  const entries = await readdir(keptFolder, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile()) {
      const status = await stat(join(entry.parentPath, entry.name));
      const identity = `${String(status.dev)}:${String(status.ino)}`;
      if (!counted.has(identity)) {
        counted.add(identity);
        total += status.size;
      }
    }
  }
  return total;
}

function relativeEntry(root: string, entry: string): string {
  return entry.length > root.length ? entry.slice(root.length + 1) : "";
}

// The objects the index names that HEAD's tree does not: the new side of every staged change, read
// from git's own index-to-HEAD comparison rather than by listing both whole, and every stage of a
// conflicted path, which may come from no commit the pins keep. A blob HEAD also holds at another
// path is packed too, which costs a few bytes and loses nothing.
async function listIndexObjectsMissingFromHead(
  runGit: GitCommand,
  treeFolder: string,
): Promise<readonly string[]> {
  const staged = await runGit([
    "--no-optional-locks",
    "-C",
    treeFolder,
    "diff-index",
    "--cached",
    "--no-renames",
    "-z",
    "HEAD",
  ]);
  const missing = new Set<string>();
  let hasConflict = false;
  // With renames off each change is two fields, `:<old mode> <new mode> <old object> <new object>
  // <status>` and then its path, which may itself start with `:`; the output ends with a NUL.
  const fields = staged.stdout.toString("utf8").split("\0");
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const change = fields[index] ?? "";
    const [newMode, , newObject, status] = change.slice(1).split(" ").slice(1);
    if (!change.startsWith(":") || newObject === undefined || !OBJECT_ID_PATTERN.test(newObject)) {
      throw new Error("git diff-index answered a change in an unexpected form");
    }
    if (status === "U") {
      hasConflict = true;
    } else if (newMode !== SUBMODULE_MODE && !NO_OBJECT_PATTERN.test(newObject)) {
      missing.add(newObject);
    }
  }
  if (hasConflict) {
    for (const stageObject of await listConflictStageObjects(runGit, treeFolder)) {
      missing.add(stageObject);
    }
  }
  return [...missing];
}

// The blob of every stage of every conflicted path; each entry is `<mode> <object> <stage>`, a tab,
// then its path.
async function listConflictStageObjects(
  runGit: GitCommand,
  treeFolder: string,
): Promise<readonly string[]> {
  const unmerged = await runGit(["--no-optional-locks", "-C", treeFolder, "ls-files", "-u", "-z"]);
  const stageObjects: string[] = [];
  for (const entry of unmerged.stdout.toString("utf8").split("\0")) {
    if (entry.length === 0) continue;
    const [mode, object] = (entry.split("\t", 1)[0] ?? "").split(" ");
    if (object === undefined || !OBJECT_ID_PATTERN.test(object)) {
      throw new Error("git ls-files answered a conflict stage in an unexpected form");
    }
    if (mode !== SUBMODULE_MODE) {
      stageObjects.push(object);
    }
  }
  return stageObjects;
}

async function packObjects(
  runGit: GitCommand,
  treeFolder: string,
  objectsFolder: string,
  objectNames: readonly string[],
): Promise<void> {
  if (objectNames.length === 0) {
    return;
  }
  await mkdir(objectsFolder, { recursive: true });
  // `pack-objects <base>` writes `<base>-<hash>.pack` and its index, the names a repository's own
  // `objects/pack/` holds, so a put-back moves them in as they are.
  await runGit(["-C", treeFolder, "pack-objects", "-q", join(objectsFolder, "pack")], {
    stdin: Buffer.from(`${objectNames.join("\n")}\n`, "utf8"),
  });
}

// Keeps the LFS object each staged pointer names, when the repository holds it.
async function keepLfsObjects(
  runGit: GitCommand,
  treeFolder: string,
  commonFolder: string,
  keptFolder: string,
  objectNames: readonly string[],
): Promise<void> {
  if (objectNames.length === 0) {
    return;
  }
  const sizes = await runGit(
    ["-C", treeFolder, "cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    { stdin: Buffer.from(`${objectNames.join("\n")}\n`, "utf8") },
  );
  const smallBlobs = sizes.stdout
    .toString("utf8")
    .split("\n")
    .map((line) => line.split(" "))
    .filter(([, type, size]) => type === "blob" && Number(size) <= LFS_POINTER_MAX_BYTES)
    .map(([objectName]) => objectName ?? "");
  for (const objectName of smallBlobs) {
    const blob = (await runGit(["-C", treeFolder, "cat-file", "blob", objectName])).stdout.toString(
      "utf8",
    );
    const lfsObjectId = blob.startsWith(LFS_POINTER_VERSION_LINE)
      ? LFS_POINTER_OID_PATTERN.exec(blob)?.[1]
      : undefined;
    if (lfsObjectId === undefined) {
      continue;
    }
    const source = lfsObjectPath(commonFolder, lfsObjectId);
    if (!(await pathExists(source))) {
      continue;
    }
    await mkdir(join(keptFolder, KEPT_LFS_ENTRY), { recursive: true });
    await copyFile(source, join(keptFolder, KEPT_LFS_ENTRY, lfsObjectId));
  }
}

/** Where a repository whose git common folder is `commonFolder` keeps one LFS object. */
export function lfsObjectPath(commonFolder: string, lfsObjectId: string): string {
  return join(
    commonFolder,
    "lfs",
    "objects",
    lfsObjectId.slice(0, 2),
    lfsObjectId.slice(2, 4),
    lfsObjectId,
  );
}

// HEAD's commit and branch, and `ORIG_HEAD`, as git reads them in the tree: a reftable repository
// keeps them in its ref table, not as files in the record.
interface HeadRefs {
  readonly commit: string;
  /** The branch HEAD names, or `null` while it is detached. */
  readonly branch: string | null;
  readonly origHead: string | undefined;
}

// Two reads every supported git has, side by side: the commits, one `<object> <type>` line per
// name in the order asked, or `<name> missing`, and the branch HEAD names.
async function readHeadRefs(runGit: GitCommand, treeFolder: string): Promise<HeadRefs> {
  const [objects, branch] = await settleAll(
    [
      runGit(
        [
          "--no-optional-locks",
          "-C",
          treeFolder,
          "cat-file",
          "--batch-check=%(objectname) %(objecttype)",
        ],
        { stdin: Buffer.from("HEAD\nORIG_HEAD\n", "utf8") },
      ),
      readCurrentBranch(runGit, treeFolder),
    ],
    "reading the tree's HEAD",
  );
  const [head, origHead] = objects.stdout.toString("utf8").split("\n").map(parseCommitLine);
  if (head === undefined) {
    throw new Error("git names no commit for the tree's HEAD");
  }
  return { commit: head, branch, origHead };
}

function parseCommitLine(line: string): string | undefined {
  const [objectName = "", objectType] = line.split(" ");
  return objectType === "commit" && OBJECT_ID_PATTERN.test(objectName) ? objectName : undefined;
}

// The commits the saved state names: HEAD, `ORIG_HEAD`, a merge's first `MERGE_HEAD`, and a
// rebase's `onto` and `orig-head`, the last three files in the record whichever ref store it uses.
async function readStatePins(recordFolder: string, head: HeadRefs): Promise<KeptWorktreePins> {
  const pins: Partial<Record<KeptWorktreePinName, string>> = { head: head.commit };
  const read = async (path: string): Promise<string | undefined> => {
    const text = await readOptional(join(recordFolder, path));
    const firstLine = text?.split("\n")[0]?.trim();
    return firstLine !== undefined && OBJECT_ID_PATTERN.test(firstLine) ? firstLine : undefined;
  };
  const assign = (name: KeptWorktreePinName, commit: string | undefined): void => {
    if (commit !== undefined) {
      pins[name] = commit;
    }
  };
  assign("orig-head", head.origHead);
  assign("merge-head", await read("MERGE_HEAD"));
  const rebaseFolder = await readRebaseFolder(recordFolder);
  if (rebaseFolder !== null) {
    assign("rebase-onto", await read(join(rebaseFolder, "onto")));
    assign("rebase-orig-head", await read(join(rebaseFolder, "orig-head")));
  }
  return pins;
}

/** The record's rebase folder, `rebase-merge` or `rebase-apply`, or `null` when no rebase runs. */
export async function readRebaseFolder(recordFolder: string): Promise<string | null> {
  for (const candidate of ["rebase-merge", "rebase-apply"]) {
    if (await pathExists(join(recordFolder, candidate, "head-name"))) {
      return candidate;
    }
  }
  return null;
}

// The branch HEAD names or, in a rebase, the branch being rebased, from the rebase's `head-name`.
async function readKeptBranch(
  recordFolder: string,
  headBranch: string | null,
): Promise<string | null> {
  const rebaseFolder = await readRebaseFolder(recordFolder);
  if (rebaseFolder === null) {
    return headBranch;
  }
  const headName = await readOptional(join(recordFolder, rebaseFolder, "head-name"));
  const match = /^refs\/heads\/(.+)$/m.exec(headName ?? "");
  return match?.[1]?.trim() ?? null;
}

async function writePins(
  runGit: GitCommand,
  canonicalRoot: string,
  removedWorktreeId: string,
  pins: KeptWorktreePins,
): Promise<void> {
  const commands: string[] = [];
  for (const name of KEPT_WORKTREE_PIN_NAMES) {
    const commit = pins[name];
    if (commit !== undefined) {
      commands.push(`create ${pinRefName(removedWorktreeId, name)} ${commit}`);
    }
  }
  // One transaction: every pin lands or none does.
  await runGit(["-C", canonicalRoot, "update-ref", "--no-deref", "--stdin"], {
    stdin: Buffer.from(`start\n${commands.join("\n")}\nprepare\ncommit\n`, "utf8"),
  });
}

async function deletePins(
  runGit: GitCommand,
  canonicalRoot: string,
  removedWorktreeId: string,
): Promise<void> {
  // Every pin name in one transaction, with no read first: deleting a pin never written is no
  // failure, so a second call finishes one that failed part way.
  const commands = KEPT_WORKTREE_PIN_NAMES.map(
    (name) => `delete ${pinRefName(removedWorktreeId, name)}`,
  );
  await runGit(["-C", canonicalRoot, "update-ref", "--no-deref", "--stdin"], {
    stdin: Buffer.from(`start\n${commands.join("\n")}\nprepare\ncommit\n`, "utf8"),
  });
}

function pinRefName(removedWorktreeId: string, name: KeptWorktreePinName): string {
  return `${PIN_REF_PREFIX}/${removedWorktreeId}/${name}`;
}

/**
 * Removes a folder after renaming it under an in-progress copy's name beside it, so a removal cut
 * short leaves a leftover the sweep removes, never part of the folder under its own name.
 */
export async function removeFolderAsLeftover(
  filesystem: Pick<GitFilesystem, "rename" | "removePath">,
  folder: string,
): Promise<void> {
  const leftover = `${folder}${COPY_IN_PROGRESS_INFIX}${mintUuidV7()}`;
  copiesInProgress.add(leftover);
  try {
    await filesystem.rename(folder, leftover);
    await filesystem.removePath(leftover);
  } finally {
    copiesInProgress.delete(leftover);
  }
}

/**
 * Moves a folder by one rename on one volume; across volumes a copy, its progress reported for
 * `copySubject`, then the original removed once the copy is complete, and the complete copy is
 * never deleted. Throws {@link FolderMoveIncompleteError} when the original could not be removed
 * completely, and `refuseHeld`'s error when a program holds a file in it open.
 */
export async function moveFolder(
  tools: FolderMoveTools,
  fromFolder: string,
  toFolder: string,
  copySubject: WorktreeCopySubject,
  refuseHeld: (cause: unknown) => Error,
): Promise<void> {
  const placement = await renameOrCopyFolder(tools, fromFolder, toFolder, copySubject, refuseHeld);
  if (placement === "renamed") {
    return;
  }
  try {
    await tools.filesystem.removePath(fromFolder);
  } catch (removeFailure) {
    throw new FolderMoveIncompleteError(removeFailure);
  }
}

/**
 * Moves a folder by one rename on one volume; across volumes a copy, cloned where the volume can,
 * its progress reported for `copySubject`, the original left in place. The copy takes the real name
 * only once whole; one that fails partway is removed, the original untouched. Answers which it did.
 */
export async function renameOrCopyFolder(
  tools: FolderMoveTools,
  fromFolder: string,
  toFolder: string,
  copySubject: WorktreeCopySubject,
  refuseHeld: (cause: unknown) => Error,
): Promise<"renamed" | "copied"> {
  const { filesystem } = tools;
  try {
    await filesystem.rename(fromFolder, toFolder);
    return "renamed";
  } catch (renameFailure) {
    const code = (renameFailure as NodeJS.ErrnoException).code;
    if (code !== undefined && HELD_FILE_ERROR_CODES.has(code)) {
      throw refuseHeld(renameFailure);
    }
    if (code !== CROSS_VOLUME_ERROR_CODE) {
      throw renameFailure;
    }
  }
  const copyFolder = `${toFolder}${COPY_IN_PROGRESS_INFIX}${mintUuidV7()}`;
  copiesInProgress.add(copyFolder);
  let copyReport: WorktreeCopyReport | undefined;
  try {
    // Progress never costs the move: with no total to report against, the copy runs unreported.
    let fileSizes: ReadonlyMap<string, number> | null;
    try {
      fileSizes = await readFileSizes(fromFolder);
    } catch (walkFailure) {
      tools.copies.logUnmeasuredCopy(copySubject, walkFailure);
      fileSizes = null;
    }
    const sizes = fileSizes ?? new Map<string, number>();
    // The entry the copy is on, which is done once the filter is asked about the next.
    let entryInCopy: { source: string; destination: string } | undefined;
    // What has reached the destination of the file the copy is on; a link or a folder counts 0.
    const readBytesInFlight = async (): Promise<number> => {
      const inCopy = entryInCopy;
      const size = inCopy === undefined ? undefined : sizes.get(inCopy.source);
      if (inCopy === undefined || size === undefined) {
        return 0;
      }
      try {
        // Capped at the walk's size, so a file grown since never passes the total.
        return Math.min((await stat(inCopy.destination)).size, size);
      } catch (statFailure) {
        // The copy has not made the file yet.
        if ((statFailure as NodeJS.ErrnoException).code === "ENOENT") {
          return 0;
        }
        throw statFailure;
      }
    };
    let totalBytes = 0;
    for (const size of sizes.values()) {
      totalBytes += size;
    }
    const report =
      fileSizes === null
        ? undefined
        : tools.copies.begin(copySubject, totalBytes, readBytesInFlight);
    copyReport = report;
    // Counts the entry the copy is on whole, after which no tick reads it again.
    const countEntryDone = (): void => {
      const size = entryInCopy === undefined ? undefined : sizes.get(entryInCopy.source);
      if (size !== undefined) {
        report?.addCopied(size);
      }
      entryInCopy = undefined;
    };
    await cp(fromFolder, copyFolder, {
      recursive: true,
      verbatimSymlinks: true,
      preserveTimestamps: true,
      mode: fsConstants.COPYFILE_FICLONE,
      filter: (source, destination) => {
        countEntryDone();
        entryInCopy = { source, destination };
        return true;
      },
    });
    countEntryDone();
    await filesystem.rename(copyFolder, toFolder);
  } catch (copyFailure) {
    const cleanupFailures: unknown[] = [];
    try {
      await filesystem.removePath(copyFolder);
    } catch (cleanupFailure) {
      cleanupFailures.push(cleanupFailure);
    }
    throw withCleanupFailures(copyFailure, cleanupFailures, "copying the folder");
  } finally {
    copyReport?.end();
    copiesInProgress.delete(copyFolder);
  }
  return "copied";
}

// The size of every regular file under `folder`, by its path as the copy names it; a link and a
// folder are left out, as they copy no file's bytes, and a file gone since the listing counts 0.
// The sizes are read as many at once as the machine has processors.
async function readFileSizes(folder: string): Promise<Map<string, number>> {
  const files = (await readdir(folder, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
  const fileSizes = await mapWithProcessorBound(files, async (path) => {
    try {
      return (await stat(path)).size;
    } catch (statFailure) {
      if ((statFailure as NodeJS.ErrnoException).code === "ENOENT") {
        return 0;
      }
      throw statFailure;
    }
  });
  return new Map(files.map((path, index) => [path, fileSizes[index] ?? 0]));
}

/**
 * The in-progress copies a crash cut short: those in each project folder of `worktreesDirectory`,
 * where a put-back or an undone discard copies a tree, and those in each kept folder under the
 * project's `.removed/`, where a discard or an undone put-back copies one. A copy this process is
 * making now is left out.
 */
export async function listLeftoverCopies(worktreesDirectory: string): Promise<string[]> {
  const leftovers: string[] = [];
  for (const project of await readFolderNamesOptional(worktreesDirectory)) {
    // A slug never starts with a dot, so such a folder is no project's.
    if (project.startsWith(".")) continue;
    const projectFolder = join(worktreesDirectory, project);
    leftovers.push(...(await listLeftoverCopiesIn(projectFolder)));
    const removedFolder = join(projectFolder, REMOVED_WORKTREES_FOLDER_NAME);
    for (const kept of await readFolderNamesOptional(removedFolder)) {
      leftovers.push(...(await listLeftoverCopiesIn(join(removedFolder, kept))));
    }
  }
  return leftovers;
}

async function listLeftoverCopiesIn(folder: string): Promise<string[]> {
  return (await readFolderNamesOptional(folder))
    .filter((name) => COPY_IN_PROGRESS_PATTERN.test(name))
    .map((name) => join(folder, name))
    .filter((copyFolder) => !copiesInProgress.has(copyFolder));
}
