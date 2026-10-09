// The git reads behind the switcher's rows, the branch list, the working-folder watch and Put back:
// the trees git lists for a repository, each branch's distance from its upstream, refs' commits
// and a branch's holding tree, the paths a tree has uncommitted, the branch a folder is on, its
// own git folder, a linked tree's record and the record a `.git` file names. Every answer but the
// last is git's own, from `worktree list`, `for-each-ref`, `status` and `rev-parse`; the last
// reads the `.git` file itself, so it answers even when the record it names is gone.
//
// Each git read passes `--no-optional-locks`, so a background read never rewrites the index under
// a run working in the same tree.

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { canonicalFolderPath } from "../../workspace/folder/canonical-path.js";
import { readGitExitStatus, type GitCommand } from "../process.js";

/** The prefix of every local branch's full ref name. */
export const BRANCH_REF_PREFIX = "refs/heads/";
const REMOTE_REF_PREFIX = "refs/remotes/";
const REMOTE_HEAD_SUFFIX = "/HEAD";
// The remote git's own `clone` names, preferred when several remotes name a default branch.
const CLONE_REMOTE_NAME = "origin";

/** One record `git worktree list` prints for a repository. */
export interface ListedWorktree {
  /** The tree's folder as git records it, not resolved. */
  readonly path: string;
  /** The branch it has checked out, or `null` while its HEAD is detached. */
  readonly branchName: string | null;
  /** The commit its HEAD names; `null` on a branch with no commit yet, and on a bare entry. */
  readonly headCommit: string | null;
  /** The repository's own checkout: git's first record, when that record has a working folder. */
  readonly isMainCheckout: boolean;
  /** A bare repository's own record, which has no working folder. */
  readonly isBare: boolean;
  /** Git can no longer find the folder, so it would prune the record. */
  readonly isPrunable: boolean;
  /** Whether the record is locked against pruning and moving. */
  readonly isLocked: boolean;
  /** The reason the lock gives, or `null` for a lock without one and an unlocked record. */
  readonly lockReason: string | null;
}

/** One local branch with the facts the branch list and the switcher draw. */
export interface BranchFigures {
  readonly name: string;
  /** Commits ahead of and behind its upstream; `null` when it has none or the upstream is gone. */
  readonly ahead: number | null;
  readonly behind: number | null;
  /** When its newest commit was made, in seconds since the epoch. */
  readonly newestCommitSeconds: number;
  /** The folder of the tree that has it checked out, or `null` when none has. */
  readonly checkedOutAt: string | null;
}

/**
 * Lists every record git keeps of a tree for the repository at `repositoryRoot`, in git's order,
 * a bare repository's own record included. Paths are as git recorded them, unquoted; a caller
 * resolves them.
 */
export async function readListedWorktrees(
  git: GitCommand,
  repositoryRoot: string,
): Promise<ListedWorktree[]> {
  // Newline-separated: `-z` needs git 2.36, above the oldest git the daemon runs on.
  const { stdout } = await git([
    "--no-optional-locks",
    "-C",
    repositoryRoot,
    "worktree",
    "list",
    "--porcelain",
  ]);
  const worktrees: ListedWorktree[] = [];
  // Records are runs of lines, each run ended by an empty line.
  let fields: string[] = [];
  for (const line of stdout.toString("utf8").split("\n")) {
    if (line.length > 0) {
      fields.push(line);
      continue;
    }
    if (fields.length > 0) {
      worktrees.push(parseWorktreeRecord(fields, worktrees.length === 0));
      fields = [];
    }
  }
  if (fields.length > 0) {
    worktrees.push(parseWorktreeRecord(fields, worktrees.length === 0));
  }
  return worktrees;
}

