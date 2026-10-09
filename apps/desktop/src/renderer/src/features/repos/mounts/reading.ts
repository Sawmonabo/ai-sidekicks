// What the repos section renders from, declared apart from the reader that publishes it, so a
// card names the value without importing the reader's class.
// `not-read` and an empty list are different facts: `status` says whether a read was made.

import type { RepoMountReadResponse } from "@ai-sidekicks/contracts/repo/folders";
import type { WorkspaceListResponse } from "@ai-sidekicks/contracts/repo/workspace";
import type { WorktreeStatusRecord } from "@ai-sidekicks/contracts/worktree/lifecycle";

/** One workspace row, exactly as `WorkspaceListResponse` spells it. */
export type RepoWorkspaceRow = WorkspaceListResponse["workspaces"][number];

/**
 * Everything the section renders from, in one immutable value.
 *
 * `status` is the read's own position: `not-read` before the first read, `reading` while
 * one is in flight, `read` afterwards.
 */
export interface RepoMountsReading {
  readonly status: "not-read" | "reading" | "read";
  readonly mounts: readonly RepoMountReadResponse[];
  readonly workspaces: readonly RepoWorkspaceRow[];
  /** The worktrees of every project this session's mounts belong to, project by project. */
  readonly worktrees: readonly WorktreeStatusRecord[];
  /** The instant this reading was taken, on the reader's own clock; zero before the first read. */
  readonly readAtMilliseconds: number;
}

/** The reading before anything has been asked. */
export const REPO_MOUNTS_NOT_READ: RepoMountsReading = {
  status: "not-read",
  mounts: [],
  workspaces: [],
  worktrees: [],
  readAtMilliseconds: 0,
};
