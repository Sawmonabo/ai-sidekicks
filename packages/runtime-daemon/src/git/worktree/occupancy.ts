// Which sessions stand in which folder of a repository, and which of them has an agent running
// there. A session stands where its live workspace's checkout is; an agent runs where a run's
// execution context is still unreleased. Nothing here holds a folder: it only reads. Folders are
// keyed by `canonicalFolderPath`.

import type { Database, Statement } from "better-sqlite3";

import { SessionIdSchema, type SessionId } from "@ai-sidekicks/contracts/session/id";
import { WorktreeIdSchema, type WorktreeId } from "@ai-sidekicks/contracts/worktree/lifecycle";

import { canonicalFolderPath } from "../../workspace/folder/canonical-path.js";
import { CHECKOUT_ROOT_METADATA_PATH } from "../../workspace/row-guards.js";
import { liveWorktreeStatePredicate } from "./rows.js";

// A workspace's checkout is its working tree's top level, which the execution-root service records
// in the workspace's metadata; a workspace without that key works at its root.
const STANDING_SESSIONS_SQL = `SELECT standing.session_id AS session_id,
       standing.folder AS folder,
       s.branch AS recorded_branch,
       (SELECT wt.id FROM worktrees AS wt
         WHERE wt.repo_mount_id = standing.repo_mount_id
           AND wt.fs_root = standing.folder
           AND ${liveWorktreeStatePredicate("wt")}
         LIMIT 1) AS worktree_id
  FROM (SELECT w.session_id, w.repo_mount_id, w.created_at,
               COALESCE(json_extract(w.metadata, '${CHECKOUT_ROOT_METADATA_PATH}'),
                        w.fs_root) AS folder
          FROM workspaces AS w
         WHERE w.repo_mount_id = @repoMountId
           AND w.state <> 'archived'
           AND w.fs_root IS NOT NULL) AS standing
  JOIN sessions AS s ON s.id = standing.session_id
 ORDER BY standing.created_at, standing.session_id`;

// The oldest unreleased run in each folder is the one a removal names.
const RUNNING_SESSIONS_SQL = `SELECT r.session_id AS session_id, r.checkout_root AS folder
  FROM run_execution_contexts AS r
  JOIN workspaces AS w ON w.id = r.workspace_id
 WHERE w.repo_mount_id = @repoMountId
   AND r.released_at IS NULL
 ORDER BY r.created_at, r.run_id`;

interface StandingSessionRow {
  readonly session_id: string;
  readonly folder: string;
  readonly recorded_branch: string | null;
  readonly worktree_id: string | null;
}

interface RunningSessionRow {
  readonly session_id: string;
  readonly folder: string;
}

/** One session standing in a folder of the repository. */
interface StandingSession {
  readonly sessionId: SessionId;
  /** The branch the session's record holds, `null` until one is written. */
  readonly recordedBranch: string | null;
  /** The live tree this daemon made at that folder, or `null` for one it did not make. */
  readonly worktreeId: WorktreeId | null;
}

/** Who stands in each folder of one repository mount, keyed by resolved folder. */
export interface MountOccupancy {
  readonly standingByFolder: ReadonlyMap<string, readonly StandingSession[]>;
  /** The session whose agent runs in each folder, for folders where one does. */
  readonly runningByFolder: ReadonlyMap<string, SessionId>;
}

/** Reads who stands in, and who runs in, each folder of a repository mount. */
export class MountOccupancyReader {
  readonly #selectStanding: Statement<{ repoMountId: string }, StandingSessionRow>;
  readonly #selectRunning: Statement<{ repoMountId: string }, RunningSessionRow>;

  constructor(reader: Database) {
    this.#selectStanding = reader.prepare<{ repoMountId: string }, StandingSessionRow>(
      STANDING_SESSIONS_SQL,
    );
    this.#selectRunning = reader.prepare<{ repoMountId: string }, RunningSessionRow>(
      RUNNING_SESSIONS_SQL,
    );
  }

  /** The occupancy of every folder of the mount `repoMountId`, keyed by `canonicalFolderPath`. */
  async read(repoMountId: string): Promise<MountOccupancy> {
    const standingByFolder = new Map<string, StandingSession[]>();
    for (const row of this.#selectStanding.all({ repoMountId })) {
      const folder = await canonicalFolderPath(row.folder);
      const standing = standingByFolder.get(folder) ?? [];
      standing.push({
        sessionId: SessionIdSchema.parse(row.session_id),
        recordedBranch: row.recorded_branch,
        worktreeId: row.worktree_id === null ? null : WorktreeIdSchema.parse(row.worktree_id),
      });
      standingByFolder.set(folder, standing);
    }
    const runningByFolder = new Map<string, SessionId>();
    for (const row of this.#selectRunning.all({ repoMountId })) {
      const folder = await canonicalFolderPath(row.folder);
      if (!runningByFolder.has(folder)) {
        runningByFolder.set(folder, SessionIdSchema.parse(row.session_id));
      }
    }
    return { standingByFolder, runningByFolder };
  }
}
