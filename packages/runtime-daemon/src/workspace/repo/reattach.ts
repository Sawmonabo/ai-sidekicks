// Re-attach: the recovery for a mount whose folder holds another repository than the one attached
// there. The old row turns `detached` and a new `attached` row takes its root under the same
// project, anchored on the repository git finds there now; no detach cascade runs, so the project,
// its sessions and the folder are untouched.
//
// - The refusals are decided before the write and re-tested inside it, so a refusal writes nothing.
// - Each workspace moves to the new mount keeping its id, mode and root. One with a root turns
//   `preparing` in the same write, its root kept, so no run binds it before it is admitted again;
//   events cannot share the mount write, so after the commit each is prepared again in place under
//   its preparation lock, by this service or by a run's gate, whichever comes first. One whose
//   root git does not list for the new repository turns `stale` with the reason recorded, and one
//   still in its first preparation has its bound folder admitted the same way.
// - Each tree the daemon made moves to the new mount in the same write when the new repository
//   lists its folder; any other is retired and stamped cleaned there, so its folder stays on disk
//   as it is and no sweep removes it. Its `worktree.retired` follows the commit.

import type { Statement } from "better-sqlite3";

import type { ProjectId } from "@ai-sidekicks/contracts/project";
import type {
  RepoMountReattachRequest,
  RepoMountReattachResponse,
} from "@ai-sidekicks/contracts/repo/folders";
import {
  ExecutionModeSchema,
  RepoMountIdSchema,
  type RepoMountId,
} from "@ai-sidekicks/contracts/repo/mount";
import { SessionIdSchema, type SessionId } from "@ai-sidekicks/contracts/session/id";

import { withCleanupFailures } from "../../cleanup-failures.js";
import type { DatabaseConnections } from "../../database/connection/lifecycle.js";
import { WriteRefusedError, type DatabaseWriter } from "../../database/writer.js";
import type { ServiceLogWriter } from "../../daemon/service-log.js";
import type { WorktreeEventEmitter } from "../../git/worktree/event-emitter.js";
import { canonicalFolderPath } from "../folder/canonical-path.js";
import { LIVE_WORKTREE_STATE_PREDICATE } from "../../git/worktree/rows.js";
import { describeRejection } from "../../rejection.js";
import { RunAgentReader } from "../../session/run/agent.js";
import { mintUuidV7 } from "../../uuid-v7.js";
import type { WorkspaceEventEmitter } from "../event-emitter.js";
import { workspacePreparationLock } from "../execution-root-service.js";
import {
  BOUND_ROOT_METADATA_PATH,
  COMMON_DIR_METADATA_PATH,
  LAST_ERROR_METADATA_PATH,
  createDefaultPathProbe,
  type FilesystemPathProbeFn,
} from "../row-guards.js";
import type { WorkspaceService } from "../service.js";
import { TrustEnvelopeValidator } from "../trust-envelope.js";
import {
  RepoAlreadyAttachedError,
  RepoMountManagedError,
  RepoMountNotFoundError,
  RepoReattachConflictError,
  RepoReattachRefusedError,
  RepoRootResolutionError,
  TrustEnvelopeViolationError,
} from "./errors.js";
import { probeRepoMountHealth, type RepoMountHealthSeams } from "./mount-health.js";
import { RepoMountServiceInvariantError, RUN_IN_PROJECT_PREDICATE } from "./mount-service.js";
import type { RepoRootResolver } from "./root-resolver.js";

interface ReattachMountRow {
  readonly id: string;
  readonly node_id: string;
  readonly canonical_root: string;
  readonly origin: string;
  readonly state: string;
  readonly project_id: string | null;
  readonly common_dir: string | null;
}

interface MovedWorkspaceRow {
  readonly id: string;
}

interface WorkspaceToPrepareRow {
  readonly id: string;
  readonly session_id: string;
  readonly repo_mount_id: string;
  readonly execution_mode: string;
  readonly state: string;
  readonly fs_root: string | null;
  readonly bound_root: string | null;
  readonly canonical_root: string;
}

// One binding set for every statement of the re-attach; a type alias, so it is a binding record.
type ReattachBindings = {
  readonly repo_mount_id: string;
  readonly node_id: string;
  readonly old_common_dir: string | null;
  readonly common_dir: string;
  readonly new_repo_mount_id: RepoMountId;
  /** A JSON array of the ids of the daemon's trees the new repository lists. */
  readonly listed_worktree_ids: string;
  readonly now: string;
};

