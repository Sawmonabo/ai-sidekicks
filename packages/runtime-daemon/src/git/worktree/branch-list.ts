// The one ordered branch list both base pickers draw: the project's default branch first, then the
// branches its recent bases were picked from, most recent first, then every other branch by its
// newest commit. Each row carries its distance from its upstream as of the background fetch and
// the worktree that has it checked out, git's answer for any tree: the repository's own checkout,
// a tree the person made, or one this daemon made, which also carries its id. The order is the
// daemon's; a picker filters the list and never reorders it.

import { basename } from "node:path";

import type { Database, Statement } from "better-sqlite3";

import { WorktreeIdSchema } from "@ai-sidekicks/contracts/worktree/lifecycle";
import type {
  RepoBranchListEntry,
  RepoBranchListRequest,
  RepoBranchListResponse,
} from "@ai-sidekicks/contracts/repo/git-reads";

import { RepoMountNotFoundError } from "../../workspace/repo/errors.js";
import { canonicalFolderPath } from "../../workspace/folder/canonical-path.js";
import type { GitCommand } from "../process.js";
import {
  readBranchFigures,
  readCurrentBranch,
  readRemoteDefaultBranch,
  type BranchFigures,
} from "./reads.js";
import { LIVE_WORKTREE_STATE_PREDICATE } from "./rows.js";

const SELECT_ATTACHED_MOUNT_SQL = `SELECT canonical_root FROM repo_mounts
  WHERE id = @repoMountId AND state = 'attached'`;

// Every base a tree of this project was cut from, across each mount the project has had, newest
// pick first.
const SELECT_RECENT_BASES_SQL = `SELECT bc.base_branch AS base_branch,
       MAX(bc.created_at) AS picked_at
  FROM branch_contexts AS bc
  JOIN worktrees AS wt ON wt.id = bc.worktree_id
  JOIN repo_mounts AS m ON m.id = wt.repo_mount_id
 WHERE m.project_id = (SELECT project_id FROM repo_mounts WHERE id = @repoMountId)
 GROUP BY bc.base_branch
 ORDER BY picked_at DESC, bc.base_branch`;

// The trees this daemon made that still stand on this mount, by folder.
const SELECT_LIVE_WORKTREES_SQL = `SELECT id, fs_root FROM worktrees
  WHERE repo_mount_id = @repoMountId AND ${LIVE_WORKTREE_STATE_PREDICATE}`;

interface RecentBaseRow {
  readonly base_branch: string;
}

interface LiveWorktreeRow {
  readonly id: string;
  readonly fs_root: string;
}

/** What the branch list runs with. */
export interface BranchListReaderDeps {
  /** The daemon's read-only connection. */
  readonly reader: Database;
  /** The daemon's git entry point, running with the repository's own config. */
  readonly git: GitCommand;
  /** When each mount's ahead and behind figures were last true, after a failed fetch. */
  readonly fetch: { countsAsOf(repoMountId: string): string | null };
}

/** Answers `repo.branchList` for a project's mount. */
export class BranchListReader {
  readonly #deps: BranchListReaderDeps;
  readonly #selectMount: Statement<{ repoMountId: string }, { canonical_root: string }>;
  readonly #selectRecentBases: Statement<{ repoMountId: string }, RecentBaseRow>;
  readonly #selectLiveWorktrees: Statement<{ repoMountId: string }, LiveWorktreeRow>;

  constructor(deps: BranchListReaderDeps) {
    this.#deps = deps;
    this.#selectMount = deps.reader.prepare<{ repoMountId: string }, { canonical_root: string }>(
      SELECT_ATTACHED_MOUNT_SQL,
    );
    this.#selectRecentBases = deps.reader.prepare<{ repoMountId: string }, RecentBaseRow>(
      SELECT_RECENT_BASES_SQL,
    );
    this.#selectLiveWorktrees = deps.reader.prepare<{ repoMountId: string }, LiveWorktreeRow>(
      SELECT_LIVE_WORKTREES_SQL,
    );
  }

  /**
   * Reads the ordered list. Throws {@link RepoMountNotFoundError} for a mount that is not attached,
   * and an `Error` when a git read fails.
   */
  async read(request: RepoBranchListRequest): Promise<RepoBranchListResponse> {
    const { repoMountId } = request;
    const mount = this.#selectMount.get({ repoMountId });
    if (mount === undefined) {
      throw new RepoMountNotFoundError(repoMountId);
    }
    const git = this.#deps.git;
    const repositoryRoot = mount.canonical_root;
    const [branches, remoteDefault, checkoutBranch] = await Promise.all([
      readBranchFigures(git, repositoryRoot),
      readRemoteDefaultBranch(git, repositoryRoot),
      readCurrentBranch(git, repositoryRoot),
    ]);
    // A repository no remote names a default for takes its checkout's own branch as the default.
    const defaultBranch = remoteDefault ?? checkoutBranch;
    if (defaultBranch === null) {
      throw new Error(
        "The repository names no default branch: no remote names one and its checkout is on " +
          "no branch",
      );
    }

    const appTreeIdByFolder = new Map<string, string>();
    for (const row of this.#selectLiveWorktrees.all({ repoMountId })) {
      appTreeIdByFolder.set(await canonicalFolderPath(row.fs_root), row.id);
    }

    // Newest commit first, so the last tier needs no further sort.
    const byNewestCommit = [...branches].sort(
      (left, right) => right.newestCommitSeconds - left.newestCommitSeconds,
    );
    const branchByName = new Map(byNewestCommit.map((branch) => [branch.name, branch]));
    const ordered: BranchFigures[] = [];
    const place = (name: string): void => {
      const branch = branchByName.get(name);
      if (branch !== undefined) {
        branchByName.delete(name);
        ordered.push(branch);
      }
    };
    place(defaultBranch);
    for (const base of this.#selectRecentBases.all({ repoMountId })) {
      place(base.base_branch);
    }
    for (const branch of byNewestCommit) {
      place(branch.name);
    }

    const entries: RepoBranchListEntry[] = [];
    for (const branch of ordered) {
      const holderFolder = branch.checkedOutAt;
      const appTreeId =
        holderFolder === null
          ? undefined
          : appTreeIdByFolder.get(await canonicalFolderPath(holderFolder));
      entries.push({
        name: branch.name,
        ...(branch.ahead === null ? {} : { ahead: branch.ahead }),
        ...(branch.behind === null ? {} : { behind: branch.behind }),
        ...(holderFolder === null
          ? {}
          : {
              heldBy: {
                name: basename(holderFolder),
                ...(appTreeId === undefined
                  ? {}
                  : { worktreeId: WorktreeIdSchema.parse(appTreeId) }),
              },
            }),
      });
    }

    const countsAsOf = this.#deps.fetch.countsAsOf(repoMountId);
    return {
      defaultBranch,
      branches: entries,
      ...(countsAsOf === null ? {} : { countsAsOf }),
    };
  }
}
