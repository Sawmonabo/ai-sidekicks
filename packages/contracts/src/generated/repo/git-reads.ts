// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The git reads the panes make: the branch list, reading a file's lines by path or by blob, and the signal that a session's working folder changed.

import type { WireInstant } from "../internal/wire-scalars.js";
import type { SessionId } from "../session/id.js";
import type { WorktreeId } from "../worktree/lifecycle.js";
import type { RepoMountId } from "./mount.js";

/**
 * A git object name as git prints it: 40 lower-case hex digits for SHA-1, 64 for SHA-256.
 * Commits and blobs are both named this way.
 */
export type GitObjectId = string & { readonly __brand: "GitObjectId" };
/**
 * Which side of a comparison a gap read is on: a `committed` side is read from git's object
 * store; a `workingTree` side from disk, and only while the file there still has the blob id the
 * diff was read at.
 */
export type ProjectFileSide = "committed" | "workingTree";
/**
 * `project.file.read`: a file in the session's working folder, or the lines inside a collapsed gap
 * of a diff, which names its blob and its side together.
 */
export type ProjectFileReadRequest =
  | {
      /**
       * The session whose working folder is read.
       */
      sessionId: SessionId;
      /**
       * The file, inside the working folder.
       */
      path: string;
      /**
       * The blob the diff gave that side.
       */
      blobId: GitObjectId;
      /**
       * The side.
       */
      side: ProjectFileSide;
      /**
       * The lines to read; absent reads the whole file.
       */
      lines?: ProjectFileLineRange;
    }
  | {
      /**
       * The session whose working folder is read.
       */
      sessionId: SessionId;
      /**
       * The file, inside the working folder.
       */
      path: string;
      /**
       * Only a gap read names a blob.
       */
      blobId?: never;
      /**
       * Only a gap read names a side.
       */
      side?: never;
      /**
       * The lines to read; absent reads the whole file.
       */
      lines?: ProjectFileLineRange;
    };
/**
 * The `project.file.read` result: the lines read; `stale` when the working-tree side no longer
 * holds the blob the diff was read at, so the pane shows its reload mark; `binary` when the file
 * is not text.
 */
export type ProjectFileReadResponse =
  | {
      outcome: "lines";
      /**
       * The file.
       */
      path: string;
      /**
       * The lines.
       */
      lines: string[];
      /**
       * The first line's number, from 1.
       */
      firstLine: number;
      /**
       * How many lines the file has.
       */
      totalLines: number;
    }
  | {
      outcome: "stale";
    }
  | {
      outcome: "binary";
    };
/**
 * How the daemon noticed a working folder change: a file watch, or a slow tick for a folder too
 * large for the machine's watch limit, so a late mark is never read as a tree that did not change.
 */
export type WorkingTreeChangeMode = "watch" | "slowTick";

/**
 * `project.branch.list`: the mount whose branches both base pickers list.
 */
export interface ProjectBranchListRequest {
  /**
   * The mount.
   */
  repoMountId: RepoMountId;
}
/**
 * The worktree that has a branch checked out, which the create form's list grays.
 */
export interface BranchHolder {
  /**
   * Present only for a tree the app made; the main checkout and a tree the person made carry a
   * name alone.
   */
  worktreeId?: WorktreeId;
  /**
   * The tree's name.
   */
  name: string;
}
/**
 * One branch in a base list. `ahead` and `behind` count commits against the branch's upstream and
 * are absent when it has none.
 */
export interface ProjectBranchListEntry {
  /**
   * The branch.
   */
  name: string;
  /**
   * Commits ahead of its upstream.
   */
  ahead?: number;
  /**
   * Commits behind its upstream.
   */
  behind?: number;
  /**
   * The worktree that has it checked out.
   */
  heldBy?: BranchHolder;
}
/**
 * The `project.branch.list` result, in the daemon's one order: the default branch, then the
 * branches this project's last picks came from, most recent first, then the rest by their newest
 * commit.
 */
export interface ProjectBranchListResponse {
  /**
   * The default branch.
   */
  defaultBranch: string;
  /**
   * The branches.
   */
  branches: ProjectBranchListEntry[];
  /**
   * Present when the last background fetch failed: when the figures were last true.
   */
  countsAsOf?: WireInstant;
}
/**
 * The lines a read narrows to: `count` lines from line `from`, counted from 1.
 */
export interface ProjectFileLineRange {
  /**
   * The first line, from 1.
   */
  from: number;
  /**
   * How many lines.
   */
  count: number;
}
/**
 * `session.workingFolder.subscribe`: the session whose working folder the daemon watches.
 */
export interface SessionWorkingFolderSubscribeRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
}
/**
 * One `session.workingFolder.subscribe` emission: the working folder changed at `changedAt`.
 */
export interface WorkingTreeChange {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * When it changed.
   */
  changedAt: WireInstant;
  /**
   * How the daemon noticed.
   */
  mode: WorkingTreeChangeMode;
}

export { validateGitObjectId } from "../checks/repo/git-reads.js";
