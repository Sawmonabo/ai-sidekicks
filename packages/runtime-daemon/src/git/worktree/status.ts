// The switcher's list: a project's own checkout and every tree git lists for its repository, each
// with its base, its distance from its upstream, its uncommitted and unpushed counts and the
// sessions standing in it, from one read so no row shows a tree free that another read calls
// occupied. A tree this daemon made carries its record; one the person made carries none. A
// record git no longer lists (a tree that failed before git made it) still has its row, with no
// figures to read.

import { basename } from "node:path";

import type { Database, Statement } from "better-sqlite3";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type {
  NewWorktreeSuggestion,
  WorktreeStatusReadRequest,
  WorktreeStatusReadResponse,
} from "@ai-sidekicks/contracts/worktree/lifecycle";

import { canonicalFolderPath } from "../../workspace/folder/canonical-path.js";
import type { GitCommand } from "../process.js";
import { readBranchFigures, readListedWorktrees, type ListedWorktree } from "./reads.js";
import type { MountOccupancy, MountOccupancyReader } from "./occupancy.js";
import {
  projectWorktreeStatusRead,
  type WorktreeRecordRow,
  type WorktreeStatusRow,
} from "./projector.js";
import { readRemovalRisks } from "./risks.js";

const SELECT_PROJECT_MOUNT_SQL = `SELECT id, canonical_root FROM repo_mounts
  WHERE project_id = @projectId AND state = 'attached'`;

// The base is the one the tree's first branch context recorded when the tree was prepared.
const SELECT_WORKTREE_RECORDS_SQL = `SELECT wt.id, wt.repo_mount_id, wt.created_by_session_id,
       wt.created_by_run_id, wt.branch_name, wt.fs_root, wt.state, wt.created_at, wt.updated_at,
       (SELECT bc.base_branch FROM branch_contexts AS bc
         WHERE bc.worktree_id = wt.id
         ORDER BY bc.created_at
         LIMIT 1) AS base_branch_name
  FROM worktrees AS wt
 WHERE wt.repo_mount_id = @repoMountId AND wt.state <> 'retired'
 ORDER BY wt.created_at, wt.id`;

interface ProjectMountRow {
  readonly id: string;
  readonly canonical_root: string;
}

interface WorktreeRecordWithFolderRow extends WorktreeRecordRow {
  readonly branch_name: string;
  readonly fs_root: string;
}

/**
 * The one daemon function that names and creates a tree, answering what the new-worktree form
 * opens with for a session of the project.
 */
interface NewWorktreeSuggestionSource {
  suggestNewWorktree(input: {
    readonly repoMountId: string;
    readonly sessionId: SessionId;
  }): Promise<NewWorktreeSuggestion>;
}

/** What the status read runs with. */
export interface WorktreeStatusReaderDeps {
  /** The daemon's read-only connection. */
  readonly reader: Database;
  /** The daemon's one occupancy reader, for the sessions in each tree. */
  readonly occupancy: MountOccupancyReader;
  /** The daemon's git entry point, running with the repository's own config. */
  readonly git: GitCommand;
  /** When each mount's ahead and behind figures were last true, after a failed fetch. */
  readonly fetch: { countsAsOf(repoMountId: string): string | null };
  readonly newWorktree: NewWorktreeSuggestionSource;
}

/** Answers `repo.worktreeStatusRead` for a project. */
export class WorktreeStatusReader {
  readonly #deps: WorktreeStatusReaderDeps;
  readonly #occupancy: MountOccupancyReader;
  readonly #selectProjectMount: Statement<{ projectId: string }, ProjectMountRow>;
  readonly #selectRecords: Statement<{ repoMountId: string }, WorktreeRecordWithFolderRow>;

