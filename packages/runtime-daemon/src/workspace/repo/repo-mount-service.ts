/**
 * Repo-mount lifecycle service, the daemon-side owner of the `repo_mounts` table. A mount belongs
 * to the machine, not a session: attach stamps the daemon's node id, writes no workspace and
 * appends no event.
 *
 * - Attach has no containment check: attaching a path is what admits it to the trust envelope.
 * - A duplicate root is caught by `idx_repo_mounts_active_root` on the INSERT; a pre-read races.
 * - Detach reads, archives and flips the mount in one `IMMEDIATE` transaction, then appends
 *   `workspace.archived` events, so a crash leaves rows durable and events missing.
 * - On Windows bare `git` resolves from the working directory first, so config supplies an
 *   absolute `gitExecutablePath`.
 */

import type { Database, Statement, Transaction } from "better-sqlite3";

import { NodeIdSchema, type NodeId } from "@ai-sidekicks/contracts/node-id";
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

import {
  RepoAlreadyAttachedError,
  RepoDetachConflictError,
  RepoMountNotFoundError,
} from "./errors.js";
import { RepoRootResolver } from "./repo-root-resolver.js";
import { hasSqliteErrorCode } from "../../session/sqlite-error-code.js";
import type { WorkspaceEventEmitter } from "../workspace-event-emitter.js";
import { computeRepoMountHealth, type FilesystemPathProbe } from "../projector.js";
import { createDefaultPathProbe, type FilesystemPathProbeFn } from "../row-guards.js";
import { mintUuidV7 } from "../../ids/uuid-v7.js";

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

/** Aborts the detach transaction when the mount flip matches no row; `detach` catches it. */
class MountDetachRaceError extends Error {
  constructor(repoMountId: string) {
    super(
      `RepoMountService.detach: repo mount ${repoMountId} left the attached state between the ` +
        `read and the detach transaction; rolling back the archives this transaction wrote.`,
    );
    this.name = "MountDetachRaceError";
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
  readonly state: string;
  /** 1 while a run started in this workspace has not released its execution root. */
  readonly has_running_agent: 0 | 1;
}

/** Constructor dependencies. Every optional member defaults to the real one. */
export interface RepoMountServiceDeps {
  /** Open daemon database; every write commits alone, so it need not be the event log's handle. */
  readonly database: Database;
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

/**
 * Owns every read and write of the `repo_mounts` table. The detach cascade also archives the
 * mount's `workspaces` rows here, because they must share a transaction with the mount flip.
 */
export class RepoMountService {
  readonly #events: WorkspaceEventEmitter;
  readonly #nodeId: NodeId;
  readonly #resolver: RepoRootResolver;
  readonly #probePath: FilesystemPathProbeFn;
  readonly #now: () => string;
  readonly #newRepoMountId: () => string;

  readonly #insertMountStmt: Statement;
  readonly #selectMountStmt: Statement;
  readonly #selectActiveMountByRootStmt: Statement;
  readonly #selectDependentWorkspacesStmt: Statement;
  readonly #archiveWorkspaceStmt: Statement;
  readonly #detachMountStmt: Statement;
  readonly #detachCascade: Transaction<
    (repoMountId: string, now: string) => readonly DependentWorkspaceRow[]
  >;

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

    const database = deps.database;

    this.#insertMountStmt = database.prepare(
      `INSERT INTO repo_mounts (
         id, node_id, local_path, canonical_root, vcs_type, state, attached_at, updated_at,
         metadata
       ) VALUES (
         @id, @node_id, @local_path, @canonical_root, @vcs_type, '${ATTACHED_MOUNT_STATE}', @now,
         @now, '{}'
       )`,
    );

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