interface LiveWorktreeRow {
  readonly id: string;
  readonly fs_root: string;
}

interface RetiredWorktreeRow {
  readonly id: string;
  readonly created_by_session_id: string;
}

interface IdentityHolderRow {
  readonly id: RepoMountId;
  readonly project_id: ProjectId | null;
}

interface RunningRunRow {
  readonly session_id: string;
  readonly run_id: string;
}

// The oldest unreleased run in the project, the one a conflict names.
const SELECT_RUNNING_RUN_SQL = `SELECT run_context.session_id, run_context.run_id
     FROM run_execution_contexts AS run_context
    WHERE ${RUN_IN_PROJECT_PREDICATE}
    ORDER BY run_context.created_at ASC, run_context.run_id ASC
    LIMIT 1`;

// Another attached mount of the repository the folder holds now.
const SELECT_IDENTITY_HOLDER_SQL = `SELECT id, project_id
     FROM repo_mounts
    WHERE node_id = @node_id
      AND state = 'attached'
      AND id <> @repo_mount_id
      AND json_extract(metadata, '${COMMON_DIR_METADATA_PATH}') = @common_dir
    ORDER BY id ASC
    LIMIT 1`;

// The workspaces that move, read inside the write so the list and the move agree.
const SELECT_MOVED_WORKSPACES_SQL = `SELECT id
     FROM workspaces
    WHERE repo_mount_id = @repo_mount_id AND state <> 'archived'
    ORDER BY created_at ASC, id ASC`;

// Compare-and-swap on the anchor the decision read: a concurrent re-attach or detach refuses it.
// The old row leaves `attached` first, since one root holds one attached row.
const DETACH_OLD_MOUNT_SQL = `UPDATE repo_mounts
      SET state = 'detached',
          updated_at = @now
    WHERE id = @repo_mount_id
      AND state = 'attached'
      AND json_extract(metadata, '${COMMON_DIR_METADATA_PATH}') = @old_common_dir`;

const INSERT_NEW_MOUNT_SQL = `INSERT INTO repo_mounts (
     id, node_id, local_path, canonical_root, vcs_type, origin, project_id, state,
     attached_at, updated_at, metadata
   )
   SELECT @new_repo_mount_id, node_id, local_path, canonical_root, vcs_type, origin, project_id,
          'attached', @now, @now, json_set('{}', '${COMMON_DIR_METADATA_PATH}', @common_dir)
     FROM repo_mounts
    WHERE id = @repo_mount_id`;

const MOVE_WORKSPACES_SQL = `UPDATE workspaces
      SET repo_mount_id = @new_repo_mount_id,
          updated_at = @now
    WHERE repo_mount_id = @repo_mount_id AND state <> 'archived'`;

// A moved workspace with a root waits, `preparing` with that root kept, until it is admitted
// again, so a run's gate prepares it before binding rather than binding the old repository's root.
const BEGIN_MOVED_PREPARATION_SQL = `UPDATE workspaces
      SET state = 'preparing',
          metadata = json_remove(metadata, '${LAST_ERROR_METADATA_PATH}'),
          updated_at = @now
    WHERE repo_mount_id = @new_repo_mount_id
      AND state IN ('ready', 'stale')
      AND fs_root IS NOT NULL`;

// A workspace and its mount's root, read under its preparation lock before it is prepared again.
const SELECT_WORKSPACE_TO_PREPARE_SQL = `SELECT workspace.id, workspace.session_id,
          workspace.repo_mount_id, workspace.execution_mode, workspace.state, workspace.fs_root,
          json_extract(workspace.metadata, '${BOUND_ROOT_METADATA_PATH}') AS bound_root,
          mount.canonical_root
     FROM workspaces AS workspace
     JOIN repo_mounts AS mount ON mount.id = workspace.repo_mount_id
    WHERE workspace.id = @workspace_id`;

// The daemon's live trees on the old mount, whose folders the new repository's list is read for.
const SELECT_LIVE_WORKTREES_SQL = `SELECT worktrees.id, worktrees.fs_root
     FROM worktrees
    WHERE worktrees.repo_mount_id = @repo_mount_id AND ${LIVE_WORKTREE_STATE_PREDICATE}`;

// A tree the new repository lists stays the daemon's, on the new mount.
const MOVE_LISTED_WORKTREES_SQL = `UPDATE worktrees
      SET repo_mount_id = @new_repo_mount_id,
          updated_at = @now
    WHERE worktrees.repo_mount_id = @repo_mount_id AND ${LIVE_WORKTREE_STATE_PREDICATE}
      AND worktrees.id IN (SELECT value FROM json_each(@listed_worktree_ids))`;