function parseWorktreeRecord(fields: readonly string[], isFirst: boolean): ListedWorktree {
  let path: string | null = null;
  let branchName: string | null = null;
  let headCommit: string | null = null;
  let isBare = false;
  let isPrunable = false;
  let isLocked = false;
  let lockReason: string | null = null;
  for (const field of fields) {
    const [label = "", ...rest] = field.split(" ");
    const value = rest.join(" ");
    if (label === "worktree") {
      path = unquoteGitText(value);
    } else if (label === "HEAD") {
      // An unborn branch prints the all-zero name.
      headCommit = /^0+$/u.test(value) ? null : value;
    } else if (label === "branch") {
      branchName = value.startsWith(BRANCH_REF_PREFIX)
        ? value.slice(BRANCH_REF_PREFIX.length)
        : value;
    } else if (label === "bare") {
      isBare = true;
    } else if (label === "prunable") {
      isPrunable = true;
    } else if (label === "locked") {
      isLocked = true;
      lockReason = rest.length === 0 ? null : unquoteGitText(value);
    }
  }
  if (path === null) {
    throw new Error("git worktree list printed a record without its folder");
  }
  return {
    path,
    branchName,
    headCommit,
    isMainCheckout: isFirst && !isBare,
    isBare,
    isPrunable,
    isLocked,
    lockReason,
  };
}

// The byte each of git's backslash escapes stands for.
const GIT_QUOTE_ESCAPES: ReadonlyMap<string, number> = new Map([
  ["a", 0x07],
  ["b", 0x08],
  ["t", 0x09],
  ["n", 0x0a],
  ["v", 0x0b],
  ["f", 0x0c],
  ["r", 0x0d],
  ['"', 0x22],
  ["\\", 0x5c],
]);
const BACKSLASH_BYTE = 0x5c;
const OCTAL_ESCAPE_LENGTH = 3;

/**
 * A value git printed C-quoted when it needed quoting (`"a\"b\303\251"` reads `a"bé`): a
 * backslash escape for a quote, a backslash and the control characters, three octal digits for any
 * other byte. A value not wrapped in quotes is git's as it stands; older gits never quote.
 */
