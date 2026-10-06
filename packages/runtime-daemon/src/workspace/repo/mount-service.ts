/**
 * Repo-mount lifecycle service, the daemon-side owner of the `repo_mounts` table. A mount belongs
 * to the machine, not a session: attach stamps the daemon's node id, writes no workspace and
 * appends no event.
 *
 * - Attach has no containment check: attaching a path is what admits it to the trust envelope.
 * - A duplicate root is caught by `idx_repo_mounts_active_root` on the INSERT; a pre-read races.
 * - Detach checks for running agents, archives and flips the mount in one write, then appends
 *   `workspace.archived` events, so a crash leaves rows durable and events missing.
 * - On Windows bare `git` resolves from the working directory first, so config supplies an
 *   absolute `gitExecutablePath`.
 */

import type { Statement } from "better-sqlite3";

import { NodeIdSchema, type NodeId } from "@ai-sidekicks/contracts/runtime-node/id";
import {
  RepoAttachResponseSchema,
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
  type RepoMountId,
  type RepoMountState,
  type WorkspaceState,
} from "@ai-sidekicks/contracts/repo/mount";

import type { DatabaseConnections } from "../../database/connections.js";
import {
  RepoAlreadyAttachedError,
  RepoDetachConflictError,
  RepoMountNotFoundError,
} from "./errors.js";
import { RepoRootResolver } from "./root-resolver.js";
import { hasSqliteErrorCode } from "../../session/sqlite-error-code.js";
import type { WorkspaceEventEmitter } from "../event-emitter.js";
import { computeRepoMountHealth, type FilesystemPathProbe } from "../projector.js";
import { createDefaultPathProbe, type FilesystemPathProbeFn } from "../row-guards.js";
import { mintUuidV7 } from "../../uuid-v7.js";

/**
 * The daemon-internal failure classes of this module, one class with a discriminant. All reach
 * the wire as an anonymous internal error.
 */
export type RepoMountServiceInvariantKind =
  /** A mount row cannot be projected through the contract schemas (corruption or a bad id). */
  | "repo_mount_row_unprojectable"
  /**
   * The detach committed but a post-commit `workspace.archived` append failed, so the log
   * under-reports the archived rows. No wire code exists for this.
   */
  | "detach_notification_incomplete";

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
  readonly state: string;
  readonly attached_at: string;
}

interface DependentWorkspaceRow {
  readonly id: string;
  readonly session_id: string;
}

/** Constructor dependencies. Every optional member defaults to the real one. */
export interface RepoMountServiceDeps {
  /** The daemon database: reads on its reader, writes through its writer. */
  readonly database: DatabaseConnections;
  /** The seam through which the detach cascade's `workspace.archived` events are appended. */
  readonly events: WorkspaceEventEmitter;
  /** The daemon's own node id, stamped on every mount it attaches. */
  readonly nodeId: NodeId;
  /** Defaults to a stock `RepoRootResolver`; mutually exclusive with {@link gitExecutablePath}. */
  readonly resolver?: RepoRootResolver;
  /**
   * Absolute `git` path for the default resolver. Required on `win32` unless {@link resolver} is
   * given.
   */
  readonly gitExecutablePath?: string;
  /**
   * Platform for the win32 `git`-pinning guard; defaults to `process.platform`. The guard catches
   * an omission by the composition root, not a hostile caller.
   */
  readonly platform?: NodeJS.Platform;
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

/** The path arm of `repo.attach`; folder tokens are resolved to paths before this service. */
export type RepoAttachPathRequest = Extract<RepoAttachRequest, { localPath: string }>;

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

const BUSY_WORKSPACE_STATE = "busy" satisfies WorkspaceState;

const INSERT_MOUNT_SQL = `INSERT INTO repo_mounts (
     id, node_id, local_path, canonical_root, vcs_type, state, attached_at, updated_at, metadata
   ) VALUES (
     @id, @node_id, @local_path, @canonical_root, @vcs_type, '${ATTACHED_MOUNT_STATE}', @now,
     @now, '{}'
   )`;

// A dependent with an agent running in it: `busy`, or holding a run whose execution root is
// unreleased, since a run releases its workspace hold and its execution root separately.
const RUNNING_DEPENDENT_PREDICATE = `workspaces.repo_mount_id = @repo_mount_id
   AND (workspaces.state = '${BUSY_WORKSPACE_STATE}'
        OR EXISTS (
          SELECT 1
            FROM run_execution_contexts AS run_context
           WHERE run_context.workspace_id = workspaces.id
             AND run_context.released_at IS NULL))`;

// The detach's four statements run as one write, so the running check, the archive and the flip
// see one state. The oldest running dependent's session is the one a refusal names; `id` breaks
// ties between workspaces created in the same tick.
const SELECT_RUNNING_DEPENDENT_SQL = `SELECT session_id
     FROM workspaces
    WHERE ${RUNNING_DEPENDENT_PREDICATE}
    ORDER BY created_at ASC, id ASC
    LIMIT 1`;

// The dependents the archive below moves, in event order; read in the same write, so the list
// and the archive agree.
const SELECT_ARCHIVABLE_DEPENDENTS_SQL = `SELECT id, session_id
     FROM workspaces
    WHERE repo_mount_id = @repo_mount_id AND state <> '${ARCHIVED_WORKSPACE_STATE}'
    ORDER BY created_at ASC, id ASC`;

// Archives only while the mount is still attached and no agent runs on it, so a lost race or a
// running agent writes nothing. `metadata` is untouched: a `busy` workspace refuses the detach,
// so no stale `holdingRunId` exists.
const ARCHIVE_DEPENDENTS_SQL = `UPDATE workspaces
      SET state = '${ARCHIVED_WORKSPACE_STATE}',
          updated_at = @now
    WHERE repo_mount_id = @repo_mount_id
      AND state <> '${ARCHIVED_WORKSPACE_STATE}'
      AND EXISTS (
        SELECT 1 FROM repo_mounts
         WHERE id = @repo_mount_id AND state = '${ATTACHED_MOUNT_STATE}')
      AND NOT EXISTS (SELECT 1 FROM workspaces WHERE ${RUNNING_DEPENDENT_PREDICATE})`;

// Compare-and-swap: `attached` in the predicate is the legal-predecessor rule and the mutual
// exclusion between concurrent detaches.
const DETACH_MOUNT_SQL = `UPDATE repo_mounts
      SET state = '${DETACHED_MOUNT_STATE}',
          updated_at = @now
    WHERE id = @repo_mount_id
      AND state = '${ATTACHED_MOUNT_STATE}'
      AND NOT EXISTS (SELECT 1 FROM workspaces WHERE ${RUNNING_DEPENDENT_PREDICATE})`;

/**
 * Owns every read and write of the `repo_mounts` table. The detach cascade also archives the
 * mount's `workspaces` rows here, because they must share one write with the mount flip.
 */
export class RepoMountService {
  readonly #events: WorkspaceEventEmitter;
  readonly #nodeId: NodeId;
  readonly #resolver: RepoRootResolver;
  readonly #probePath: FilesystemPathProbeFn;
  readonly #now: () => string;
  readonly #newRepoMountId: () => string;

