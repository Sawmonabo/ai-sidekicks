// What one row of the worktree popover reads from the daemon's status of a tree: its name, the
// base it branched off, the ahead and behind figures with a zero figure absent, the uncommitted
// count, who occupies it, and whether the app may remove it and why not.

import type { WorktreeId, WorktreeStatusRecord } from "@ai-sidekicks/contracts/worktree/lifecycle";

/** One worktree row's words and figures. */
export interface WorktreeRow {
  readonly path: string;
  readonly name: string;
  /** The branch checked out in it, which the session's listing names once the session is in it. */
  readonly branchName: string;
  /** `off <base>` for a tree the app made, absent for one the person made. */
  readonly offBase: string | undefined;
  /** `↑<ahead>`, absent at zero or while unknown. */
  readonly ahead: string | undefined;
  /** `↓<behind>`, absent at zero or while unknown. */
  readonly behind: string | undefined;
  /** `<dirty> uncommitted`, absent with nothing uncommitted. */
  readonly uncommitted: string | undefined;
  /** The files changed and not committed, which a removal would discard. */
  readonly uncommittedFileCount: number;
  /** The commits not pushed, which a removal would discard. */
  readonly unpushedCommitCount: number;
  /** The sessions attached to it. */
  readonly occupyingSessionIds: readonly string[];
  /** The session whose agent runs in it, which holds its removal, or `undefined`. */
  readonly runningSessionId: string | undefined;
  /** The tree's id where the app made it, the only kind a person may remove here. */
  readonly removableWorktreeId: WorktreeId | undefined;
}

/** The row for `record`. */
export function readWorktreeRow(record: WorktreeStatusRecord): WorktreeRow {
  return {
    path: record.path,
    name: record.name,
    branchName: record.branchName,
    offBase: record.madeBy === "app" ? `off ${record.baseBranchName}` : undefined,
    ahead: figureOrAbsent("↑", record.ahead),
    behind: figureOrAbsent("↓", record.behind),
    uncommitted:
      record.uncommittedFileCount === 0
        ? undefined
        : `${String(record.uncommittedFileCount)} uncommitted`,
    uncommittedFileCount: record.uncommittedFileCount,
    unpushedCommitCount: record.unpushedCommitCount,
    occupyingSessionIds: record.occupyingSessionIds,
    runningSessionId: record.runningSessionId ?? undefined,
    removableWorktreeId: record.madeBy === "app" ? record.worktreeId : undefined,
  };
}

function figureOrAbsent(mark: string, figure: number | undefined): string | undefined {
  return figure === undefined || figure === 0 ? undefined : `${mark}${String(figure)}`;
}