function unquoteGitText(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) {
    return value;
  }
  // Read as bytes: an octal escape is one byte of a UTF-8 name, and a backslash byte never sits
  // inside a multi-byte character.
  const quoted = Buffer.from(value.slice(1, -1), "utf8");
  const bytes: number[] = [];
  for (let index = 0; index < quoted.length; index += 1) {
    const byte = quoted[index] ?? 0;
    if (byte !== BACKSLASH_BYTE) {
      bytes.push(byte);
      continue;
    }
    const escape = String.fromCharCode(quoted[index + 1] ?? 0);
    if (/[0-7]/u.test(escape)) {
      const octal = quoted.subarray(index + 1, index + 1 + OCTAL_ESCAPE_LENGTH).toString("latin1");
      bytes.push(Number.parseInt(octal, 8));
      index += OCTAL_ESCAPE_LENGTH;
      continue;
    }
    const escaped = GIT_QUOTE_ESCAPES.get(escape);
    if (escaped === undefined) {
      throw new Error("git printed a quoted value with an escape it never writes");
    }
    bytes.push(escaped);
    index += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Reads every local branch with its upstream distance, newest commit and holding tree. */
export async function readBranchFigures(
  git: GitCommand,
  repositoryRoot: string,
): Promise<BranchFigures[]> {
  // Each record's fields end in NUL and the record in a second NUL before git's newline, so a
  // folder name holding a newline cannot split a record.
  const { stdout } = await git([
    "--no-optional-locks",
    "-C",
    repositoryRoot,
    "for-each-ref",
    "--format=%(refname)%00%(upstream)%00%(upstream:track,nobracket)%00" +
      "%(committerdate:unix)%00%(worktreepath)%00",
    BRANCH_REF_PREFIX,
  ]);
  const branches: BranchFigures[] = [];
  for (const record of stdout.toString("utf8").split("\0\n")) {
    if (record.length === 0) {
      continue;
    }
    const [refName = "", upstream = "", track = "", committedAt = "", checkedOutAt = ""] =
      record.split("\0");
    const distance = upstream.length === 0 ? null : parseUpstreamTrack(track);
    branches.push({
      name: refName.slice(BRANCH_REF_PREFIX.length),
      ahead: distance?.ahead ?? null,
      behind: distance?.behind ?? null,
      newestCommitSeconds: Number(committedAt),
      checkedOutAt: checkedOutAt.length === 0 ? null : checkedOutAt,
    });
  }
  return branches;
}

/** A ref's commit and, for a branch, the tree git lists with it checked out. */
export interface RefHead {
  readonly commit: string;
  /** The folder of a tree git lists with the branch checked out, or `null` when none has. */
  readonly checkedOutAt: string | null;
}

/**
 * Reads, in one git call, the commit and holding tree of each of `refNames` (full names) that
 * exists, by full name; a ref that does not exist has no entry.
 */
export async function readRefHeads(
  git: GitCommand,
  repositoryFolder: string,
  refNames: readonly string[],
): Promise<ReadonlyMap<string, RefHead>> {
  const { stdout } = await git([
    "--no-optional-locks",
    "-C",
    repositoryFolder,
    "for-each-ref",
    "--format=%(refname)%00%(objectname)%00%(worktreepath)%00",
    ...refNames,
  ]);
  const heads = new Map<string, RefHead>();
  // A pattern also matches the refs below it, so only the names asked for are kept.
  for (const record of stdout.toString("utf8").split("\0\n")) {
    const [refName = "", commit = "", checkedOutAt = ""] = record.split("\0");
    if (refNames.includes(refName)) {
      heads.set(refName, { commit, checkedOutAt: checkedOutAt.length === 0 ? null : checkedOutAt });
    }
  }
  return heads;
}

/** Whether the repository at `repositoryFolder` has a local branch named `branch`. */
export async function hasBranch(
  git: GitCommand,
  repositoryFolder: string,
  branch: string,
): Promise<boolean> {
  const refName = `${BRANCH_REF_PREFIX}${branch}`;
  return (await readRefHeads(git, repositoryFolder, [refName])).has(refName);
}

// `upstream:track,nobracket` prints `ahead 2, behind 1`, either half alone, nothing when the two
// are level, or `gone` when the upstream branch no longer exists.
function parseUpstreamTrack(track: string): { ahead: number; behind: number } | null {
  if (track === "gone") {
    return null;
  }
  return {
    ahead: Number(/ahead (\d+)/u.exec(track)?.[1] ?? 0),
    behind: Number(/behind (\d+)/u.exec(track)?.[1] ?? 0),
  };
}

/**
 * Names the repository's default branch: the branch a remote's HEAD names, the clone's own
 * remote first. Returns `null` when no remote names one.
 */
export async function readRemoteDefaultBranch(
  git: GitCommand,
  repositoryRoot: string,
): Promise<string | null> {
  const { stdout } = await git([
    "--no-optional-locks",
    "-C",
    repositoryRoot,
    "for-each-ref",
    "--format=%(refname)%00%(symref)",
    REMOTE_REF_PREFIX,
  ]);
  const defaults = new Map<string, string>();
  for (const line of stdout.toString("utf8").split("\n")) {
    const [refName = "", target = ""] = line.split("\0");
    if (!refName.endsWith(REMOTE_HEAD_SUFFIX) || target.length === 0) {
      continue;
    }
    const remotePrefix = refName.slice(0, -"HEAD".length);
    if (!target.startsWith(remotePrefix)) {
      continue;
    }
    const remoteName = refName.slice(REMOTE_REF_PREFIX.length, -REMOTE_HEAD_SUFFIX.length);
    defaults.set(remoteName, target.slice(remotePrefix.length));
  }
  return defaults.get(CLONE_REMOTE_NAME) ?? defaults.values().next().value ?? null;
}

/**
 * Lists the paths `git status` reports in `folder`, relative to it: changed, staged, unmerged and
 * untracked files, each untracked file named on its own; ignored files are not listed.
 */
export async function readUncommittedPaths(git: GitCommand, folder: string): Promise<string[]> {
  const { stdout } = await git([
    "--no-optional-locks",
    "-C",
    folder,
    "status",
    "--porcelain=v2",
    "-z",
    "--untracked-files=all",
  ]);
  const paths: string[] = [];
  const fields = stdout.toString("utf8").split("\0");
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] ?? "";
    // `1` ordinary, `2` renamed or copied (its original path follows in the next field),
    // `u` unmerged, `?` untracked; the path is the last space-separated part.
    const kind = field[0];
    if (kind === "1" || kind === "u") {
      paths.push(
        field
          .split(" ")
          .slice(kind === "1" ? 8 : 10)
          .join(" "),
      );
    } else if (kind === "2") {
      paths.push(field.split(" ").slice(9).join(" "));
      index += 1;
    } else if (kind === "?") {
      paths.push(field.slice(2));
    }
  }
  return paths;
}