  constructor(deps: WorktreeStatusReaderDeps) {
    this.#deps = deps;
    this.#occupancy = deps.occupancy;
    this.#selectProjectMount = deps.reader.prepare<{ projectId: string }, ProjectMountRow>(
      SELECT_PROJECT_MOUNT_SQL,
    );
    this.#selectRecords = deps.reader.prepare<{ repoMountId: string }, WorktreeRecordWithFolderRow>(
      SELECT_WORKTREE_RECORDS_SQL,
    );
  }

  /**
   * Reads the project's checkout and trees. Throws when the project has no attached repository,
   * and when a git read fails, so the list is never drawn from figures the daemon could not read.
   */
  async read(request: WorktreeStatusReadRequest): Promise<WorktreeStatusReadResponse> {
    const mount = this.#selectProjectMount.get({ projectId: request.projectId });
    if (mount === undefined) {
      throw new Error(`Project "${request.projectId}" has no attached repository to read`);
    }
    const git = this.#deps.git;
    const [listed, branchFigures] = await Promise.all([
      readListedWorktrees(git, mount.canonical_root),
      readBranchFigures(git, mount.canonical_root),
    ]);
    const mainCheckout = listed.find((worktree) => worktree.isMainCheckout);
    if (mainCheckout === undefined) {
      throw new Error(`Project "${request.projectId}" has no checkout of its own to read`);
    }
    const distanceByBranch = new Map(
      branchFigures.map((branch) => [branch.name, { ahead: branch.ahead, behind: branch.behind }]),
    );
    const recordByFolder = new Map<string, WorktreeRecordWithFolderRow>();
    for (const record of this.#selectRecords.all({ repoMountId: mount.id })) {
      recordByFolder.set(await canonicalFolderPath(record.fs_root), record);
    }
    const occupancy = await this.#occupancy.read(mount.id);

    const rows: WorktreeStatusRow[] = [];
    // Trees git lists, in its order; the checkout itself is the separate root row, and a bare
    // repository's own record has no folder to stand in.
    for (const worktree of listed) {
      if (worktree.isMainCheckout || worktree.isBare || worktree.isPrunable) {
        continue;
      }
      const folder = await canonicalFolderPath(worktree.path);
      const record = recordByFolder.get(folder) ?? null;
      recordByFolder.delete(folder);
      const branchName = branchNameOf(worktree);
      const distance = worktree.branchName === null ? undefined : distanceByBranch.get(branchName);
      // The same read the removal confirm draws its risks from, so a row and its confirm agree.
      // Trees are read one after another, one git process at a time.
      const occupants = occupantsOf(occupancy, folder);
      const risks = await readRemovalRisks(git, worktree.path, occupants.occupyingSessionIds);
      rows.push({
        path: worktree.path,
        name: basename(worktree.path),
        branchName,
        ahead: distance?.ahead ?? null,
        behind: distance?.behind ?? null,
        uncommittedFileCount: risks.uncommittedFileCount,
        unpushedCommitCount: risks.unpushedCommitCount,
        ...occupants,
        record,
      });
    }
    // Records git does not list: trees that failed or are still being made, or whose folder is
    // gone. Their rows stand with their recorded branch and nothing to count.
    for (const [folder, record] of recordByFolder) {
      rows.push({
        path: record.fs_root,
        name: basename(record.fs_root),
        branchName: record.branch_name,
        ahead: null,
        behind: null,
        uncommittedFileCount: 0,
        unpushedCommitCount: 0,
        ...occupantsOf(occupancy, folder),
        record,
      });
    }

    return projectWorktreeStatusRead({
      repoMountId: mount.id,
      repoRoot: { path: mainCheckout.path, branchName: branchNameOf(mainCheckout) },
      worktrees: rows,
      countsAsOf: this.#deps.fetch.countsAsOf(mount.id),
      newWorktree:
        request.sessionId === undefined
          ? null
          : await this.#deps.newWorktree.suggestNewWorktree({
              repoMountId: mount.id,
              sessionId: request.sessionId,
            }),
    });
  }
}

// A detached HEAD has no branch to name, so the row names the commit it stands on.
function branchNameOf(worktree: ListedWorktree): string {
  if (worktree.branchName !== null) {
    return worktree.branchName;
  }
  if (worktree.headCommit !== null) {
    return worktree.headCommit;
  }
  throw new Error("git listed a tree on neither a branch nor a commit");
}

function occupantsOf(
  occupancy: MountOccupancy,
  folder: string,
): { readonly occupyingSessionIds: SessionId[]; readonly runningSessionId: SessionId | null } {
  return {
    occupyingSessionIds: (occupancy.standingByFolder.get(folder) ?? []).map(
      (standing) => standing.sessionId,
    ),
    runningSessionId: occupancy.runningByFolder.get(folder) ?? null,
  };
}
