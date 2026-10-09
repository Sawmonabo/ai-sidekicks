/**
 * Repo-mount lifecycle service, the daemon-side owner of the `repo_mounts` table. An attached
 * mount belongs to the machine and serves one project: attach stamps the daemon's node id, writes
 * no workspace and appends no event. A managed mount is one chat's own workspace folder, attached
 * at that chat's create and deleted with it.
 *
 * - Attach has no containment check: attaching a path is what admits it to the trust envelope.
 * - A repository is attached once: its identity is its git common directory, kept on the mount as
 *   `metadata.commonDir` and compared inside the INSERT, with `idx_repo_mounts_active_root` as the
 *   backstop for one root; a pre-read only refuses early.
 * - Attach resolves first and inserts second, so the project writer can create the project row
 *   and its mount in one write.
 * - Detach checks for running agents in the project, archives and flips the mount in one write,
 *   then appends `workspace.archived` events, so a crash leaves rows durable and events missing. A
 *   managed mount is never detached.
 * - On Windows bare `git` resolves from the working directory first, so the daemon hands this
 *   service a resolver whose runner names the absolute `git` it found at start.
 */

import type { Statement } from "better-sqlite3";

import { NodeIdSchema, type NodeId } from "@ai-sidekicks/contracts/runtime-node/id";
import type { ProjectId } from "@ai-sidekicks/contracts/project";
import {
  RepoAttachResponseSchema,
  type RepoMountOrigin,
  type RepoAttachRequest,
  type RepoAttachResponse,
  type RepoDetachRequest,
  type RepoDetachResponse,
  type RepoMountReadResponse,
} from "@ai-sidekicks/contracts/repo/folders";
import {
  RepoMountIdSchema,
  RepoMountStateSchema,
  VcsTypeSchema,
  WorkspaceIdSchema,
  type RepoMountHealth,
  type RepoMountId,
  type RepoMountState,
  type VcsType,
  type WorkspaceState,
} from "@ai-sidekicks/contracts/repo/mount";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { DatabaseConnections } from "../../database/connection/lifecycle.js";
import type { StatementResult, WriteStatement } from "../../database/statement.js";
import { WriteRefusedError, type DatabaseWriter } from "../../database/writer.js";
import {
  RepoAlreadyAttachedError,
  RepoDetachConflictError,
  RepoMountManagedError,
  RepoMountNotFoundError,
} from "./errors.js";
import { probeRepoMountHealth, type RepoMountHealthSeams } from "./mount-health.js";
import { RepoRootResolver } from "./root-resolver.js";
import { hasSqliteErrorCode } from "../../session/sqlite-error-code.js";
import type { WorkspaceEventEmitter } from "../event-emitter.js";
import {
  COMMON_DIR_METADATA_PATH,
  createDefaultPathProbe,
  type FilesystemPathProbeFn,
} from "../row-guards.js";
import { mintUuidV7 } from "../../uuid-v7.js";

/**
 * The daemon-internal failure classes of the mount services here and in `./reattach.js`, one class
 * with a discriminant. All reach the wire as an anonymous internal error.
 */
export type RepoMountServiceInvariantKind =
  /** A mount row cannot be projected through the contract schemas (corruption or a bad id). */
  | "repo_mount_row_unprojectable"
  /**
   * The detach committed but a post-commit `workspace.archived` append failed, so the log
   * under-reports the archived rows. No wire code exists for this.
   */
  | "detach_notification_incomplete"
  /**
   * The re-attach committed but a retired tree could not be announced, a moved workspace could not
   * be prepared again, or a session could not be told the new mount's health.
   */
  | "reattach_follow_up_incomplete";

/**
 * A daemon-internal failure with no wire code. Not a `DaemonDomainError` (unregistered `repo.*`
 * codes are banned), so it reaches IPC as an anonymous `-32603`.
 */
export class RepoMountServiceInvariantError extends Error {
  readonly kind: RepoMountServiceInvariantKind;
  /** The mount this failure attaches to, or `null` when no mount is implicated. */
  readonly repoMountId: string | null;

