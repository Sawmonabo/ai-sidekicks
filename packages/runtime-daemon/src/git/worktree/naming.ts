// How a worktree is named: its branch from the machine's or the project's branch-name pattern, and
// its flat folder `<worktrees>/<project slug>/<session-short-id>-<tail>/`. The worktree creator
// names the tree it creates and the create form's suggestion through the one plan built here, so
// the form never shows a name or a path the daemon would not make. Git's own refusal of a taken
// branch name is read here too, for every caller that makes a branch.

import { join } from "node:path";

import { DAEMON_DATA_FOLDER_NAME } from "@ai-sidekicks/contracts/daemon/data";
import { BRANCH_NAME_TITLE_PLACEHOLDER } from "@ai-sidekicks/contracts/machine-settings";
import type { NewWorktreeSuggestion } from "@ai-sidekicks/contracts/worktree/lifecycle";

import { firstWordsOf } from "../../session/auto-title.js";
import { fillBranchNamePattern } from "../branch-name-pattern.js";
import { WorktreeCreateFailedError } from "./errors.js";

const WORKTREES_FOLDER_NAME = "worktrees";

/**
 * Git's lines refusing a branch name as taken, printed under `LC_ALL=C`: a branch that exists, and
 * a branch that would hold or sit inside one that exists. They name refs only.
 */
export const GIT_TAKEN_BRANCH_NAME_PATTERNS: readonly RegExp[] = [
  /^fatal: a branch named '.*' already exists$/,
  /^fatal: cannot lock ref 'refs\/heads\/.*': 'refs\/heads\/.*' exists; cannot create 'refs\/heads\/.*'$/,
];

/** The first line of a rejected git call's `stderr` that one of `patterns` matches, else `null`. */
export function readGitRefusalLine(thrown: unknown, patterns: readonly RegExp[]): string | null {
  if (typeof thrown !== "object" || thrown === null || !("stderr" in thrown)) {
    return null;
  }
  const stderr: unknown = thrown.stderr;
  if (typeof stderr !== "string") {
    return null;
  }
  return stderr.split("\n").find((line) => patterns.some((pattern) => pattern.test(line))) ?? null;
}

/**
 * The folder in each project's worktrees folder that holds its kept worktrees. A slug never starts
 * with a dot, so it cannot be a project's folder.
 */
export const REMOVED_WORKTREES_FOLDER_NAME = ".removed";

/** The daemon's worktrees folder in the data folder inside `homeDirectory`. */
export function worktreesDirectoryOf(homeDirectory: string): string {
  return join(homeDirectory, DAEMON_DATA_FOLDER_NAME, WORKTREES_FOLDER_NAME);
}

const SHORT_ID_LENGTH = 8;

// The longest tail in UTF-8 bytes, its collision suffix included: the file system's 255-byte name
// limit (APFS, ext4), less the folder's `<8hex>-` prefix.
const TAIL_MAX_BYTES = 255 - (SHORT_ID_LENGTH + 1);

/** The last 8 hex characters of an id, hyphens stripped: a v7 id's random tail. */
export function shortIdOf(identifier: string): string {
  return identifier.replace(/-/g, "").slice(-SHORT_ID_LENGTH).toLowerCase();
}

/**
 * A tail shaped as it is typed: lowercased, every character outside `a-z 0-9 . _ -` turned into a
 * hyphen, and any leading `.`, `_` or `-` dropped, so it is empty or starts with a letter or digit.
 */
function shapeTypedTail(typed: string): string {
  return typed
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/^[._-]+/, "");
}

// Trailing `-`, `.` and `.lock`, which git refuses at a name's end, trimmed until none is left.
function trimTailEnd(tail: string): string {
  let trimmed = tail;
  for (;;) {
    const next = trimmed.replace(/[-.]+$/, "").replace(/\.lock$/, "");
    if (next === trimmed) {
      return trimmed;
    }
    trimmed = next;
  }
}

// Cut at the last hyphen within `maxBytes`; a single word longer than that is cut at the last
// whole code point that fits.
function cutAtWordBreak(tail: string, maxBytes: number): string {
  let clipped = "";
  let byteCount = 0;
  for (const codePoint of tail) {
    byteCount += Buffer.byteLength(codePoint, "utf8");
    if (byteCount > maxBytes) {
      break;
    }
    clipped += codePoint;
  }
  if (clipped.length === tail.length || tail.charAt(clipped.length) === "-") {
    return clipped;
  }
  const lastBreak = clipped.lastIndexOf("-");
  return lastBreak <= 0 ? clipped : clipped.slice(0, lastBreak);
}

