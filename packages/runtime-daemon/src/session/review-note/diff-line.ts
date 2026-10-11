// Reads a review note's line from the file on its side of the comparison it was left in, as that
// file reads now in the session's working folder. A note may sit on any line Review draws, context
// lines included, so its line is there while that side's file still has it.
//
// - The uncommitted changes compare `HEAD` with the working tree; an unborn `HEAD` is the empty
//   tree. A working file counts only when git lists it, tracked or untracked and not ignored.
// - The branch compares `HEAD`, and a pull request its head commit, with where it left its base.
// - Each file is read through git, so a symbolic link reads as its target's name and a file git
//   calls binary has no lines. A file too large for git's output bound reads as having none.
//
// The person's diff settings never shape the read: fixed prefixes, no external or text-converting
// driver, no color, no rename pairing.

import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import * as path from "node:path";

import { parsePatch } from "diff";

import type {
  ReviewNoteAddRequest,
  ReviewNoteComparison,
} from "@ai-sidekicks/contracts/review-note";

import {
  GIT_STDIO_MAX_BUFFER_BYTES,
  readGitExitStatus,
  type GitCommand,
  type GitInvocationFailure,
} from "../../git/process.js";

/** The members of a note that name its line in its comparison. */
export type NoteLocation = Pick<
  ReviewNoteAddRequest,
  "comparison" | "path" | "oldPath" | "side" | "line" | "startLine"
>;

// Where a side's file is read from: a commit, or the working tree.
const WORKING_TREE = Symbol("working tree");
type FileSource = string | typeof WORKING_TREE;

// A diff marks every line, so its output can run to twice the file; a quarter of git's output bound
// leaves room for that and the headers.
const MAX_READ_FILE_BYTES = GIT_STDIO_MAX_BUFFER_BYTES / 4;

// Git's exit status for `rev-parse --verify --quiet` and `merge-base` finding no commit, and for
// `diff --no-index` finding a difference.
const NOT_FOUND_EXIT_STATUS = 1;
const DIFFERENCE_EXIT_STATUS = 1;

// A listed file deleted from the working tree, or a folder on its path replaced by a file.
const ABSENT_PATH_ERROR_CODES: ReadonlySet<unknown> = new Set(["ENOENT", "ENOTDIR"]);

// The fixed diff flags every read runs with.
const DIFF_FLAGS = [
  "diff",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--no-renames",
  "--unified=0",
  "--src-prefix=a/",
  "--dst-prefix=b/",
] as const;

/**
 * Reads notes' lines in one working folder, resolving each commit and reading each file once
 * however many notes sit on it. Made for one read of a session's notes, so a later change to the
 * folder is seen by the next reader, never by this one.
 */
export class NotedLineReader {
  readonly #runGit: GitCommand;
  readonly #folder: string;
  readonly #commits = new Map<string, Promise<string | undefined>>();
  readonly #mergeBases = new Map<string, Promise<string | undefined>>();
  readonly #fileLines = new Map<string, Promise<readonly string[] | undefined>>();
  #emptyTree: Promise<string> | undefined;

  constructor(runGit: GitCommand, folder: string) {
    this.#runGit = runGit;
    this.#folder = folder;
  }

  /**
   * The text of `location`'s line in the file on its side of its comparison, or `undefined` when
   * that file or that line is not there now. A range's first line comes at or before its last, so
   * its last line being there means every line of it is. Rejects when git fails otherwise.
   */
  async read(location: NoteLocation): Promise<string | undefined> {
    const source = await this.#sourceOf(location.comparison, location.side);
    if (source === undefined) {
      return undefined;
    }
    const filePath =
      location.side === "removed" ? (location.oldPath ?? location.path) : location.path;
    const lines = await this.#linesOf(source, filePath);
    return lines?.[location.line - 1];
  }

