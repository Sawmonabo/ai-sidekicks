// What the repos section renders from, declared apart from the reader and the mode switch that
// both publish it, so neither imports the other's class just to name the shared value.
// `not-read` and an empty list are different facts: `status` says whether a read was made.

import type {
  ExecutionMode,
  RepoMountReadResponse,
  WorkspaceExecutionModeCapabilitiesReadResponse,
  WorkspaceListResponse,
  WorktreeStatusRecord,
} from "@ai-sidekicks/contracts";

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
  /** The worktrees of every mount this session has bound, mount by mount, in read order. */
  readonly worktrees: readonly WorktreeStatusRecord[];
  /** The instant this reading was taken, on the reader's own clock; zero before the first read. */
  readonly readAtMilliseconds: number;
  readonly capabilitiesByWorkspaceId: Readonly<
    Record<string, WorkspaceExecutionModeCapabilitiesReadResponse>
  >;
  /**
   * Per workspace: the mode a switch is on the wire for, so the picker can say which switch it
   * is holding for. No entry means nothing is on the wire.
   */
  readonly pendingModeByWorkspaceId: Readonly<Record<string, ExecutionMode>>;
}

/** The reading before anything has been asked. */
export const REPO_MOUNTS_NOT_READ: RepoMountsReading = {
  status: "not-read",
  mounts: [],
  workspaces: [],
  worktrees: [],
  readAtMilliseconds: 0,
  capabilitiesByWorkspaceId: {},
  pendingModeByWorkspaceId: {},
};
