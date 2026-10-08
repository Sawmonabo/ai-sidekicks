// A project session's working folder: moving it into any tree its repository has, at once while no
// run of the session is live, or as a pending move on the session's own row that the run's next
// boundary applies. The row holds at most one, so a later request replaces it, and a request for
// the folder the session already works in clears it. A removed tree's sessions are swept back to
// the repository's own checkout; one whose run is still bound there keeps its folder until that
// run is released, and is swept at its run's next boundary.

import { isAbsolute } from "node:path";

import type { Statement } from "better-sqlite3";

import { RepoMountIdSchema } from "@ai-sidekicks/contracts/repo/mount";
import { WorktreeIdSchema } from "@ai-sidekicks/contracts/worktree/lifecycle";
import type {
  SessionSetWorkingFolderRequest,
  SessionSetWorkingFolderResponse,
} from "@ai-sidekicks/contracts/session/directory";
import { SessionIdSchema } from "@ai-sidekicks/contracts/session/id";
import { SESSION_WORKING_FOLDER_UNAVAILABLE_CODE } from "@ai-sidekicks/contracts/session/methods";

import type { DatabaseConnections } from "../../database/connection/lifecycle.js";
import type { WriteStatement } from "../../database/statement.js";
import type { DatabaseWriter } from "../../database/writer.js";
import type { WorktreeEventEmitter } from "../../git/worktree/event-emitter.js";
import { canonicalFolderPath } from "../../workspace/folder/canonical-path.js";
import type { WorktreeSessionSweep, WorktreeSweepInput } from "../../git/worktree/removal.js";
import { DaemonDomainError } from "../../ipc/domain-error.js";
import { SessionNotFoundError } from "../../ipc/session-errors.js";
import { RepoMountManagedError, RepoRootResolutionError } from "../../workspace/repo/errors.js";
import { CHECKOUT_ROOT_METADATA_PATH } from "../../workspace/row-guards.js";
import type { ExecutionRootService } from "../../workspace/execution-root-service.js";
import { RUN_TERMINAL_STATES } from "../run/transitions.js";

interface SessionPendingRow {
  readonly pending_working_folder: string | null;
}

interface PendingSessionRow {
  readonly id: string;
  readonly pending_working_folder: string;
}

interface RemovedTreeRow {
  readonly id: string;
  readonly repo_mount_id: string;
  readonly fs_root: string;
}

interface ProjectWorkspaceRow {
  readonly id: string;
  readonly session_id: string;
  /** The folder the workspace is matched by, as the query that read it says. */
  readonly folder: string | null;
}

interface SessionWorkspaceRow extends ProjectWorkspaceRow {
  readonly state: string;
  readonly repo_mount_id: string;
  readonly is_project: 0 | 1;
}

// The session's live workspace by where it works now: its execution root, else the checkout it
// last had. Only one on a project's mount moves; a chat's managed workspace never does.
const SELECT_SESSION_WORKSPACE_SQL = `SELECT w.id, w.session_id, w.state, w.repo_mount_id,
       m.origin = 'attached' AS is_project,
       COALESCE(w.fs_root, json_extract(w.metadata, '${CHECKOUT_ROOT_METADATA_PATH}')) AS folder
  FROM workspaces AS w
  JOIN repo_mounts AS m ON m.id = w.repo_mount_id
 WHERE w.session_id = @session_id AND w.state <> 'archived'
 ORDER BY w.created_at DESC, w.id DESC
 LIMIT 1`;

// Each live workspace on the mount by the checkout it works in, so one bound to a folder inside a
// tree stands in that tree; a workspace without a recorded checkout stands at its root.
const SELECT_MOUNT_WORKSPACES_SQL = `SELECT w.id, w.session_id,
       COALESCE(json_extract(w.metadata, '${CHECKOUT_ROOT_METADATA_PATH}'), w.fs_root) AS folder
  FROM workspaces AS w
 WHERE w.repo_mount_id = @repo_mount_id AND w.state <> 'archived'
 ORDER BY w.created_at, w.id`;