  constructor(
    message: string,
    options: {
      readonly kind: RepoMountServiceInvariantKind;
      readonly repoMountId?: string | null;
      readonly cause?: unknown;
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.kind = options.kind;
    this.repoMountId = options.repoMountId ?? null;
  }
}

interface RepoMountRow {
  readonly id: string;
  readonly node_id: string;
  readonly local_path: string;
  readonly canonical_root: string;
  readonly vcs_type: string;
  readonly origin: string;
  readonly state: string;
  readonly attached_at: string;
  readonly common_dir: string | null;
}

interface RunningSessionRow {
  readonly session_id: string;
}

interface DependentWorkspaceRow {
  readonly id: string;
  readonly session_id: string;
}

// The machine's attached mount of one repository.
interface ActiveMountRow {
  readonly id: RepoMountId;
  readonly canonical_root: string;
  readonly vcs_type: string;
  readonly origin: string;
  /** `null` on a chat's managed mount. */
  readonly project_id: ProjectId | null;
}

/** Constructor dependencies. Every optional member defaults to the real one. */
export interface RepoMountServiceDeps {
  /** The daemon database: reads on its reader, writes through its writer. */
  readonly database: DatabaseConnections;
  /** The seam through which the detach cascade's `workspace.archived` events are appended. */
  readonly events: WorkspaceEventEmitter;
  /** The daemon's own node id, stamped on every mount it attaches. */
  readonly nodeId: NodeId;
  /** Defaults to a stock `RepoRootResolver`, which runs bare `git`. */
  readonly resolver?: RepoRootResolver;
  /**
   * Reachability probe for {@link RepoMountService.read}. The default reads the clock before the
   * probe, so `checkedAt` is never newer than the observation it timestamps.
   */
  readonly probePath?: FilesystemPathProbeFn;
  /** ISO-8601 wall clock for `attached_at` and `updated_at`. */
  readonly now?: () => string;
  /** Mount-id source, default `mintUuidV7`. Ids are still parsed by `RepoMountIdSchema`. */
  readonly newRepoMountId?: () => string;
}

/**
 * A path resolved for attach and found unattached, which
 * {@link RepoMountService.insertAttachedMount} persists. The repository may be attached between
 * the two calls; the insert refuses it then.
 */
export interface RepoAttachTarget {
  /** The path as entered, kept as provenance. */
  readonly localPath: string;
  readonly canonicalRoot: string;
  /** The repository's canonicalized git common directory, the mount's identity anchor. */
  readonly commonDir: string;
  readonly vcsType: VcsType;
}

/**
 * One mount's row facts with a freshly probed health verdict. The `repo.mountRead` reply adds the
 * folder's origin, project name and sessions using it.
 */
export type RepoMountRecord = Omit<RepoMountReadResponse, "origin" | "displayName" | "usedBy">;

/**
 * What a detach did to the mount and its workspaces. The `repo.detach` reply adds the forgotten
 * project and archived sessions.
 */
export type RepoMountDetachOutcome = Omit<
  RepoDetachResponse,
  "archivedSessionIds" | "forgottenProjectId"
>;

/** Inputs for {@link RepoMountService.attachManaged}. */
export interface AttachManagedMountInput {
  /** The one chat the mount belongs to. */
  readonly sessionId: SessionId;
  /** The workspace folder: absolute and symlink-resolved, as every mount root is. */
  readonly canonicalRoot: string;
}

/** Inputs for {@link RepoMountService.detach}. */
export interface DetachRepoMountInput extends RepoDetachRequest {
  /** Envelope actor; defaults to the system actor. */
  readonly actor?: string | null;
  /** Envelope linkage, threaded onto every cascaded `workspace.archived`. */
  readonly correlationId?: string | null;
}

// The state literals are `satisfies`-pinned to the contracts unions: they are interpolated into
// SQL below, where a typo would silently match nothing.
const ATTACHED_MOUNT_STATE = "attached" satisfies RepoMountState;

const DETACHED_MOUNT_STATE = "detached" satisfies RepoMountState;

const ARCHIVED_WORKSPACE_STATE = "archived" satisfies WorkspaceState;

const ATTACHED_MOUNT_ORIGIN = "attached" satisfies RepoMountOrigin["kind"];

const MANAGED_MOUNT_ORIGIN = "managed" satisfies RepoMountOrigin["kind"];

// A chat's workspace is a git repository the daemon itself initialized.
const MANAGED_MOUNT_VCS_TYPE = "git" satisfies VcsType;

// An attached mount of a repository the machine has no active mount of, compared by identity
// anchor inside the write; zero rows refuses it.
const INSERT_ATTACHED_MOUNT_SQL = `INSERT INTO repo_mounts (
     id, node_id, local_path, canonical_root, vcs_type, origin, project_id, state,
     attached_at, updated_at, metadata
   )
   SELECT @id, @node_id, @local_path, @canonical_root, @vcs_type, '${ATTACHED_MOUNT_ORIGIN}',
          @project_id, '${ATTACHED_MOUNT_STATE}', @now, @now,
          json_set('{}', '${COMMON_DIR_METADATA_PATH}', @common_dir)
    WHERE NOT EXISTS (
      SELECT 1 FROM repo_mounts
       WHERE node_id = @node_id
         AND state = '${ATTACHED_MOUNT_STATE}'
         AND json_extract(metadata, '${COMMON_DIR_METADATA_PATH}') = @common_dir)`;

// A chat's managed mount; the daemon chose its folder, so it carries no identity anchor.
const INSERT_MANAGED_MOUNT_SQL = `INSERT INTO repo_mounts (
     id, node_id, local_path, canonical_root, vcs_type, origin, managed_session_id, state,
     attached_at, updated_at
   ) VALUES (
     @id, @node_id, @canonical_root, @canonical_root, '${MANAGED_MOUNT_VCS_TYPE}',
     '${MANAGED_MOUNT_ORIGIN}', @managed_session_id, '${ATTACHED_MOUNT_STATE}', @now, @now
   )`;

// The workspaces on the chat's managed mount.
const MANAGED_WORKSPACE_IDS_SQL = `SELECT workspace.id
     FROM workspaces AS workspace
     JOIN repo_mounts AS mount ON mount.id = workspace.repo_mount_id
    WHERE mount.managed_session_id = @session_id`;

// Each row that names a workspace on the mount goes before it, and each workspace before the mount,
// because every foreign key holds on DELETE too.
const DELETE_MANAGED_MOUNT_SQL: readonly string[] = [
  `DELETE FROM run_execution_contexts WHERE workspace_id IN (${MANAGED_WORKSPACE_IDS_SQL})`,
  `DELETE FROM branch_contexts WHERE workspace_id IN (${MANAGED_WORKSPACE_IDS_SQL})`,
  `DELETE FROM workspaces
    WHERE repo_mount_id IN (SELECT id FROM repo_mounts WHERE managed_session_id = @session_id)`,
  "DELETE FROM repo_mounts WHERE managed_session_id = @session_id",
];

/**
 * The statements that delete a chat's managed mount row with every workspace on it and the run and
 * branch rows naming those workspaces, in foreign-key order; a session with none matches nothing.
 * They go in one write, alone or inside the purge's.
 */
export function managedMountDeletionStatements(sessionId: SessionId): readonly WriteStatement[] {
  return DELETE_MANAGED_MOUNT_SQL.map((sql) => ({ sql, bindings: { session_id: sessionId } }));
}

/**
 * SQL that is true while an agent runs anywhere in the project `@repo_mount_id` serves: a run whose
 * execution root is unreleased, in a workspace on any of the project's mounts. A predicate over the
 * `run_context` alias of `run_execution_contexts`.
 */
export const RUN_IN_PROJECT_PREDICATE: string = `run_context.released_at IS NULL
   AND run_context.workspace_id IN (
     SELECT project_workspace.id
       FROM workspaces AS project_workspace
       JOIN repo_mounts AS project_mount ON project_mount.id = project_workspace.repo_mount_id
      WHERE project_mount.id = @repo_mount_id
         OR project_mount.project_id = (
              SELECT project_id FROM repo_mounts WHERE id = @repo_mount_id))`;

// The detach's four statements run as one write, so the running check, the archive and the flip
// see one state; a running run or a lost flip refuses the write whole. The oldest unreleased run's
// session is the one a refusal names; `run_id` breaks ties between runs started in the same tick.
const SELECT_RUNNING_SESSION_SQL = `SELECT run_context.session_id
     FROM run_execution_contexts AS run_context
    WHERE ${RUN_IN_PROJECT_PREDICATE}
    ORDER BY run_context.created_at ASC, run_context.run_id ASC
    LIMIT 1`;
const RUNNING_SESSION_STATEMENT = 0;
const DETACH_MOUNT_STATEMENT = 3;

// The dependents the archive below moves, in event order; read in the same write, so the list
// and the archive agree.
const SELECT_ARCHIVABLE_DEPENDENTS_SQL = `SELECT id, session_id
     FROM workspaces
    WHERE repo_mount_id = @repo_mount_id AND state <> '${ARCHIVED_WORKSPACE_STATE}'
    ORDER BY created_at ASC, id ASC`;

const ARCHIVE_DEPENDENTS_SQL = `UPDATE workspaces
      SET state = '${ARCHIVED_WORKSPACE_STATE}',
          updated_at = @now
    WHERE repo_mount_id = @repo_mount_id
      AND state <> '${ARCHIVED_WORKSPACE_STATE}'`;

// Compare-and-swap: `attached` in the predicate is the legal-predecessor rule and the mutual
// exclusion between concurrent detaches and re-attaches.
const DETACH_MOUNT_SQL = `UPDATE repo_mounts
      SET state = '${DETACHED_MOUNT_STATE}',
          updated_at = @now
    WHERE id = @repo_mount_id
      AND state = '${ATTACHED_MOUNT_STATE}'`;

/**
 * Owns the `repo_mounts` table's attach, read and detach; the re-attach is `./reattach.js`'s. The
 * detach cascade also archives the mount's `workspaces` rows here, and a managed mount's deletion
 * deletes them, because each must share one write with the mount row it follows.
 */
export class RepoMountService {
  readonly #events: WorkspaceEventEmitter;
  readonly #nodeId: NodeId;
  readonly #resolver: RepoRootResolver;
  readonly #mountHealthSeams: RepoMountHealthSeams;
  readonly #now: () => string;
  readonly #newRepoMountId: () => string;

