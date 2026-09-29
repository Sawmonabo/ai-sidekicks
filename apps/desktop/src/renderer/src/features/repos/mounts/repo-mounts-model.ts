// What the repos section renders from, declared apart from the two classes that write it.
//
// The reading is what both the reader and the mode switch publish. A shape declared inside
// either one would make the other import the class it collaborates with just to name the
// value they share, which here would be a cycle.
//
// Each field is a different kind of nothing: `status` says whether a read was made at all,
// and the lists and maps are empty when the read answered with none. `not-read` and an empty
// list are not the same fact, so the two are kept apart.

import type {
  ExecutionMode,
  RepoMountReadResponse,
  WorkspaceExecutionModeCapabilitiesReadResponse,
  WorkspaceListResponse,
} from "@ai-sidekicks/contracts";
import type { WorktreeStatusRecord } from "./execution-root-model.js";

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
  /** Every worktree this session holds, in the order the status read returned them. */
  readonly worktrees: readonly WorktreeStatusRecord[];
  /**
   * The instant this reading was taken, on the reader's own clock.
   *
   * Carried here rather than read off the wall clock by the cards that render an age,
   * because an age moves when the surface re-reads and at no other time. Zero before the
   * first read, which no card renders against.
   */
  readonly readAtMilliseconds: number;
  readonly capabilitiesByWorkspaceId: Readonly<
    Record<string, WorkspaceExecutionModeCapabilitiesReadResponse>
  >;
  /**
   * Per workspace: the mode a switch is on the wire for, where one is.
   *
   * The mode and not a boolean, because the picker says which switch it is holding for. A
   * workspace with no entry has nothing on the wire. Keyed per workspace because two
   * workspaces switching are two independent mutations on two rows.
   */
  readonly pendingModeByWorkspaceId: Readonly<Record<string, ExecutionMode>>;
}

/** The reading before anything has been asked. */
export const NOTHING_READ_YET: RepoMountsReading = {
  status: "not-read",
  mounts: [],
  workspaces: [],
  worktrees: [],
  readAtMilliseconds: 0,
  capabilitiesByWorkspaceId: {},
  pendingModeByWorkspaceId: {},
};