// A tail with its collision suffix, the tail cut first so both fit the folder name's tail bound.
function withSuffix(tail: string, suffix: string): string {
  const tailMaxBytes = TAIL_MAX_BYTES - Buffer.byteLength(suffix, "utf8");
  if (Buffer.byteLength(tail, "utf8") <= tailMaxBytes) {
    return `${tail}${suffix}`;
  }
  return `${trimTailEnd(cutAtWordBreak(tail, tailMaxBytes))}${suffix}`;
}

/**
 * The tail a title gives: shaped as typed, repeated `-` and `.` collapsed, a trailing `-`, `.` or
 * `.lock` trimmed, cut at a word break within 246 UTF-8 bytes, so the folder's name stays within
 * the file system's limit; a collision suffix cuts it further. Empty when no usable words remain.
 */
function deriveTitleTail(title: string): string {
  const collapsed = shapeTypedTail(title)
    .replace(/-{2,}/g, "-")
    .replace(/\.{2,}/g, ".");
  return trimTailEnd(cutAtWordBreak(trimTailEnd(collapsed), TAIL_MAX_BYTES));
}

/** Where a session's tail comes from: its title, else its provisional title. */
export interface SessionTitleSource {
  /** The session's title; `null` while untitled. */
  readonly name: string | null;
  /** The first user message's opening, the provisional title's source; `null` before one. */
  readonly firstMessagePreview: string | null;
}

/**
 * The tail a session's title suggests: its title, or before it has one the first words of its first
 * message through the function the session's own naming uses. `fallbackMessage` stands in for a
 * first message not yet recorded on the session. Empty when no usable words remain.
 */
export function suggestTailFor(
  source: SessionTitleSource,
  fallbackMessage: string | null = null,
): string {
  if (source.name !== null) {
    return deriveTitleTail(source.name);
  }
  const message = source.firstMessagePreview ?? fallbackMessage;
  return message === null ? "" : deriveTitleTail(firstWordsOf(message));
}

/**
 * The tail a run's tree takes when no title gives one: `run-<run-short-id>`. Throws
 * `branch_name_underivable` when there is no run either.
 */
export function deriveRunTail(titleTail: string, runId: string | null): string {
  if (titleTail.length > 0) {
    return titleTail;
  }
  if (runId === null || runId.length === 0) {
    throw new WorktreeCreateFailedError("branch_name_underivable");
  }
  return `run-${shortIdOf(runId)}`;
}

/** A project's naming facts: its slug, fixed at attach, and its own branch pattern if set. */
export interface WorktreeProjectNaming {
  readonly slug: string;
  /** `null` follows the machine's pattern. */
  readonly branchPattern: string | null;
}

/** Where the naming reads what other owners keep: the project record and the machine's settings. */
export interface WorktreeNamingSources {
  /** The project an attached mount serves; throws when the mount serves none. */
  readProjectNaming(repoMountId: string): Promise<WorktreeProjectNaming>;
  /** The machine's `Branch names` pattern. */
  readMachineBranchPattern(): Promise<string>;
}

/** One candidate name: the whole branch, the tree's folder, and the tail both were made from. */
export interface WorktreeName {
  readonly branchName: string;
  readonly folderPath: string;
  readonly tail: string;
}

/**
 * The names one tree can take, in collision order: ordinal 1 is the name itself, and ordinal `n`
 * puts `-n` on the tail, so the branch and the folder stay in step. A tail too long to take its
 * suffix within the folder name's limit is cut first.
 */
export class WorktreeNamePlan {
  readonly #pattern: string;
  readonly #sessionShortId: string;
  readonly #projectFolder: string;
  /** The tail, or `null` for a supplied branch name the pattern did not make. */
  readonly #tail: string | null;
  readonly #suppliedBranchName: string | null;
  readonly #folderTail: string;

  private constructor(fields: {
    readonly pattern: string;
    readonly sessionShortId: string;
    readonly projectFolder: string;
    readonly tail: string | null;
    readonly suppliedBranchName: string | null;
    readonly folderTail: string;
  }) {
    this.#pattern = fields.pattern;
    this.#sessionShortId = fields.sessionShortId;
    this.#projectFolder = fields.projectFolder;
    this.#tail = fields.tail;
    this.#suppliedBranchName = fields.suppliedBranchName;
    this.#folderTail = fields.folderTail;
  }