// The live trees left on the old mount once the listed ones moved: the ones retired next, read in
// the same write so the events sent after it name exactly those.
const SELECT_UNLISTED_WORKTREES_SQL = `SELECT worktrees.id, worktrees.created_by_session_id
     FROM worktrees
    WHERE worktrees.repo_mount_id = @repo_mount_id AND ${LIVE_WORKTREE_STATE_PREDICATE}
    ORDER BY worktrees.id ASC`;

// Every other live tree leaves the daemon's care: retired, and stamped cleaned in the same
// statement, so the sweep never removes its folder.
const RETIRE_UNLISTED_WORKTREES_SQL = `UPDATE worktrees
      SET state = 'retired',
          cleaned_at = @now,
          updated_at = @now
    WHERE worktrees.repo_mount_id = @repo_mount_id AND ${LIVE_WORKTREE_STATE_PREDICATE}`;

// Index of each re-tested refusal in the write.
const RUNNING_RUN_STATEMENT = 0;
const IDENTITY_HOLDER_STATEMENT = 1;
const DETACH_OLD_MOUNT_STATEMENT = 3;

/** Constructor dependencies of {@link RepoMountReattachService}. */
export interface RepoMountReattachServiceDeps {
  /** The daemon database: reads on its reader, the mount write through its writer. */
  readonly database: DatabaseConnections;
  /** The preparation primitives each moved workspace is prepared again through. */
  readonly workspaces: Pick<
    WorkspaceService,
    "beginRootPreparation" | "completeRootPreparation" | "failRootPreparation"
  >;
  /**
   * Where the new mount's healthy verdict is sent, once per session on it, and each moved
   * workspace's `workspace.preparing`, which the mount write could not carry.
   */
  readonly events: Pick<WorkspaceEventEmitter, "emitMountHealthChanged" | "emitWorkspacePreparing">;
  /** Where each tree the re-attach retired is announced, as a removal announces it. */
  readonly worktreeEvents: Pick<WorktreeEventEmitter, "emitWorktreeRetired">;
  /** Resolves the folder again exactly as attach resolves a path. */
  readonly resolver: RepoRootResolver;
  /** Where the new mount's `repo.attached` record is written. */
  readonly writeServiceLog: ServiceLogWriter;
  /** Re-admits each moved root; defaults to a stock validator over {@link resolver}. */
  readonly trustEnvelope?: TrustEnvelopeValidator;
  /** Reachability probe; defaults to the readability probe. */
  readonly probePath?: FilesystemPathProbeFn;
  /** ISO-8601 wall clock for `attached_at` and `updated_at`. */
  readonly now?: () => string;
  /** Mount-id source, default `mintUuidV7`. Ids are still parsed by `RepoMountIdSchema`. */
  readonly newRepoMountId?: () => string;
}

/**
 * Re-attaches a mount whose folder holds another repository now (`repo.mountReattach`), keeping
 * the project's sessions and every workspace id.
 */
export class RepoMountReattachService {
  readonly #workspaces: RepoMountReattachServiceDeps["workspaces"];
  readonly #events: RepoMountReattachServiceDeps["events"];
  readonly #worktreeEvents: RepoMountReattachServiceDeps["worktreeEvents"];
  readonly #resolver: RepoRootResolver;
  readonly #writeServiceLog: ServiceLogWriter;
  readonly #trustEnvelope: TrustEnvelopeValidator;
  readonly #mountHealthSeams: RepoMountHealthSeams;
  readonly #now: () => string;
  readonly #newRepoMountId: () => string;

  readonly #writer: Pick<DatabaseWriter, "write">;
  readonly #selectMountStmt: Statement;
  readonly #selectRunningRunStmt: Statement;
  readonly #selectIdentityHolderStmt: Statement;
  readonly #runAgents: RunAgentReader;
  readonly #selectAttachedMountRootsStmt: Statement;
  readonly #selectSessionsOnMountStmt: Statement;
  readonly #selectLiveWorktreesStmt: Statement<{ repo_mount_id: string }, LiveWorktreeRow>;
  readonly #selectWorkspaceToPrepareStmt: Statement<
    { workspace_id: string },
    WorkspaceToPrepareRow
  >;