  readonly #writer: Pick<DatabaseWriter, "write">;
  readonly #selectMountStmt: Statement;
  readonly #selectActiveMountOfRepositoryStmt: Statement;
  readonly #selectManagedRootStmt: Statement;
  readonly #selectRunningSessionStmt: Statement<{ repo_mount_id: string }, RunningSessionRow>;

  constructor(deps: RepoMountServiceDeps) {
    this.#events = deps.events;
    this.#nodeId = deps.nodeId;
    this.#resolver = deps.resolver ?? new RepoRootResolver();
    this.#mountHealthSeams = {
      probePath: deps.probePath ?? createDefaultPathProbe(),
      resolver: this.#resolver,
    };
    this.#now = deps.now ?? ((): string => new Date().toISOString());
    this.#newRepoMountId = deps.newRepoMountId ?? mintUuidV7;

    const database = deps.database.reader;
    this.#writer = deps.database.writer;

    // Unscoped by state: a read must answer for a `detached` mount.
    this.#selectMountStmt = database.prepare(
      `SELECT id, node_id, local_path, canonical_root, vcs_type, origin, state, attached_at,
              json_extract(metadata, '${COMMON_DIR_METADATA_PATH}') AS common_dir
         FROM repo_mounts
        WHERE id = @repo_mount_id`,
    );