  // The commit or working tree a side reads its file from, or `undefined` when it names no commit.
  async #sourceOf(
    comparison: ReviewNoteComparison,
    side: NoteLocation["side"],
  ): Promise<FileSource | undefined> {
    if (comparison.scope === "changes") {
      return side === "added" ? WORKING_TREE : this.#commitOf("HEAD");
    }
    const headRevision =
      comparison.scope === "change_request" && "headCommitId" in comparison
        ? comparison.headCommitId
        : "HEAD";
    const head = await this.#commitOf(headRevision);
    if (side === "added" || head === undefined) {
      return head;
    }
    const base = await this.#commitOf(comparison.base);
    return base === undefined ? undefined : this.#mergeBaseOf(base, head);
  }

  #linesOf(source: FileSource, filePath: string): Promise<readonly string[] | undefined> {
    const key = `${source === WORKING_TREE ? "" : source}\0${filePath}`;
    let lines = this.#fileLines.get(key);
    if (lines === undefined) {
      lines = isInsideFolder(this.#folder, filePath)
        ? source === WORKING_TREE
          ? this.#readWorkingLines(filePath)
          : this.#readCommittedLines(source, filePath)
        : Promise.resolve(undefined);
      this.#fileLines.set(key, lines);
    }
    return lines;
  }

  async #readCommittedLines(commitId: string, filePath: string): Promise<string[] | undefined> {
    const described = await this.#runGit(
      ["-C", this.#folder, "cat-file", "--batch-check=%(objecttype) %(objectsize)", "-Z"],
      { stdin: Buffer.from(`${commitId}:${filePath}\0`) },
    );
    // A missing path answers `<input> missing`, whose first word is never `blob`.
    const [objectType, objectSize] = described.stdout.toString("utf8").split(/[ \0]/u);
    if (objectType !== "blob" || Number(objectSize) > MAX_READ_FILE_BYTES) {
      return undefined;
    }
    const patch = await this.#runGit([
      "-C",
      this.#folder,
      ...DIFF_FLAGS,
      await this.#emptyTreeId(),
      commitId,
      "--",
      `:(literal)${filePath}`,
    ]);
    return addedLinesOf(patch.stdout);
  }

  async #readWorkingLines(filePath: string): Promise<string[] | undefined> {
    const listed = await this.#runGit([
      "-C",
      this.#folder,
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      `:(literal)${filePath}`,
    ]);
    if (listed.stdout.length === 0) {
      return undefined;
    }
    let stats: Stats;
    try {
      stats = await lstat(path.join(this.#folder, filePath));
    } catch (error) {
      if (error instanceof Error && "code" in error && ABSENT_PATH_ERROR_CODES.has(error.code)) {
        return undefined;
      }
      throw error;
    }
    // A folder (a submodule's checkout) or a special file such as a pipe has no lines to read.
    if (!(stats.isFile() || stats.isSymbolicLink()) || stats.size > MAX_READ_FILE_BYTES) {
      return undefined;
    }
    try {
      await this.#runGit([
        "-C",
        this.#folder,
        ...DIFF_FLAGS,
        "--no-index",
        "--",
        "/dev/null",
        filePath,
      ]);
    } catch (refusal) {
      // A difference is the success case here; a file gone since the check reads as empty output.
      if (readGitExitStatus(refusal) === DIFFERENCE_EXIT_STATUS) {
        return addedLinesOf((refusal as GitInvocationFailure).stdout ?? Buffer.alloc(0));
      }
      throw refusal;
    }
    return [];
  }

  #commitOf(revision: string): Promise<string | undefined> {
    let commit = this.#commits.get(revision);
    if (commit === undefined) {
      commit = this.#readCommitOrNone([
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        `${revision}^{commit}`,
      ]);
      this.#commits.set(revision, commit);
    }
    return commit;
  }

  #mergeBaseOf(base: string, head: string): Promise<string | undefined> {
    const key = `${base}\0${head}`;
    let mergeBase = this.#mergeBases.get(key);
    if (mergeBase === undefined) {
      mergeBase = this.#readCommitOrNone(["merge-base", base, head]);
      this.#mergeBases.set(key, mergeBase);
    }
    return mergeBase;
  }

  // The commit id a command prints, or `undefined` when it exits saying it found none.
  async #readCommitOrNone(argv: readonly string[]): Promise<string | undefined> {
    try {
      return (await this.#runGit(["-C", this.#folder, ...argv])).stdout.toString("utf8").trim();
    } catch (refusal) {
      if (readGitExitStatus(refusal) === NOT_FOUND_EXIT_STATUS) {
        return undefined;
      }
      throw refusal;
    }
  }

  // The repository's empty tree, in its own object format, to diff a committed file against.
  #emptyTreeId(): Promise<string> {
    this.#emptyTree ??= this.#runGit(["-C", this.#folder, "hash-object", "-t", "tree", "--stdin"], {
      stdin: Buffer.alloc(0),
    }).then((hashed) => hashed.stdout.toString("utf8").trim());
    return this.#emptyTree;
  }
}

// Whether `filePath` names a place inside `folder`, so no note reads a file outside it.
function isInsideFolder(folder: string, filePath: string): boolean {
  const relativePath = path.relative(folder, path.resolve(folder, filePath));
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

// The lines of a diff against nothing, which are every line of the file, in order.
function addedLinesOf(patchText: Buffer): string[] {
  const lines: string[] = [];
  for (const patch of parsePatch(patchText.toString("utf8"))) {
    for (const hunk of patch.hunks) {
      for (const hunkLine of hunk.lines) {
        if (hunkLine.startsWith("+")) {
          lines.push(withoutCarriageReturn(hunkLine.slice(1)));
        }
      }
    }
  }
  return lines;
}

function withoutCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}