/** The branch `folder` has checked out, or `null` while its HEAD is detached or names no branch. */
export async function readCurrentBranch(git: GitCommand, folder: string): Promise<string | null> {
  try {
    // The full name, since `--short` prints `heads/<name>` for a branch a tag shares a name with.
    const { stdout } = await git([
      "--no-optional-locks",
      "-C",
      folder,
      "symbolic-ref",
      "--quiet",
      "HEAD",
    ]);
    const refName = stdout.toString("utf8").trim();
    return refName.startsWith(BRANCH_REF_PREFIX) ? refName.slice(BRANCH_REF_PREFIX.length) : null;
  } catch (error) {
    // `--quiet` makes a detached HEAD exit 1 with nothing printed; anything else is a failure.
    if (readGitExitStatus(error) === 1) {
      return null;
    }
    throw error;
  }
}

/**
 * The folder that holds `folder`'s own HEAD and index: the checkout's git folder, or for a linked
 * tree its record inside the repository's.
 */
export async function readTreeGitFolder(git: GitCommand, folder: string): Promise<string> {
  const { stdout } = await git([
    "--no-optional-locks",
    "-C",
    folder,
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "HEAD",
  ]);
  return dirname(stdout.toString("utf8").trim());
}

// Git's exit status when the folder it was asked from is in no repository.
const NOT_A_REPOSITORY_EXIT_STATUS = 128;
/** The folder in a repository's git common folder that holds a record per linked tree. */
export const LINKED_RECORDS_FOLDER_NAME = "worktrees";

/** The git common folder that holds `recordFolder`, a linked tree's `<common>/worktrees/<name>`. */
export function commonFolderOfRecord(recordFolder: string): string {
  return dirname(dirname(recordFolder));
}

/**
 * The record git keeps of the linked tree at `treeFolder`, `<common folder>/worktrees/<name>`, as
 * git names it from inside the tree; `null` when git answers that the folder is in no repository,
 * when the folder is not a working tree's top level (its `.git` is gone and git answered for a tree
 * around it), or when its git folder is not a linked tree's record (a main checkout's own `.git`),
 * so a caller removing the record can never reach anything else.
 */
export async function readLinkedTreeRecord(
  git: GitCommand,
  treeFolder: string,
): Promise<string | null> {
  let output: string;
  try {
    const { stdout } = await git([
      "--no-optional-locks",
      "-C",
      treeFolder,
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
      "--git-common-dir",
      "--show-toplevel",
    ]);
    output = stdout.toString("utf8");
  } catch (error) {
    if (readGitExitStatus(error) === NOT_A_REPOSITORY_EXIT_STATUS) {
      return null;
    }
    throw error;
  }
  const [recordFolder, commonFolder, topLevel, ...rest] = output.split("\n");
  const isThreeFolders =
    recordFolder !== undefined &&
    commonFolder !== undefined &&
    topLevel !== undefined &&
    rest.every((line) => line === "");
  if (!isThreeFolders) {
    throw new Error("git rev-parse printed something other than three folders");
  }
  if ((await canonicalFolderPath(topLevel)) !== (await canonicalFolderPath(treeFolder))) {
    return null;
  }
  return dirname(recordFolder) === join(commonFolder, LINKED_RECORDS_FOLDER_NAME)
    ? recordFolder
    : null;
}

/**
 * The record a `.git` file names, resolved from the file's folder; `undefined` for a missing
 * `.git`, a checkout's own `.git` folder, or a file that names none.
 */
export async function readRecordNamedBy(gitFile: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(gitFile, "utf8");
  } catch (readFailure) {
    const code = (readFailure as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") {
      return undefined;
    }
    throw readFailure;
  }
  const named = /^gitdir: (.+)$/m.exec(text)?.[1]?.trim();
  return named === undefined ? undefined : resolve(dirname(gitFile), named);
}