    // Behind `repo.already_attached` and the folder's mount lookup: the machine's attached mount
    // at the root (`idx_repo_mounts_active_root`'s predicate) or with the identity anchor. A
    // mount at the root comes first.
    this.#selectActiveMountOfRepositoryStmt = database.prepare(
      `SELECT id, canonical_root, vcs_type, origin, project_id
         FROM repo_mounts
        WHERE node_id = @node_id
          AND state = '${ATTACHED_MOUNT_STATE}'
          AND (canonical_root = @canonical_root
               OR json_extract(metadata, '${COMMON_DIR_METADATA_PATH}') = @common_dir)
        ORDER BY canonical_root = @canonical_root DESC, id ASC
        LIMIT 1`,
    );

    this.#selectManagedRootStmt = database.prepare(
      `SELECT canonical_root FROM repo_mounts WHERE managed_session_id = @session_id`,
    );
    this.#selectRunningSessionStmt = database.prepare<{ repo_mount_id: string }, RunningSessionRow>(
      SELECT_RUNNING_SESSION_SQL,
    );
  }

  /**
   * Resolve a path for attach and check the machine has no active mount of its repository, writing
   * nothing. Throws `RepoRootResolutionError`, or `RepoAlreadyAttachedError` naming the mount that
   * holds the repository.
   */
  async resolveAttachTarget(input: RepoAttachRequest): Promise<RepoAttachTarget> {
    // No fallback to the entered path: a non-resolution throws.
    const resolution = await this.#resolver.resolveCanonicalRoot(input.localPath);
    const holder = this.#findActiveMountOfRepository(resolution);
    if (holder !== undefined) {
      throw new RepoAlreadyAttachedError(holder.id, holder.project_id);
    }
    return {
      localPath: input.localPath,
      canonicalRoot: resolution.canonicalRoot,
      commonDir: resolution.commonDir,
      vcsType: resolution.vcsType,
    };
  }

  /**
   * Persist a resolved target as the mount of `projectId`, in one write after `projectStatements`
   * (the project row a new project needs, written with its mount or not at all). Throws
   * `RepoAlreadyAttachedError` when the repository was attached since it was resolved.
   */
  async insertAttachedMount(
    target: RepoAttachTarget,
    projectId: ProjectId,
    projectStatements: readonly WriteStatement[] = [],
  ): Promise<RepoAttachResponse> {
    const repoMountId = this.#newRepoMountId();
    // Project before the write, so an identity the wire cannot carry fails while nothing is
    // durable.
    const response = this.#projectAttachResponse({
      repoMountId,
      canonicalRoot: target.canonicalRoot,
      vcsType: target.vcsType,
    });
    try {
      await this.#writer.write([
        ...projectStatements,
        {
          sql: INSERT_ATTACHED_MOUNT_SQL,
          bindings: {
            id: repoMountId,
            node_id: this.#nodeId,
            local_path: target.localPath,
            canonical_root: target.canonicalRoot,
            vcs_type: target.vcsType,
            project_id: projectId,
            common_dir: target.commonDir,
            now: this.#now(),
          },
          expectedRowCount: 1,
        },
      ]);
    } catch (error) {
      throw this.#refusalOfInsert(error, target, projectStatements.length);
    }
    return response;
  }

  /**
   * The folder at `localPath` resolved the way attach resolves it, attaching nothing: its canonical
   * root, and the attached project mount of its repository, or `undefined` when none holds it. A
   * chat's managed workspace is never a project, so its mount is never answered. Throws
   * `RepoRootResolutionError` for a path that resolves to no repository.
   */
  async resolveFolder(
    input: RepoAttachRequest,
  ): Promise<{ readonly canonicalRoot: string; readonly repoMountId: RepoMountId | undefined }> {
    const resolution = await this.#resolver.resolveCanonicalRoot(input.localPath);
    const mount = this.#findActiveMountOfRepository(resolution);
    return {
      canonicalRoot: resolution.canonicalRoot,
      repoMountId: mount?.origin === ATTACHED_MOUNT_ORIGIN ? mount.id : undefined,
    };
  }

  /** The folder of the chat's managed workspace, or `undefined` when the session has none. */
  readManagedRoot(sessionId: SessionId): string | undefined {
    const row = this.#selectManagedRootStmt.get({ session_id: sessionId }) as
      | { readonly canonical_root: string }
      | undefined;
    return row?.canonical_root;
  }

  /**
   * Register a chat's workspace folder as its managed mount, before the folder exists: the
   * daemon chose the root, so nothing is resolved. Throws `RepoAlreadyAttachedError` when the
   * root, which the session id names, is already attached.
   */
  async attachManaged(input: AttachManagedMountInput): Promise<RepoMountId> {
    const repoMountId = RepoMountIdSchema.parse(this.#newRepoMountId());
    try {
      await this.#writer.write([
        {
          sql: INSERT_MANAGED_MOUNT_SQL,
          bindings: {
            id: repoMountId,
            node_id: this.#nodeId,
            canonical_root: input.canonicalRoot,
            managed_session_id: input.sessionId,
            now: this.#now(),
          },
        },
      ]);
    } catch (error) {
      const identity = { canonicalRoot: input.canonicalRoot, commonDir: null };
      throw this.#refusalOfInsert(error, identity, 0);
    }
    return repoMountId;
  }

  /**
   * Delete a chat's managed mount row and every row on it, in one write. A session with no managed
   * mount writes nothing, so a repeat is safe.
   */
  async deleteManaged(sessionId: SessionId): Promise<void> {
    await this.#writer.write(managedMountDeletionStatements(sessionId));
  }

  /**
   * Read one mount's facts, in any state, with a freshly probed health verdict. Throws
   * `RepoMountNotFoundError`, and `RepoRootResolutionError` (`vcs_error`) when git cannot answer
   * for the root. The probe gets `canonical_root` verbatim: the projector compares paths byte for
   * byte.
   */
  async read(repoMountId: RepoMountId): Promise<RepoMountRecord> {
    const row = this.#requireMountRow(repoMountId);
    const health = await probeRepoMountHealth(
      { canonicalRoot: row.canonical_root, commonDirAnchor: row.common_dir },
      this.#mountHealthSeams,
    );
    return this.#projectMountRecord(row, health);
  }

  /**
   * Detach a mount and archive its workspaces (a no-op if not `attached`), running
   * `followingStatements` (the project writer's forgetting of the record) in the same write after
   * the flip. Refuses a chat's managed mount with `RepoMountManagedError`, and refuses with
   * `RepoDetachConflictError`, naming the running session, while an agent runs anywhere in its
   * project (a run whose execution root is unreleased). Rejects with
   * `detach_notification_incomplete` if committed but an event append failed; the rows are the
   * truth and a rerun is a no-op.
   */
  async detach(
    input: DetachRepoMountInput,
    followingStatements: readonly WriteStatement[] = [],
  ): Promise<RepoMountDetachOutcome> {
    const actor = input.actor ?? null;
    const correlationId = input.correlationId ?? null;
    const repoMountId = input.repoMountId;

    const row = this.#requireMountRow(repoMountId);
    // A chat's managed workspace goes only with its chat's purge, so it is no detach target. The
    // origin never changes, so the row read decides it.
    if (row.origin !== ATTACHED_MOUNT_ORIGIN) {
      throw new RepoMountManagedError(repoMountId);
    }
    if (row.state !== ATTACHED_MOUNT_STATE) {
      return this.#projectDetachOutcome(repoMountId, row.state, []);
    }

    const bindings = { repo_mount_id: repoMountId, now: this.#now() };
    let archivable: StatementResult | undefined;
    try {
      [, archivable] = await this.#writer.write([
        { sql: SELECT_RUNNING_SESSION_SQL, bindings, expectedRowCount: 0 },
        { sql: SELECT_ARCHIVABLE_DEPENDENTS_SQL, bindings },
        { sql: ARCHIVE_DEPENDENTS_SQL, bindings },
        { sql: DETACH_MOUNT_SQL, bindings, expectedRowCount: 1 },
        ...followingStatements,
      ]);
    } catch (error) {
      if (!(error instanceof WriteRefusedError)) throw error;
      if (error.statementIndex === RUNNING_SESSION_STATEMENT) {
        const running = this.#selectRunningSessionStmt.get({ repo_mount_id: repoMountId });
        if (running !== undefined) throw new RepoDetachConflictError(running.session_id);
      }
      // A concurrent detach or re-attach won, so this write changed nothing: report its state.
      const current = this.#requireMountRow(repoMountId);
      const isLostFlip = error.statementIndex === DETACH_MOUNT_STATEMENT;
      if (isLostFlip && current.state !== ATTACHED_MOUNT_STATE) {
        return this.#projectDetachOutcome(repoMountId, current.state, []);
      }
      throw error;
    }
    const archivedWorkspaces = (archivable?.rows ?? []) as readonly DependentWorkspaceRow[];

    // After the commit, so a crash cannot log archivals for rows that never moved. Every append
    // is attempted even after a failure; failures are rethrown below.
    const failures: unknown[] = [];
    for (const workspace of archivedWorkspaces) {
      try {
        await this.#events.emitWorkspaceArchived({
          sessionId: workspace.session_id,
          workspaceId: workspace.id,
          repoMountId,
          actor,
          correlationId,
        });
      } catch (error) {
        failures.push(error);
      }
    }

    const archivedWorkspaceIds = archivedWorkspaces.map((workspace) => workspace.id);
    if (failures.length > 0) {
      // Wrapped, not rethrown bare: a bare append failure reads as "detach failed, retry it",
      // but the detach committed.
      throw new RepoMountServiceInvariantError(
        `repo mount "${repoMountId}" detached and archived ${archivedWorkspaceIds.length} ` +
          `workspace(s), but ${failures.length} workspace.archived append(s) failed; the rows ` +
          `are committed and the log under-reports them`,
        {
          kind: "detach_notification_incomplete",
          repoMountId,
          cause: failures[0],
        },
      );
    }

    return this.#projectDetachOutcome(repoMountId, DETACHED_MOUNT_STATE, archivedWorkspaceIds);
  }

  // The machine's attached mount at the root or of the repository, the root's first.
  #findActiveMountOfRepository(identity: {
    readonly canonicalRoot: string;
    readonly commonDir: string | null;
  }): ActiveMountRow | undefined {
    return this.#selectActiveMountOfRepositoryStmt.get({
      node_id: this.#nodeId,
      canonical_root: identity.canonicalRoot,
      common_dir: identity.commonDir,
    }) as ActiveMountRow | undefined;
  }

  // A refused or constraint-failed mount INSERT as `repo.already_attached`, when an active mount
  // of the repository explains it; anything else is returned unchanged. The failed write is undone
  // whole, so the lookup sees the rows as they were.
  #refusalOfInsert(
    error: unknown,
    identity: { readonly canonicalRoot: string; readonly commonDir: string | null },
    insertIndex: number,
  ): unknown {
    const isInsertRefusal =
      (error instanceof WriteRefusedError && error.statementIndex === insertIndex) ||
      hasSqliteErrorCode(error, "SQLITE_CONSTRAINT");
    if (!isInsertRefusal) {
      return error;
    }
    // With no holder, another constraint failed (id collision, a project's second mount, a
    // CHECK): the caller must not be sent to detach a mount that does not exist.
    const holder = this.#findActiveMountOfRepository(identity);
    return holder === undefined
      ? error
      : new RepoAlreadyAttachedError(holder.id, holder.project_id);
  }

  /** Fetch a mount row in any state, or refuse with `repo.not_found`. */
  #requireMountRow(repoMountId: string): RepoMountRow {
    const row = this.#selectMountStmt.get({ repo_mount_id: repoMountId }) as
      | RepoMountRow
      | undefined;
    if (row === undefined) {
      throw new RepoMountNotFoundError(repoMountId);
    }
    return row;
  }

  #projectAttachResponse(fields: {
    readonly repoMountId: string;
    readonly canonicalRoot: string;
    readonly vcsType: string;
  }): RepoAttachResponse {
    try {
      return RepoAttachResponseSchema.parse({
        repoMountId: fields.repoMountId,
        state: ATTACHED_MOUNT_STATE,
        vcsType: fields.vcsType,
        canonicalRoot: fields.canonicalRoot,
      });
    } catch (error) {
      throw new RepoMountServiceInvariantError(
        `repo mount "${fields.repoMountId}" cannot be projected onto the attach response`,
        { kind: "repo_mount_row_unprojectable", repoMountId: fields.repoMountId, cause: error },
      );
    }
  }

  /** Parses each fact through its contract schema so an unrepresentable row fails here. */
  #projectMountRecord(row: RepoMountRow, health: RepoMountHealth): RepoMountRecord {
    try {
      return {
        id: RepoMountIdSchema.parse(row.id),
        nodeId: NodeIdSchema.parse(row.node_id),
        localPath: row.local_path,
        canonicalRoot: row.canonical_root,
        vcsType: VcsTypeSchema.parse(row.vcs_type),
        state: RepoMountStateSchema.parse(row.state),
        health,
        attachedAt: row.attached_at,
      };
    } catch (error) {
      throw new RepoMountServiceInvariantError(
        `repo mount "${row.id}" cannot be projected onto the mount record`,
        { kind: "repo_mount_row_unprojectable", repoMountId: row.id, cause: error },
      );
    }
  }

  #projectDetachOutcome(
    repoMountId: string,
    state: string,
    archivedWorkspaceIds: readonly string[],
  ): RepoMountDetachOutcome {
    try {
      return {
        repoMountId: RepoMountIdSchema.parse(repoMountId),
        state: RepoMountStateSchema.parse(state),
        archivedWorkspaceIds: archivedWorkspaceIds.map((workspaceId) =>
          WorkspaceIdSchema.parse(workspaceId),
        ),
      };
    } catch (error) {
      throw new RepoMountServiceInvariantError(
        `repo mount "${repoMountId}" cannot be projected onto the detach outcome`,
        { kind: "repo_mount_row_unprojectable", repoMountId, cause: error },
      );
    }
  }
}