// "A run of the session is live": a run not yet ended, queued and starting included, or one whose
// run context its end has not released yet.
const SELECT_LIVE_RUN_SQL = `SELECT 1 FROM runs
  WHERE session_id = @session_id
    AND state NOT IN (${RUN_TERMINAL_STATES.map((state) => `'${state}'`).join(", ")})
  UNION ALL
  SELECT 1 FROM run_execution_contexts
  WHERE session_id = @session_id AND released_at IS NULL
  LIMIT 1`;

// A run of the session still bound to its folder: its context not yet released.
const SELECT_BOUND_RUN_SQL = `SELECT 1 FROM run_execution_contexts
  WHERE session_id = @session_id AND released_at IS NULL
  LIMIT 1`;

// The removed tree the session's live workspace still works in, if any.
const SELECT_REMOVED_TREE_OF_SESSION_SQL = `SELECT wt.id, wt.repo_mount_id, wt.fs_root
  FROM workspaces AS w
  JOIN worktrees AS wt
    ON wt.repo_mount_id = w.repo_mount_id
   AND wt.state = 'retired'
   AND wt.fs_root = COALESCE(json_extract(w.metadata, '${CHECKOUT_ROOT_METADATA_PATH}'), w.fs_root)
 WHERE w.session_id = @session_id AND w.state <> 'archived'
 ORDER BY wt.updated_at DESC, wt.id DESC
 LIMIT 1`;

const SET_PENDING_SQL = `UPDATE sessions SET pending_working_folder = @path WHERE id = @session_id`;

// Clears the pending move only while it still names `@path`, so a newer request survives.
const CLEAR_PENDING_AT_SQL = `UPDATE sessions SET pending_working_folder = NULL
  WHERE id = @session_id AND pending_working_folder = @path`;

/** Dependencies of {@link SessionWorkingFolders}. */
export interface SessionWorkingFoldersDeps {
  readonly database: DatabaseConnections;
  readonly executionRoots: Pick<ExecutionRootService, "moveToFolder" | "requireListedTree">;
  readonly events: Pick<WorktreeEventEmitter, "emitSessionSweptToRepoRoot">;
}

/** Moves project sessions between the trees of their repository. */
export class SessionWorkingFolders implements WorktreeSessionSweep {
  readonly #executionRoots: SessionWorkingFoldersDeps["executionRoots"];
  readonly #events: SessionWorkingFoldersDeps["events"];
  readonly #writer: Pick<DatabaseWriter, "write">;
  readonly #selectPendingStmt: Statement<{ session_id: string }, SessionPendingRow>;
  readonly #selectAllPendingStmt: Statement<[], PendingSessionRow>;
  readonly #selectSessionWorkspaceStmt: Statement<{ session_id: string }, SessionWorkspaceRow>;
  readonly #selectMountWorkspacesStmt: Statement<{ repo_mount_id: string }, ProjectWorkspaceRow>;
  readonly #selectMountRootStmt: Statement<{ id: string }, { readonly canonical_root: string }>;
  readonly #selectLiveRunStmt: Statement<{ session_id: string }, unknown>;
  readonly #selectBoundRunStmt: Statement<{ session_id: string }, unknown>;
  readonly #selectRemovedTreeOfSessionStmt: Statement<{ session_id: string }, RemovedTreeRow>;