  /** The plan for a tail the pattern fills in. */
  static forTail(base: WorktreeNameBase, tail: string): WorktreeNamePlan {
    return new WorktreeNamePlan({ ...base, tail, suppliedBranchName: null, folderTail: tail });
  }

  /**
   * The plan for a whole branch name a caller supplied: the tail is what the pattern's fixed parts
   * leave of it, and a name the pattern did not make keeps its spelling while its folder takes the
   * name shaped as typed.
   */
  static forBranchName(base: WorktreeNameBase, branchName: string): WorktreeNamePlan {
    const [before, after] = splitPattern(base.pattern, base.sessionShortId);
    const middle =
      branchName.length > before.length + after.length &&
      branchName.startsWith(before) &&
      branchName.endsWith(after)
        ? branchName.slice(before.length, branchName.length - after.length)
        : null;
    if (middle !== null && shapeTypedTail(middle) === middle) {
      return WorktreeNamePlan.forTail(base, middle);
    }
    return new WorktreeNamePlan({
      ...base,
      tail: null,
      suppliedBranchName: branchName,
      folderTail: shapeTypedTail(branchName),
    });
  }

  /** The name at `ordinal`, 1 for the name itself. */
  nameAt(ordinal: number): WorktreeName {
    const suffix = ordinal === 1 ? "" : `-${ordinal}`;
    const folderPath = join(
      this.#projectFolder,
      `${this.#sessionShortId}-${withSuffix(this.#folderTail, suffix)}`,
    );
    if (this.#tail === null) {
      return { branchName: `${this.#suppliedBranchName ?? ""}${suffix}`, folderPath, tail: "" };
    }
    const tail = withSuffix(this.#tail, suffix);
    return {
      branchName: fillBranchNamePattern(this.#pattern, {
        title: tail,
        session: this.#sessionShortId,
      }),
      folderPath,
      tail,
    };
  }

  /**
   * The create form's parts: the branch's fixed part before the tail, the tail at `ordinal`, and
   * the folder up to that tail.
   */
  describeAt(ordinal: number): NewWorktreeSuggestion {
    const [fixedPart] = splitPattern(this.#pattern, this.#sessionShortId);
    return {
      fixedPart,
      suggestedTail: this.nameAt(ordinal).tail,
      folderBefore: join(this.#projectFolder, `${this.#sessionShortId}-`),
    };
  }
}

/** What every plan for one session's tree on one project shares. */
export interface WorktreeNameBase {
  readonly pattern: string;
  readonly sessionShortId: string;
  readonly projectFolder: string;
}

// The pattern's text before and after `{title}`, each with `{session}` filled in.
function splitPattern(pattern: string, sessionShortId: string): readonly [string, string] {
  const titleAt = pattern.indexOf(BRANCH_NAME_TITLE_PLACEHOLDER);
  const fill = (part: string): string =>
    fillBranchNamePattern(part, { title: "", session: sessionShortId });
  return [
    fill(pattern.slice(0, titleAt)),
    fill(pattern.slice(titleAt + BRANCH_NAME_TITLE_PLACEHOLDER.length)),
  ];
}

/** Builds name plans from the project's and the machine's patterns. */
export class WorktreeNaming {
  /** The daemon's worktrees folder, holding one folder per project. */
  readonly worktreesDirectory: string;
  readonly #sources: WorktreeNamingSources;

  constructor(deps: {
    readonly worktreesDirectory: string;
    readonly sources: WorktreeNamingSources;
  }) {
    this.worktreesDirectory = deps.worktreesDirectory;
    this.#sources = deps.sources;
  }

  /** The folder the project's worktrees live in, and its kept ones under `.removed/`. */
  async projectFolderOf(repoMountId: string): Promise<string> {
    const project = await this.#sources.readProjectNaming(repoMountId);
    return join(this.worktreesDirectory, project.slug);
  }

  /** The base every plan for a tree of `sessionId` on the mount's project starts from. */
  async baseFor(repoMountId: string, sessionId: string): Promise<WorktreeNameBase> {
    const project = await this.#sources.readProjectNaming(repoMountId);
    const pattern = project.branchPattern ?? (await this.#sources.readMachineBranchPattern());
    return {
      pattern,
      sessionShortId: shortIdOf(sessionId),
      projectFolder: join(this.worktreesDirectory, project.slug),
    };
  }
}