    // Every state: the running check needs `busy` rows, and `archived` rows must be seen to be
    // skipped. A run releases its workspace hold and its execution root separately, so an
    // unreleased run context marks a running agent on a workspace that is no longer `busy`. `id`
    // breaks ties between workspaces created in the same tick.
    this.#selectDependentWorkspacesStmt = database.prepare(
      `SELECT id, session_id, state,
              EXISTS (
                SELECT 1
                  FROM run_execution_contexts AS run_context
                 WHERE run_context.workspace_id = workspaces.id
                   AND run_context.released_at IS NULL
              ) AS has_running_agent
         FROM workspaces
        WHERE repo_mount_id = @repo_mount_id
        ORDER BY created_at ASC, id ASC`,
    );

    // Writes a table this service does not own so the archive shares the mount flip's
    // transaction. `state <> 'archived'` makes a re-archive match zero rows. `metadata` is
    // untouched: a `busy` workspace refuses the detach, so no stale `holdingRunId` exists.
    this.#archiveWorkspaceStmt = database.prepare(
      `UPDATE workspaces
          SET state = '${ARCHIVED_WORKSPACE_STATE}',
              updated_at = @now
        WHERE id = @workspace_id AND state <> '${ARCHIVED_WORKSPACE_STATE}'`,
    );

    // Compare-and-swap: `attached` in the predicate is the legal-predecessor rule and the mutual
    // exclusion between concurrent detaches.
    this.#detachMountStmt = database.prepare(
      `UPDATE repo_mounts
          SET state = '${DETACHED_MOUNT_STATE}',
              updated_at = @now
        WHERE id = @repo_mount_id AND state = '${ATTACHED_MOUNT_STATE}'`,
    );

    this.#detachCascade = database.transaction(
      (repoMountId: string, now: string): readonly DependentWorkspaceRow[] =>
        this.#runDetachCascade(repoMountId, now),
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

    this.#insertMountRow({
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

    const now = this.#now();
    let archivedWorkspaces: readonly DependentWorkspaceRow[];
    try {
      archivedWorkspaces = this.#detachCascade.immediate(repoMountId, now);
    } catch (error) {
      if (!(error instanceof MountDetachRaceError)) {
        throw error;
      }
      // A concurrent detach won and ours rolled back whole: report the winner's state.
      const current = this.#requireMountRow(repoMountId);
      return this.#projectDetachOutcome(repoMountId, current.state, []);
    }

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
   * The detach write set, run as the transaction body so the dependent read holds the write lock.
   * Returns the dependents it transitioned, one event each.
   */
  #runDetachCascade(repoMountId: string, now: string): readonly DependentWorkspaceRow[] {
    const dependents = this.#selectDependentWorkspacesStmt.all({
      repo_mount_id: repoMountId,
    }) as DependentWorkspaceRow[];

    // The refusal names one running session; the oldest running workspace's, by the query's order.
    const runningDependent = dependents.find(
      (dependent) => dependent.state === BUSY_WORKSPACE_STATE || dependent.has_running_agent === 1,
    );
    if (runningDependent !== undefined) {
      throw new RepoDetachConflictError(runningDependent.session_id);
    }

    const archivedWorkspaces: DependentWorkspaceRow[] = [];
    for (const dependent of dependents) {
      if (dependent.state === ARCHIVED_WORKSPACE_STATE) {
        continue;
      }
      this.#archiveWorkspaceStmt.run({ workspace_id: dependent.id, now });
      archivedWorkspaces.push(dependent);
    }

    const flip = this.#detachMountStmt.run({ repo_mount_id: repoMountId, now });
    if (flip.changes !== 1) {
      throw new MountDetachRaceError(repoMountId);
    }

    return archivedWorkspaces;
  }

  /**
   * Insert the mount row, translating the active-root uniqueness failure into
   * `repo.already_attached`. The failed INSERT is undone alone, so the lookup sees the old rows.
   */
  #insertMountRow(fields: {
    readonly repoMountId: string;
    readonly localPath: string;
    readonly canonicalRoot: string;
    readonly vcsType: string;
    readonly attachedAt: string;
  }): void {
    try {
      this.#insertMountStmt.run({
        id: fields.repoMountId,
        node_id: this.#nodeId,
        local_path: fields.localPath,
        canonical_root: fields.canonicalRoot,
        vcs_type: fields.vcsType,
        now: fields.attachedAt,
      });
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