  readonly #writer: DatabaseConnections["writer"];
  readonly #selectMountStmt: Statement;
  readonly #selectActiveMountByRootStmt: Statement;

  constructor(deps: RepoMountServiceDeps) {
    if (deps.resolver !== undefined && deps.gitExecutablePath !== undefined) {
      // Loud, not a precedence rule: preferring one would leave a daemon that believes it pinned
      // an absolute `git` and did not.
      throw new TypeError(
        "RepoMountService: supply either a ready-made resolver or a gitExecutablePath, not both. " +
          "A gitExecutablePath is only honored by the resolver this service constructs, so " +
          "passing both would silently drop the pinned executable path.",
      );
    }

    if (
      (deps.platform ?? process.platform) === "win32" &&
      deps.resolver === undefined &&
      deps.gitExecutablePath === undefined
    ) {
      // Fail closed: the stock resolver spawns bare `git`, and a `git.exe` planted in the
      // working directory would run.
      throw new TypeError(
        "RepoMountService: on win32 you must supply either an absolute gitExecutablePath or a " +
          "ready-made resolver. Spawning bare `git` there lets a git.exe in the daemon's own " +
          "working directory execute instead of the system one.",
      );
    }

    this.#events = deps.events;
    this.#nodeId = deps.nodeId;
    this.#resolver =
      deps.resolver ??
      new RepoRootResolver(
        // Conditional spread: under `exactOptionalPropertyTypes` an explicit `undefined` is not an
        // absent key, and the resolver's own default would be skipped.
        deps.gitExecutablePath === undefined ? {} : { gitExecutablePath: deps.gitExecutablePath },
      );
    this.#probePath = deps.probePath ?? createDefaultPathProbe();
    this.#now = deps.now ?? ((): string => new Date().toISOString());
    this.#newRepoMountId = deps.newRepoMountId ?? mintUuidV7;

    const database = deps.database.reader;
    this.#writer = deps.database.writer;

    // Unscoped by state: a read must answer for a `detached` mount.
    this.#selectMountStmt = database.prepare(
      `SELECT id, node_id, local_path, canonical_root, vcs_type, state, attached_at
         FROM repo_mounts
        WHERE id = @repo_mount_id`,
    );

