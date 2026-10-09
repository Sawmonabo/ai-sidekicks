// The folders the service can reach and who uses each: every attached mount, a project's folder or
// a chat's own workspace, and each standing worktree the daemon made, listed beneath its project's
// folder; and, for one mount, where it came from, its project's name and the sessions bound to it,
// which `repo.mountRead` adds to the mount's own row. Every read is on the read-only connection.

import type { Database, Statement } from "better-sqlite3";

import { ProjectIdSchema } from "@ai-sidekicks/contracts/project";
import type {
  RepoMountListEntry,
  RepoMountListResponse,
  RepoMountOrigin,
  RepoMountReadResponse,
} from "@ai-sidekicks/contracts/repo/folders";
import { RepoMountIdSchema } from "@ai-sidekicks/contracts/repo/mount";
import { SessionIdSchema } from "@ai-sidekicks/contracts/session/id";
import { WorktreeIdSchema } from "@ai-sidekicks/contracts/worktree/lifecycle";

import type { MountOccupancyReader } from "../../git/worktree/occupancy.js";
import { canonicalFolderPath } from "./canonical-path.js";
import { LIVE_WORKTREE_STATE_PREDICATE } from "../../git/worktree/rows.js";
import type { FolderPlace } from "./place.js";
import { RepoMountNotFoundError } from "../repo/errors.js";

interface MountOriginRow {
  readonly id: string;
  readonly canonical_root: string;
  readonly origin: string;
  readonly project_id: string | null;
  readonly managed_session_id: string | null;
  readonly project_name: string | null;
}

interface StandingWorktreeRow {
  readonly id: string;
  readonly fs_root: string;
}

const MOUNT_ORIGIN_COLUMNS = `mount.id, mount.canonical_root, mount.origin, mount.project_id,
       mount.managed_session_id, project.name AS project_name
  FROM repo_mounts AS mount
  LEFT JOIN projects AS project ON project.id = mount.project_id`;

const ATTACHED_MOUNTS_SQL = `SELECT ${MOUNT_ORIGIN_COLUMNS}
 WHERE mount.state = 'attached'
 ORDER BY mount.attached_at ASC, mount.id ASC`;

// Unscoped by state, as `repo.mountRead` answers for a detached mount too.
const MOUNT_SQL = `SELECT ${MOUNT_ORIGIN_COLUMNS} WHERE mount.id = @repoMountId`;

const STANDING_WORKTREES_SQL = `SELECT worktrees.id, worktrees.fs_root
  FROM worktrees
 WHERE worktrees.repo_mount_id = @repoMountId AND ${LIVE_WORKTREE_STATE_PREDICATE}
 ORDER BY worktrees.created_at ASC, worktrees.id ASC`;

// Every session with a live workspace on the mount, the earliest bound first.
const BOUND_SESSIONS_SQL = `SELECT session_id
  FROM workspaces
 WHERE repo_mount_id = @repoMountId AND state <> 'archived'
 GROUP BY session_id
 ORDER BY MIN(created_at) ASC, session_id ASC`;

/** What `repo.mountRead` adds to a mount's own row. */
export type RepoMountUsage = Pick<RepoMountReadResponse, "origin" | "displayName" | "usedBy">;

/** Reads the folders the service can reach and the sessions using each. */
export class RepoFolderUsage {
  readonly #folderPlace: FolderPlace;
  readonly #occupancy: MountOccupancyReader;
  readonly #selectAttachedMounts: Statement<[], MountOriginRow>;
  readonly #selectMount: Statement<{ repoMountId: string }, MountOriginRow>;
  readonly #selectStandingWorktrees: Statement<{ repoMountId: string }, StandingWorktreeRow>;
  readonly #selectBoundSessions: Statement<{ repoMountId: string }, { session_id: string }>;

  constructor(reader: Database, occupancy: MountOccupancyReader, folderPlace: FolderPlace) {
    this.#folderPlace = folderPlace;
    this.#occupancy = occupancy;
    this.#selectAttachedMounts = reader.prepare<[], MountOriginRow>(ATTACHED_MOUNTS_SQL);
    this.#selectMount = reader.prepare<{ repoMountId: string }, MountOriginRow>(MOUNT_SQL);
    this.#selectStandingWorktrees = reader.prepare<{ repoMountId: string }, StandingWorktreeRow>(
      STANDING_WORKTREES_SQL,
    );
    this.#selectBoundSessions = reader.prepare<{ repoMountId: string }, { session_id: string }>(
      BOUND_SESSIONS_SQL,
    );
  }

  /**
   * Every attached mount, each project's standing worktrees right after its folder, with how many
   * sessions work in each folder.
   */
  async list(): Promise<RepoMountListResponse> {
    const mounts: RepoMountListEntry[] = [];
    for (const mount of this.#selectAttachedMounts.all()) {
      const { standingByFolder } = await this.#occupancy.read(mount.id);
      const usingSessionCount = async (folder: string): Promise<number> =>
        standingByFolder.get(await canonicalFolderPath(folder))?.length ?? 0;
      mounts.push({
        path: mount.canonical_root,
        origin: originOf(mount),
        usingSessionCount: await usingSessionCount(mount.canonical_root),
        onOtherSideDisk: this.#folderPlace.isOnOtherSideDisk(mount.canonical_root),
      });
      if (mount.origin !== "attached" || mount.project_id === null) continue;
      const projectId = ProjectIdSchema.parse(mount.project_id);
      for (const worktree of this.#selectStandingWorktrees.all({ repoMountId: mount.id })) {
        mounts.push({
          path: worktree.fs_root,
          origin: { kind: "worktree", worktreeId: WorktreeIdSchema.parse(worktree.id), projectId },
          usingSessionCount: await usingSessionCount(worktree.fs_root),
          onOtherSideDisk: this.#folderPlace.isOnOtherSideDisk(worktree.fs_root),
        });
      }
    }
    return { mounts };
  }

  /**
   * Where the mount came from, its project's name, and every session bound to it. Throws
   * `RepoMountNotFoundError` for an unknown mount, and for a detached one whose project was
   * forgotten, which no session can reach again.
   */
  readUsage(repoMountId: string): RepoMountUsage {
    const mount = this.#selectMount.get({ repoMountId });
    if (mount === undefined || (mount.project_id === null && mount.managed_session_id === null)) {
      throw new RepoMountNotFoundError(repoMountId);
    }
    const usedBy = this.#selectBoundSessions
      .all({ repoMountId })
      .map((row) => ({ sessionId: SessionIdSchema.parse(row.session_id) }));
    return {
      origin: originOf(mount),
      ...(mount.project_name === null ? {} : { displayName: mount.project_name }),
      usedBy,
    };
  }
}

// A managed mount names its chat; any other names the project it serves.
function originOf(mount: MountOriginRow): RepoMountOrigin {
  const repoMountId = RepoMountIdSchema.parse(mount.id);
  if (mount.origin === "managed") {
    return {
      kind: "managed",
      repoMountId,
      sessionId: SessionIdSchema.parse(mount.managed_session_id),
    };
  }
  return { kind: "attached", repoMountId, projectId: ProjectIdSchema.parse(mount.project_id) };
}
