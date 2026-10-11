// Reads a review note's line from the diff it points into, as that diff reads now in the session's
// working folder: the uncommitted changes are the working tree against `HEAD`, untracked files
// counted as new; the branch and its pull request are `HEAD` against where it left its base. A
// note's line is in the diff while it is a changed line on its side there, and so is every line of
// its range. The text found is what a new note quotes, and what tells a held note whether its line
// still says what was noted.
//
// The person's diff settings never shape the read: fixed prefixes, no external or text-converting
// driver, no color, and no context lines, since only changed lines count.

import { readFile } from "node:fs/promises";
import * as path from "node:path";

import { parsePatch, type StructuredPatch } from "diff";

import type { ReviewNoteAddRequest } from "@ai-sidekicks/contracts/review-note";

import { readGitExitStatus, type GitCommand } from "../../git/process.js";

/** The members of a note that name its line in its comparison. */
export type NoteLocation = Pick<
  ReviewNoteAddRequest,
  "comparison" | "path" | "oldPath" | "side" | "line" | "startLine"
>;

// One file's changed lines on each side, keyed by line number, counted from 1.
interface ChangedLines {
  readonly removed: ReadonlyMap<number, string>;
  readonly added: ReadonlyMap<number, string>;
}

const NO_CHANGED_LINES: ChangedLines = { removed: new Map(), added: new Map() };

// Git's exit status for `rev-parse --verify --quiet` naming no commit.
const REVISION_MISSING_EXIT_STATUS = 1;

/**
 * Reads notes' lines in one working folder, reading each file's diff once however many notes sit
 * on it. Made for one read of a session's notes, so a later change to the folder is seen by the
 * next reader, never by this one.
 */
export class NotedLineReader {
  readonly #runGit: GitCommand;
  readonly #folder: string;
  readonly #changedLinesByFile = new Map<string, Promise<ChangedLines>>();

  constructor(runGit: GitCommand, folder: string) {
    this.#runGit = runGit;
    this.#folder = folder;
  }

  /**
   * The text of `location`'s line on its side of its comparison's diff, or `undefined` when that
   * line or any line of its range is not a changed line there, or the comparison's base names no
   * commit any more. Rejects when git fails otherwise.
   */
  async read(location: NoteLocation): Promise<string | undefined> {
    const changedLines = (await this.#changedLinesOf(location))[location.side];
    for (let line = location.startLine ?? location.line; line < location.line; line += 1) {
      if (!changedLines.has(line)) {
        return undefined;
      }
    }
    return changedLines.get(location.line);
  }

  #changedLinesOf(location: NoteLocation): Promise<ChangedLines> {
    const { comparison } = location;
    const revision = comparison.scope === "changes" ? "HEAD" : `${comparison.base}...HEAD`;
    const key = [revision, location.oldPath ?? "", location.path].join("\0");
    let changedLines = this.#changedLinesByFile.get(key);
    if (changedLines === undefined) {
      changedLines = this.#readChangedLines(location, revision);
      this.#changedLinesByFile.set(key, changedLines);
    }
    return changedLines;
  }

  async #readChangedLines(location: NoteLocation, revision: string): Promise<ChangedLines> {
    const { comparison } = location;
    const base = comparison.scope === "changes" ? "HEAD" : comparison.base;
    if (!(await this.#isCommit(base))) {
      return NO_CHANGED_LINES;
    }
    const pathspecs = [location.oldPath, location.path]
      .filter((notedPath) => notedPath !== undefined)
      .map((notedPath) => `:(literal)${notedPath}`);
    const patchText = (
      await this.#runGit([
        "-C",
        this.#folder,
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--find-renames",
        "--unified=0",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--end-of-options",
        revision,
        "--",
        ...pathspecs,
      ])
    ).stdout.toString("utf8");
    // A rename git did not pair is two patches: the old file's removed lines are in one, the new
    // file's added lines in the other.
    const patches = parsePatch(patchText);
    const oldFilePatch = patches.find(
      (patch) => patch.oldFileName === `a/${location.oldPath ?? location.path}`,
    );
    const newFilePatch = patches.find((patch) => patch.newFileName === `b/${location.path}`);
    let added: ReadonlyMap<number, string> = new Map();
    if (newFilePatch !== undefined) {
      added = changedLinesOn(newFilePatch, "+");
    } else if (comparison.scope === "changes" && (await this.#isUntracked(location.path))) {
      added = await this.#readAllLines(location.path);
    }
    return {
      removed: oldFilePatch === undefined ? new Map() : changedLinesOn(oldFilePatch, "-"),
      added,
    };
  }

  async #isCommit(revision: string): Promise<boolean> {
    try {
      await this.#runGit([
        "-C",
        this.#folder,
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        `${revision}^{commit}`,
      ]);
      return true;
    } catch (refusal) {
      if (readGitExitStatus(refusal) === REVISION_MISSING_EXIT_STATUS) {
        return false;
      }
      throw refusal;
    }
  }

  async #isUntracked(filePath: string): Promise<boolean> {
    const listed = await this.#runGit([
      "-C",
      this.#folder,
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      `:(literal)${filePath}`,
    ]);
    return listed.stdout.length > 0;
  }

  // Every line of a new file is an added one.
  async #readAllLines(filePath: string): Promise<ReadonlyMap<number, string>> {
    const text = await readFile(path.join(this.#folder, filePath), "utf8");
    const lines = text.split("\n");
    if (lines.at(-1) === "") {
      lines.pop();
    }
    return new Map(lines.map((line, index) => [index + 1, withoutCarriageReturn(line)]));
  }
}

// The lines of `patch` that carry `marker`, by their line number on that side.
function changedLinesOn(patch: StructuredPatch, marker: "-" | "+"): ReadonlyMap<number, string> {
  const changedLines = new Map<number, string>();
  for (const hunk of patch.hunks) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const hunkLine of hunk.lines) {
      if (hunkLine.startsWith("-")) {
        if (marker === "-") changedLines.set(oldLine, withoutCarriageReturn(hunkLine.slice(1)));
        oldLine += 1;
      } else if (hunkLine.startsWith("+")) {
        if (marker === "+") changedLines.set(newLine, withoutCarriageReturn(hunkLine.slice(1)));
        newLine += 1;
      }
    }
  }
  return changedLines;
}

function withoutCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}