  constructor(deps: SessionWorkingFoldersDeps) {
    this.#executionRoots = deps.executionRoots;
    this.#events = deps.events;
    this.#writer = deps.database.writer;
    const reader = deps.database.reader;
    this.#selectPendingStmt = reader.prepare(
      "SELECT pending_working_folder FROM sessions WHERE id = @session_id",
    );
    this.#selectAllPendingStmt = reader.prepare(
      `SELECT id, pending_working_folder FROM sessions WHERE pending_working_folder IS NOT NULL`,
    );
    this.#selectSessionWorkspaceStmt = reader.prepare(SELECT_SESSION_WORKSPACE_SQL);
    this.#selectMountWorkspacesStmt = reader.prepare(SELECT_MOUNT_WORKSPACES_SQL);
    this.#selectMountRootStmt = reader.prepare(
      "SELECT canonical_root FROM repo_mounts WHERE id = @id",
    );
    this.#selectLiveRunStmt = reader.prepare(SELECT_LIVE_RUN_SQL);
    this.#selectBoundRunStmt = reader.prepare(SELECT_BOUND_RUN_SQL);
    this.#selectRemovedTreeOfSessionStmt = reader.prepare(SELECT_REMOVED_TREE_OF_SESSION_SQL);
  }

  /**
   * `session.setWorkingFolder`: moves the session now when no run of it is live, else holds the
   * move on its row for the run's boundary; the folder it already works in clears a held move.
   * Throws {@link SessionNotFoundError} for an unknown session, `repo.root_resolution_failed`
   * (`not_absolute`) for a relative path, `repo.mount_managed` for a chat,
   * `session.working_folder_unavailable` for a session that works in no folder any more,
   * `repo.outside_trust_envelope` for a folder that is no tree of the session's repository,
   * `workspace.stale` when the repository's folder is unreachable and `repo.root_resolution_failed`
   * (`root_mismatch`) when it holds another repository.
   */
  async set(request: SessionSetWorkingFolderRequest): Promise<SessionSetWorkingFolderResponse> {
    if (this.#selectPendingStmt.get({ session_id: request.sessionId }) === undefined) {
      throw new SessionNotFoundError("This daemon holds no such session.", {
        sessionId: request.sessionId,
      });
    }
    if (!isAbsolute(request.path)) {
      throw new RepoRootResolutionError("not_absolute");
    }
    const workspace = this.#requireProjectWorkspace(request.sessionId);
    const applied: SessionSetWorkingFolderResponse = {
      sessionId: request.sessionId,
      disposition: "applied",
      path: request.path,
    };
    if (await isWorkingIn(workspace, request.path)) {
      await this.#writer.write([setPendingStatement(request.sessionId, null)]);
      return applied;
    }
    const move = { workspaceId: workspace.id, folder: request.path };
    if (this.#selectLiveRunStmt.get({ session_id: request.sessionId }) !== undefined) {
      await this.#executionRoots.requireListedTree(move);
      await this.#writer.write([setPendingStatement(request.sessionId, request.path)]);
      // A run that ended while the tree was checked found no move to apply, so it is made now.
      if (this.#selectLiveRunStmt.get({ session_id: request.sessionId }) !== undefined) {
        return { ...applied, disposition: "pending" };
      }
      await this.applyPending(request.sessionId);
      return applied;
    }
    await this.#executionRoots.moveToFolder(move);
    await this.#writer.write([setPendingStatement(request.sessionId, null)]);
    return applied;
  }

  /**
   * Applies the session's pending move, if it has one, at a run boundary. The move is cleared
   * before it is made, so a move that fails surfaces once and never wedges every later run.
   */
  async applyPending(sessionId: string): Promise<void> {
    const pending = this.#selectPendingStmt.get({ session_id: sessionId })?.pending_working_folder;
    if (pending === undefined || pending === null) {
      return;
    }
    await this.#writer.write([clearPendingStatement(sessionId, pending)]);
    const workspace = this.#requireProjectWorkspace(sessionId);
    if (!(await isWorkingIn(workspace, pending))) {
      await this.#executionRoots.moveToFolder({ workspaceId: workspace.id, folder: pending });
    }
  }

  /**
   * Sweeps the session out of a removed tree it still works in, at a run boundary: the sweep its
   * removal passed over while a run of it was bound there. A session in no removed tree is left as
   * it is.
   */
  async sweepFromRemovedTree(sessionId: string): Promise<void> {
    const tree = this.#selectRemovedTreeOfSessionStmt.get({ session_id: sessionId });
    if (tree !== undefined) {
      await this.sweepToRepoRoot({
        repoMountId: tree.repo_mount_id,
        worktreeId: WorktreeIdSchema.parse(tree.id),
        folder: tree.fs_root,
      });
    }
  }

  /**
   * Moves every session standing in the removed tree to the repository's own checkout and clears
   * every pending move to it, appending one `session.swept_to_repo_root` per session either
   * touched. A session whose run is still bound there is passed over, its folder never moved under
   * the run, until {@link sweepFromRemovedTree} at that run's boundary. Each session is tried;
   * their failures are thrown together once all have run.
   */
  async sweepToRepoRoot(input: WorktreeSweepInput): Promise<void> {
    const mount = this.#selectMountRootStmt.get({ id: input.repoMountId });
    if (mount === undefined) {
      throw new Error(`cannot sweep worktree "${input.worktreeId}": its mount has no row`);
    }
    const folder = await canonicalFolderPath(input.folder);
    const pendingSessionIds = new Set<string>();
    for (const row of this.#selectAllPendingStmt.all()) {
      if ((await canonicalFolderPath(row.pending_working_folder)) === folder) {
        pendingSessionIds.add(row.id);
      }
    }
    const standing: ProjectWorkspaceRow[] = [];
    for (const workspace of this.#selectMountWorkspacesStmt.all({
      repo_mount_id: input.repoMountId,
    })) {
      if (workspace.folder !== null && (await canonicalFolderPath(workspace.folder)) === folder) {
        standing.push(workspace);
      }
    }

    const failures: unknown[] = [];
    const record = async (sessionId: string, movedWorkspaceId: string | null): Promise<void> => {
      try {
        if (movedWorkspaceId !== null) {
          await this.#executionRoots.moveToFolder({
            workspaceId: movedWorkspaceId,
            folder: mount.canonical_root,
          });
        }
        const isPendingCleared = pendingSessionIds.delete(sessionId);
        await this.#events.emitSessionSweptToRepoRoot({
          payload: {
            sessionId: SessionIdSchema.parse(sessionId),
            repoMountId: RepoMountIdSchema.parse(input.repoMountId),
            worktreeId: input.worktreeId,
            ...(isPendingCleared ? { pendingMoveCleared: true as const } : {}),
          },
          transactionalPrelude: isPendingCleared
            ? await this.#clearPendingAt(sessionId, folder)
            : [],
        });
      } catch (sweepFailure) {
        failures.push(sweepFailure);
      }
    };
    for (const workspace of standing) {
      if (this.#selectBoundRunStmt.get({ session_id: workspace.session_id }) !== undefined) {
        // Its pending move to the tree is cleared with its sweep, in one event.
        pendingSessionIds.delete(workspace.session_id);
        continue;
      }
      await record(workspace.session_id, workspace.id);
    }
    for (const sessionId of [...pendingSessionIds]) {
      await record(sessionId, null);
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `sweeping the sessions out of worktree ${input.worktreeId} failed`,
      );
    }
  }

  #requireProjectWorkspace(sessionId: string): SessionWorkspaceRow {
    const workspace = this.#selectSessionWorkspaceStmt.get({ session_id: sessionId });
    if (workspace === undefined) {
      throw new DaemonDomainError("The session works in no folder any more, so it cannot move.", {
        code: SESSION_WORKING_FOLDER_UNAVAILABLE_CODE,
        detail: { sessionId },
      });
    }
    if (workspace.is_project === 0) {
      throw new RepoMountManagedError(workspace.repo_mount_id);
    }
    return workspace;
  }

  // The clear names the stored spelling, which the sweep matched by its resolved form.
  async #clearPendingAt(sessionId: string, folder: string): Promise<WriteStatement[]> {
    const pending = this.#selectPendingStmt.get({ session_id: sessionId })?.pending_working_folder;
    return pending !== undefined &&
      pending !== null &&
      (await canonicalFolderPath(pending)) === folder
      ? [clearPendingStatement(sessionId, pending)]
      : [];
  }
}

// A stale or preparing workspace is not yet working in its folder, so asking for it again moves
// it there, which repairs it.
async function isWorkingIn(workspace: SessionWorkspaceRow, requested: string): Promise<boolean> {
  return (
    workspace.state === "ready" &&
    workspace.folder !== null &&
    (await canonicalFolderPath(workspace.folder)) === (await canonicalFolderPath(requested))
  );
}

function setPendingStatement(sessionId: string, path: string | null): WriteStatement {
  return { sql: SET_PENDING_SQL, bindings: { session_id: sessionId, path }, expectedRowCount: 1 };
}

function clearPendingStatement(sessionId: string, path: string): WriteStatement {
  return { sql: CLEAR_PENDING_AT_SQL, bindings: { session_id: sessionId, path } };
}