  constructor(deps: RepoMountReattachServiceDeps) {
    this.#workspaces = deps.workspaces;
    this.#events = deps.events;
    this.#worktreeEvents = deps.worktreeEvents;
    this.#resolver = deps.resolver;
    this.#writeServiceLog = deps.writeServiceLog;
    this.#trustEnvelope =
      deps.trustEnvelope ?? new TrustEnvelopeValidator({ workingTrees: deps.resolver });
    this.#mountHealthSeams = {
      probePath: deps.probePath ?? createDefaultPathProbe(),
      resolver: deps.resolver,
    };
    this.#now = deps.now ?? ((): string => new Date().toISOString());
    this.#newRepoMountId = deps.newRepoMountId ?? mintUuidV7;

    const database = deps.database.reader;
    this.#writer = deps.database.writer;

    this.#selectMountStmt = database.prepare(
      `SELECT id, node_id, canonical_root, origin, state, project_id,
              json_extract(metadata, '${COMMON_DIR_METADATA_PATH}') AS common_dir
         FROM repo_mounts
        WHERE id = @repo_mount_id`,
    );
    this.#selectRunningRunStmt = database.prepare(SELECT_RUNNING_RUN_SQL);
    this.#selectIdentityHolderStmt = database.prepare(SELECT_IDENTITY_HOLDER_SQL);
    this.#runAgents = new RunAgentReader(database);
    this.#selectAttachedMountRootsStmt = database.prepare(
      `SELECT canonical_root FROM repo_mounts WHERE state = 'attached' ORDER BY canonical_root ASC`,
    );
    this.#selectSessionsOnMountStmt = database.prepare(
      `SELECT DISTINCT session_id
         FROM workspaces
        WHERE repo_mount_id = @repo_mount_id AND state <> 'archived'
        ORDER BY session_id ASC`,
    );
    this.#selectLiveWorktreesStmt = database.prepare(SELECT_LIVE_WORKTREES_SQL);
    this.#selectWorkspaceToPrepareStmt = database.prepare(SELECT_WORKSPACE_TO_PREPARE_SQL);
  }

  /**
   * Re-attach the mount at its root under the same project. Refuses, writing nothing:
   * `RepoMountNotFoundError` for a mount that is not attached, `RepoMountManagedError` for a chat's
   * managed workspace, `RepoReattachRefusedError` when the mount does not read `identity_mismatch`,
   * `RepoRootResolutionError` when the folder is no repository, resolves to another root or git
   * cannot answer for it (`vcs_error`),
   * `RepoReattachConflictError` while an agent runs in the project, and `RepoAlreadyAttachedError`
   * when another attached mount holds the folder's repository.
   */
  async reattach(request: RepoMountReattachRequest): Promise<RepoMountReattachResponse> {
    const mount = this.#requireAttachedMount(request.repoMountId);
    const health = await probeRepoMountHealth(
      { canonicalRoot: mount.canonical_root, commonDirAnchor: mount.common_dir },
      this.#mountHealthSeams,
    );
    if (health.status !== "identity_mismatch") {
      throw new RepoReattachRefusedError(mount.id);
    }
    if (!health.isRepository) {
      throw new RepoRootResolutionError("not_a_repository");
    }
    // Resolved exactly as attach resolves a path; the new row takes the old one's root.
    const resolution = await this.#resolver.resolveCanonicalRoot(mount.canonical_root);
    if (resolution.canonicalRoot !== mount.canonical_root) {
      throw new RepoRootResolutionError("root_mismatch");
    }

    const bindings: ReattachBindings = {
      repo_mount_id: mount.id,
      node_id: mount.node_id,
      old_common_dir: mount.common_dir,
      common_dir: resolution.commonDir,
      new_repo_mount_id: RepoMountIdSchema.parse(this.#newRepoMountId()),
      listed_worktree_ids: JSON.stringify(await this.#readListedWorktreeIds(mount)),
      now: this.#now(),
    };
    this.#refuseRunningRun(bindings);
    this.#refuseIdentityHolder(bindings);

    let movedWorkspaces: readonly MovedWorkspaceRow[];
    let retiredWorktrees: readonly RetiredWorktreeRow[];
    try {
      const [, , moved, , , , , , retired] = await this.#writer.write([
        { sql: SELECT_RUNNING_RUN_SQL, bindings, expectedRowCount: 0 },
        { sql: SELECT_IDENTITY_HOLDER_SQL, bindings, expectedRowCount: 0 },
        { sql: SELECT_MOVED_WORKSPACES_SQL, bindings },
        { sql: DETACH_OLD_MOUNT_SQL, bindings, expectedRowCount: 1 },
        { sql: INSERT_NEW_MOUNT_SQL, bindings, expectedRowCount: 1 },
        { sql: MOVE_WORKSPACES_SQL, bindings },
        { sql: BEGIN_MOVED_PREPARATION_SQL, bindings },
        { sql: MOVE_LISTED_WORKTREES_SQL, bindings },
        { sql: SELECT_UNLISTED_WORKTREES_SQL, bindings },
        { sql: RETIRE_UNLISTED_WORKTREES_SQL, bindings },
      ]);
      movedWorkspaces = (moved?.rows ?? []) as readonly MovedWorkspaceRow[];
      retiredWorktrees = (retired?.rows ?? []) as readonly RetiredWorktreeRow[];
    } catch (error) {
      throw this.#refusalOfWrite(error, bindings);
    }

    const newRepoMountId = bindings.new_repo_mount_id;
    this.#writeServiceLog(
      `repo.attached: project ${String(mount.project_id)} attached as mount ${newRepoMountId}, ` +
        `in place of mount ${mount.id}`,
    );

    // The re-attach is committed: every follow-up is attempted, and failures reported together.
    const failures: unknown[] = [];
    for (const tree of retiredWorktrees) {
      try {
        await this.#worktreeEvents.emitWorktreeRetired({
          // The tree's own session, as a removal's event names it.
          sessionId: tree.created_by_session_id,
          worktreeId: tree.id,
          repoMountId: mount.id,
        });
      } catch (error) {
        failures.push(error);
      }
    }
    for (const workspace of movedWorkspaces) {
      try {
        await this.prepareMovedWorkspace(workspace.id);
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await this.#announceHealth(mount.canonical_root, resolution.commonDir, newRepoMountId);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new RepoMountServiceInvariantError(
        `repo mount "${mount.id}" was re-attached as "${newRepoMountId}", but ${failures.length} ` +
          "follow-up(s) failed: a retired tree announced, a workspace prepared again or a " +
          "session told the new health",
        {
          kind: "reattach_follow_up_incomplete",
          repoMountId: newRepoMountId,
          cause: new AggregateError(failures),
        },
      );
    }
    return { repoMountId: newRepoMountId };
  }

  #requireAttachedMount(repoMountId: string): ReattachMountRow {
    const mount = this.#selectMountStmt.get({ repo_mount_id: repoMountId }) as
      | ReattachMountRow
      | undefined;
    if (mount === undefined || mount.state !== "attached") {
      throw new RepoMountNotFoundError(repoMountId);
    }
    if (mount.origin !== "attached") {
      throw new RepoMountManagedError(repoMountId);
    }
    return mount;
  }

  #refuseRunningRun(bindings: ReattachBindings): void {
    const run = this.#selectRunningRunStmt.get(bindings) as RunningRunRow | undefined;
    if (run !== undefined) {
      throw new RepoReattachConflictError(
        SessionIdSchema.parse(run.session_id),
        this.#runAgents.readAgent(run.session_id, run.run_id),
      );
    }
  }

  #refuseIdentityHolder(bindings: ReattachBindings): void {
    const holder = this.#selectIdentityHolderStmt.get(bindings) as IdentityHolderRow | undefined;
    if (holder !== undefined) {
      throw new RepoAlreadyAttachedError(holder.id, holder.project_id);
    }
  }

  // The daemon's live trees on the mount whose folder git lists for the repository there now.
  async #readListedWorktreeIds(mount: ReattachMountRow): Promise<readonly string[]> {
    const listed = new Set<string>();
    for (const root of await this.#resolver.listWorkingTrees(mount.canonical_root)) {
      listed.add(await canonicalFolderPath(root));
    }
    const listedIds: string[] = [];
    for (const tree of this.#selectLiveWorktreesStmt.all({ repo_mount_id: mount.id })) {
      if (listed.has(await canonicalFolderPath(tree.fs_root))) {
        listedIds.push(tree.id);
      }
    }
    return listedIds;
  }

  // A refused write as the refusal its re-test stands for; the write kept nothing.
  #refusalOfWrite(error: unknown, bindings: ReattachBindings): unknown {
    if (!(error instanceof WriteRefusedError)) {
      return error;
    }
    try {
      switch (error.statementIndex) {
        case RUNNING_RUN_STATEMENT:
          this.#refuseRunningRun(bindings);
          break;
        case IDENTITY_HOLDER_STATEMENT:
          this.#refuseIdentityHolder(bindings);
          break;
        case DETACH_OLD_MOUNT_STATEMENT:
          // A detach or re-attach moved the mount since it was read.
          this.#requireAttachedMount(bindings.repo_mount_id);
          break;
      }
    } catch (refusal) {
      return refusal;
    }
    return error;
  }

  /**
   * Admits a workspace a re-attach moved again at its own root, under its preparation lock. One
   * left `preparing` with its root kept turns `ready` there, or `stale` with the reason when the
   * new repository does not list that root; a stale bound-root one with only its bound folder is
   * prepared from that folder; one still in its first preparation has its bound folder admitted,
   * turning `stale` when it is refused. Any other workspace is left as it is. The run-setup gate
   * calls it for a moved workspace it meets first.
   */
  async prepareMovedWorkspace(workspaceId: string): Promise<void> {
    await workspacePreparationLock.run(workspaceId, async () => {
      const workspace = this.#selectWorkspaceToPrepareStmt.get({ workspace_id: workspaceId });
      if (workspace === undefined) {
        return;
      }
      const executionMode = ExecutionModeSchema.parse(workspace.execution_mode);
      if (workspace.state === "preparing" && workspace.fs_root !== null) {
        await this.#events.emitWorkspacePreparing({
          sessionId: workspace.session_id,
          workspaceId: workspace.id,
          repoMountId: workspace.repo_mount_id,
        });
        await this.#admitRoot(workspace, workspace.fs_root, { isCompleting: true });
      } else if (
        workspace.state === "stale" &&
        workspace.fs_root === null &&
        executionMode === "bound-root" &&
        workspace.bound_root !== null
      ) {
        await this.#workspaces.beginRootPreparation(workspace.id, executionMode);
        await this.#admitRoot(workspace, workspace.bound_root, { isCompleting: true });
      } else if (workspace.state === "preparing" && workspace.bound_root !== null) {
        await this.#admitRoot(workspace, workspace.bound_root, { isCompleting: false });
      }
    });
  }

  // Admits `root` on the workspace's mount: completing the preparation there when `isCompleting`,
  // else leaving the first preparation to run. A refused folder ends the preparation `stale` with
  // the reason; any other failure does too once the root was dropped, and is thrown.
  async #admitRoot(
    workspace: WorkspaceToPrepareRow,
    root: string,
    { isCompleting }: { readonly isCompleting: boolean },
  ): Promise<void> {
    try {
      const admitted = await this.#trustEnvelope.validateExecutionRoot({
        mountCanonicalRoot: workspace.canonical_root,
        directory: root,
        attachedMountRoots: this.#readAttachedMountRoots(),
      });
      if (isCompleting) {
        await this.#workspaces.completeRootPreparation(workspace.id, admitted.executionRoot, {
          checkoutRoot: admitted.checkoutRoot,
        });
      }
    } catch (error) {
      const isRefusedFolder =
        error instanceof TrustEnvelopeViolationError || error instanceof RepoRootResolutionError;
      // A first preparation that met a failure other than a refusal is left to run again.
      if (!isCompleting && !isRefusedFolder) {
        throw error;
      }
      // A workspace left `preparing` with a root it may not keep would refuse every run.
      const recordingFailures: unknown[] = [];
      try {
        await this.#workspaces.failRootPreparation(workspace.id, describeRejection(error));
      } catch (recordingFailure) {
        recordingFailures.push(recordingFailure);
      }
      if (isRefusedFolder && recordingFailures.length === 0) {
        return;
      }
      throw withCleanupFailures(error, recordingFailures, "workspace preparation");
    }
  }

  #readAttachedMountRoots(): readonly string[] {
    const rows = this.#selectAttachedMountRootsStmt.all() as ReadonlyArray<{
      readonly canonical_root: string;
    }>;
    return rows.map((row) => row.canonical_root);
  }

  // Sends the new mount's verdict to every session on it, which takes the mismatch banner away.
  async #announceHealth(
    canonicalRoot: string,
    commonDir: string,
    repoMountId: RepoMountId,
  ): Promise<void> {
    const health = await probeRepoMountHealth(
      { canonicalRoot, commonDirAnchor: commonDir },
      this.#mountHealthSeams,
    );
    const sessions = this.#selectSessionsOnMountStmt.all({
      repo_mount_id: repoMountId,
    }) as ReadonlyArray<{ readonly session_id: string }>;
    for (const session of sessions) {
      const sessionId: SessionId = SessionIdSchema.parse(session.session_id);
      await this.#events.emitMountHealthChanged({ sessionId, repoMountId, health });
    }
  }
}