    // Behind `repo.already_attached`. The predicate mirrors `idx_repo_mounts_active_root`; if they
    // diverge, the refusal degrades to an internal error.
    this.#selectActiveMountByRootStmt = database.prepare(
      `SELECT id
         FROM repo_mounts
        WHERE node_id = @node_id
          AND canonical_root = @canonical_root
          AND state = '${ATTACHED_MOUNT_STATE}'`,
    );
  }

  /**
   * Attach a local path: resolve its canonical root and persist the mount. Throws
   * `RepoRootResolutionError` (nothing persisted) or `RepoAlreadyAttachedError`.
   */
  async attach(input: RepoAttachPathRequest): Promise<RepoAttachResponse> {
    // No fallback to the entered path: a non-resolution throws.
    const resolution = await this.#resolver.resolveCanonicalRoot(input.localPath);

    const repoMountId = this.#newRepoMountId();
    const attachedAt = this.#now();

    // Project before the write, so an identity the wire cannot carry fails while nothing is
    // durable.
    const response = this.#projectAttachResponse({
      repoMountId,
      canonicalRoot: resolution.canonicalRoot,
      vcsType: resolution.vcsType,
    });

    await this.#insertMountRow({
      repoMountId,
      // Provenance: the path as typed, which differs from the root under a subdirectory or symlink.
      localPath: input.localPath,
      canonicalRoot: resolution.canonicalRoot,
      vcsType: resolution.vcsType,
      attachedAt,
    });

    return response;
  }

  /**
   * Read one mount's facts, in any state, with a freshly probed health verdict. Throws
   * `RepoMountNotFoundError`. The probe gets `canonical_root` verbatim: the projector compares
   * paths byte for byte.
   */
  async read(repoMountId: RepoMountId): Promise<RepoMountRecord> {
    const row = this.#requireMountRow(repoMountId);
    const probe = await this.#probePath(row.canonical_root);
    return this.#projectMountRecord(row, probe);
  }

  /**
   * Detach a mount and archive its workspaces (a no-op if not `attached`); refuses with
   * `RepoDetachConflictError`, naming the running session, while an agent runs in any of them
   * (`busy`, or a run whose execution root is unreleased). Rejects with
   * `detach_notification_incomplete` if committed but an event append failed; the rows are the
   * truth and a rerun is a no-op.
   */
  async detach(input: DetachRepoMountInput): Promise<RepoMountDetachOutcome> {
    const actor = input.actor ?? null;
    const correlationId = input.correlationId ?? null;
    const repoMountId = input.repoMountId;

    const row = this.#requireMountRow(repoMountId);
    if (row.state !== ATTACHED_MOUNT_STATE) {
      return this.#projectDetachOutcome(repoMountId, row.state, []);
    }

    const bindings = { repo_mount_id: repoMountId, now: this.#now() };
    const [runningDependent, archivable, , flip] = await this.#writer.write([
      { sql: SELECT_RUNNING_DEPENDENT_SQL, bindings },
      { sql: SELECT_ARCHIVABLE_DEPENDENTS_SQL, bindings },
      { sql: ARCHIVE_DEPENDENTS_SQL, bindings },
      { sql: DETACH_MOUNT_SQL, bindings },
    ]);
    const runningSession = runningDependent?.rows[0] as { readonly session_id: string } | undefined;
    if (runningSession !== undefined) {
      throw new RepoDetachConflictError(runningSession.session_id);
    }
    if (flip?.rowCount !== 1) {
      // A concurrent detach won, so this write changed nothing: report the winner's state.
      const current = this.#requireMountRow(repoMountId);
      return this.#projectDetachOutcome(repoMountId, current.state, []);
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

  /**
   * Insert the mount row, translating the active-root uniqueness failure into
   * `repo.already_attached`. The failed INSERT is undone alone, so the lookup sees the old rows.
   */
  async #insertMountRow(fields: {
    readonly repoMountId: string;
    readonly localPath: string;
    readonly canonicalRoot: string;
    readonly vcsType: string;
    readonly attachedAt: string;
  }): Promise<void> {
    try {
      await this.#writer.write([
        {
          sql: INSERT_MOUNT_SQL,
          bindings: {
            id: fields.repoMountId,
            node_id: this.#nodeId,
            local_path: fields.localPath,
            canonical_root: fields.canonicalRoot,
            vcs_type: fields.vcsType,
            now: fields.attachedAt,
          },
        },
      ]);
    } catch (error) {
      if (!hasSqliteErrorCode(error, "SQLITE_CONSTRAINT")) {
        throw error;
      }
      const conflict = this.#selectActiveMountByRootStmt.get({
        node_id: this.#nodeId,
        canonical_root: fields.canonicalRoot,
      }) as { readonly id: string } | undefined;
      if (conflict === undefined) {
        // Another constraint (id collision, `vcs_type` CHECK): rethrow, or the caller would be
        // sent to detach a mount that does not exist.
        throw error;
      }
      throw new RepoAlreadyAttachedError(conflict.id);
    }
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
  #projectMountRecord(row: RepoMountRow, probe: FilesystemPathProbe): RepoMountRecord {
    try {
      return {
        id: RepoMountIdSchema.parse(row.id),
        nodeId: NodeIdSchema.parse(row.node_id),
        localPath: row.local_path,
        canonicalRoot: row.canonical_root,
        vcsType: VcsTypeSchema.parse(row.vcs_type),
        state: RepoMountStateSchema.parse(row.state),
        // A mispaired probe throws: a health verdict for another path is a confident wrong answer.
        health: computeRepoMountHealth({ canonicalRoot: row.canonical_root }, probe),
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
