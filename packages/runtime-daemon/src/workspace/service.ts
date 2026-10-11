/**
 * Workspace lifecycle service: the daemon-side owner of the `workspaces` table.
 *
 * - Every transition writes its row in the emitter's `transactionalPrelude`, so the row and its
 *   event commit together. The writes are compare-and-swap `UPDATE`s expecting one row; a moved row
 *   refuses the write, event and all.
 * - `fs_root` is an approval-scope boundary: a bind and `beginRootPreparation` write NULL, and only
 *   `completeRootPreparation` writes a path.
 * - A bind records the folder it admitted (`metadata.boundRoot`, never cleared, rewritten by a move
 *   into another tree) and that folder's checkout (`metadata.checkoutRoot`, rewritten by every
 *   completed preparation).
 * - No workspace is held for a run: two sessions' runs may work in one folder at once.
 * - The `workspace.*` domain errors follow the carrier pattern of `./repo/errors.js`; every code
 *   comes from the error registry, and this module mints none.
 */

import type { Statement } from "better-sqlite3";
import {
  ExecutionModeSchema,
  RepoMountIdSchema,
  WorkspaceIdSchema,
  WorkspaceStateSchema,
  type ExecutionMode,
  type WorkspaceState,
} from "@ai-sidekicks/contracts/repo/mount";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type {
  WorkspaceBindRequest,
  WorkspaceBindResponse,
  WorkspaceListRequest,
  WorkspaceListResponse,
} from "@ai-sidekicks/contracts/repo/workspace";
import type { DatabaseConnections } from "../database/connection/lifecycle.js";
import type { WriteStatement } from "../database/statement.js";
import { WriteRefusedError } from "../database/writer.js";
import { LIVE_WORKTREE_STATE_PREDICATE } from "../git/worktree/rows.js";
import { SessionNotFoundError } from "../ipc/session-errors.js";
import { SESSION_EXISTS_SQL, sessionExistsStatement } from "../session/directory/lookups.js";
import {
  RepoMountManagedError,
  RepoMountNotFoundError,
  RepoRootResolutionError,
} from "./repo/errors.js";
import { probeRepoMountHealth, type RepoMountHealthSeams } from "./repo/mount-health.js";
import { RepoRootResolver } from "./repo/root-resolver.js";
import { TrustEnvelopeValidator, type AdmittedExecutionRoot } from "./trust-envelope.js";
import type { WorkspaceEventEmitter } from "./event-emitter.js";
import type { CompletedRootPreparation } from "./execution-root-service.js";
import { mintUuidV7 } from "../uuid-v7.js";
import {
  computeWorkspaceHealth,
  PROBE_BEARING_WORKSPACE_STATES,
  type FilesystemPathProbe,
  type WorkspaceHealthProjection,
} from "./projector.js";
import {
  assertAbsoluteExecutionRoot,
  assertModeOffered,
  BOUND_ROOT_METADATA_PATH,
  CHECKOUT_ROOT_METADATA_PATH,
  COMMON_DIR_METADATA_PATH,
  createDefaultPathProbe,
  expectSingleRowChanged,
  type FilesystemPathProbeFn,
  LAST_ERROR_METADATA_PATH,
  type MountRow,
  readLastError,
  type WorkspaceRow,
  wrapRowFailure,
} from "./row-guards.js";
import {
  WorkspaceNotFoundError,
  WorkspaceServiceInvariantError,
  WorkspaceStaleError,
} from "./errors.js";
import { normalizeWorkspaceLastError } from "./last-error.js";

// A session's live workspace on one mount. The predicate is `idx_workspaces_live_session_mount`'s,
// which holds it to one row; an archived workspace is history and does not count.
const LIVE_WORKSPACE_OF_SESSION_ON_MOUNT = `session_id = @session_id
      AND repo_mount_id = @repo_mount_id
      AND state <> 'archived'`;

// `SELECT` rather than `VALUES` re-tests the mount's attachment inside the write: a detach cascade
// can flip the mount during `bind`'s awaits, and the foreign key would still hold. The write also
// re-tests that the session has no live workspace on the mount, which another bind may have made
// during those awaits. Zero rows refuses the write and takes the `workspace.preparing` event with
// it.
const BIND_WORKSPACE_SQL = `INSERT INTO workspaces (
     id, session_id, repo_mount_id, execution_mode, fs_root, state, metadata,
     created_at, updated_at
   )
   SELECT @id, @session_id, @repo_mount_id, @execution_mode, NULL, 'preparing',
          json_set('{}', '${BOUND_ROOT_METADATA_PATH}', @bound_root,
                         '${CHECKOUT_ROOT_METADATA_PATH}', @checkout_root),
          @now, @now
     FROM repo_mounts
    WHERE id = @repo_mount_id AND state = 'attached'
      AND NOT EXISTS (SELECT 1 FROM workspaces WHERE ${LIVE_WORKSPACE_OF_SESSION_ON_MOUNT})`;

// `stale` is a legal predecessor so a failed switch can be retried. `fs_root` is nulled because a
// stale root would keep matching approvals; `lastError` is cleared so a retried `preparing` row
// does not advertise the last failure. `execution_mode` is set: completion takes no mode.
const BEGIN_ROOT_PREPARATION_SQL = `UPDATE workspaces
      SET execution_mode = @execution_mode,
          fs_root = NULL,
          state = 'preparing',
          metadata = json_remove(metadata, '${LAST_ERROR_METADATA_PATH}'),
          updated_at = @now
    WHERE id = @workspace_id AND state IN ('ready', 'stale')`;

// A cycle can complete without re-entering through `beginRootPreparation` (a bind's own first
// preparation), so the mode the preparation made is written here too, and `lastError` cleared.
// The checkout is rewritten, so it names the tree the workspace works in from now on; the bound
// folder only when a move changed it.
const COMPLETE_ROOT_PREPARATION_SQL = `UPDATE workspaces
      SET fs_root = @fs_root,
          execution_mode = COALESCE(@execution_mode, execution_mode),
          state = 'ready',
          metadata = CASE
            WHEN @bound_root IS NULL
              THEN json_set(json_remove(metadata, '${LAST_ERROR_METADATA_PATH}'),
                            '${CHECKOUT_ROOT_METADATA_PATH}', @checkout_root)
            ELSE json_set(json_remove(metadata, '${LAST_ERROR_METADATA_PATH}'),
                          '${CHECKOUT_ROOT_METADATA_PATH}', @checkout_root,
                          '${BOUND_ROOT_METADATA_PATH}', @bound_root)
          END,
          updated_at = @now
    WHERE id = @workspace_id AND state = 'preparing'`;

// `json_set`, not a whole-blob rewrite: `metadata` is shared and holds keys other writers own.
const FAIL_ROOT_PREPARATION_WITH_DETAIL_SQL = `UPDATE workspaces
      SET state = 'stale',
          metadata = json_set(metadata, '${LAST_ERROR_METADATA_PATH}', @last_error),
          updated_at = @now
    WHERE id = @workspace_id AND state = 'preparing'`;

const FAIL_ROOT_PREPARATION_WITHOUT_DETAIL_SQL = `UPDATE workspaces
      SET state = 'stale',
          metadata = json_remove(metadata, '${LAST_ERROR_METADATA_PATH}'),
          updated_at = @now
    WHERE id = @workspace_id AND state = 'preparing'`;

// `stale` is absent (re-staling is a no-op) and so is terminal `archived`.
const MARK_STALE_SQL = `UPDATE workspaces
      SET state = 'stale',
          updated_at = @now
    WHERE id = @workspace_id AND state IN ('preparing', 'ready')`;

// The same transition with the reason recorded, for a refusal the person repairs (a mount whose
// folder holds another repository now).
const MARK_STALE_WITH_DETAIL_SQL = `UPDATE workspaces
      SET state = 'stale',
          metadata = json_set(metadata, '${LAST_ERROR_METADATA_PATH}', @last_error),
          updated_at = @now
    WHERE id = @workspace_id AND state IN ('preparing', 'ready')`;

/** Constructor dependencies. Every optional member defaults to the real one. */
export interface WorkspaceServiceDeps {
  /**
   * The daemon database: reads prepared on its reader in the constructor; every write rides an
   * event append through {@link events}.
   */
  readonly database: DatabaseConnections;
  /** The single seam through which workspace lifecycle events are appended. */
  readonly events: WorkspaceEventEmitter;
  /**
   * Runs git for the mount identity and the trust envelope. Defaults to a stock resolver, which
   * runs bare `git`.
   */
  readonly resolver?: RepoRootResolver;
  /** Containment validator. Defaults to a stock `TrustEnvelopeValidator` over the resolver. */
  readonly trustEnvelope?: TrustEnvelopeValidator;
  /**
   * Reachability probe. Defaults to the readability probe, reading the clock first so `checkedAt`
   * is never newer than the observation it timestamps.
   */
  readonly probePath?: FilesystemPathProbeFn;
  /** ISO-8601 wall clock for `created_at` / `updated_at`; defaults to the system clock. */
  readonly now?: () => string;
  /**
   * Workspace-id source, default `mintUuidV7`. Injected ids are parsed through `WorkspaceIdSchema`,
   * so a test source must mint real UUIDs.
   */
  readonly newWorkspaceId?: () => string;
}

/** Inputs for {@link WorkspaceService.bind}. */
export interface BindWorkspaceInput extends WorkspaceBindRequest {
  /** Envelope actor; defaults to the system actor. */
  readonly actor?: string | null;
}

/**
 * Owns every workspace lifecycle transition and write to `workspaces`, except the writes that
 * share another row's write: the detach cascade's archive and a managed mount's deletion in
 * `./repo/mount-service.js`, a re-attach's move to the new mount in `./repo/reattach.js`, and the
 * session purge's delete of the session's rows. Legal predecessor states live in each `UPDATE`'s
 * `WHERE` clause.
 */
export class WorkspaceService {
  readonly #events: WorkspaceEventEmitter;
  readonly #trustEnvelope: TrustEnvelopeValidator;
  readonly #probePath: FilesystemPathProbeFn;
  readonly #mountHealthSeams: RepoMountHealthSeams;
  readonly #now: () => string;
  readonly #newWorkspaceId: () => string;

  readonly #selectSessionStmt: Statement;
  readonly #selectLiveWorkspaceStmt: Statement;
  readonly #selectAttachedMountStmt: Statement;
  readonly #selectAttachedMountRootsStmt: Statement;
  readonly #selectDaemonWorktreeRootsStmt: Statement;
  readonly #selectWorkspaceStmt: Statement;
  readonly #listWorkspacesStmt: Statement;
  readonly #listWorkspacesByMountStmt: Statement;

  constructor(deps: WorkspaceServiceDeps) {
    this.#events = deps.events;
    const resolver = deps.resolver ?? new RepoRootResolver();
    this.#trustEnvelope =
      deps.trustEnvelope ?? new TrustEnvelopeValidator({ workingTrees: resolver });
    this.#probePath = deps.probePath ?? createDefaultPathProbe();
    this.#mountHealthSeams = { probePath: this.#probePath, resolver };
    this.#now = deps.now ?? ((): string => new Date().toISOString());
    this.#newWorkspaceId = deps.newWorkspaceId ?? mintUuidV7;

    const database = deps.database.reader;

    this.#selectSessionStmt = database.prepare(SESSION_EXISTS_SQL);

    this.#selectLiveWorkspaceStmt = database.prepare(
      `SELECT id, execution_mode, state
         FROM workspaces
        WHERE ${LIVE_WORKSPACE_OF_SESSION_ON_MOUNT}`,
    );

    // Attached only: a detached mount is not a bind target, and `repo.not_found` is more honest.
    this.#selectAttachedMountStmt = database.prepare(
      `SELECT id, local_path, canonical_root, managed_session_id,
              json_extract(metadata, '${COMMON_DIR_METADATA_PATH}') AS common_dir
         FROM repo_mounts
        WHERE id = @repo_mount_id AND state = 'attached'`,
    );

    // The trust envelope: the canonical roots of every attached mount.
    this.#selectAttachedMountRootsStmt = database.prepare(
      `SELECT canonical_root
         FROM repo_mounts
        WHERE state = 'attached'
        ORDER BY canonical_root ASC`,
    );

    // The worktrees the daemon made for a mount and still keeps on disk, admitted by provenance.
    this.#selectDaemonWorktreeRootsStmt = database.prepare(
      `SELECT fs_root
         FROM worktrees
        WHERE repo_mount_id = @repo_mount_id AND ${LIVE_WORKTREE_STATE_PREDICATE}
        ORDER BY fs_root ASC`,
    );

    this.#selectWorkspaceStmt = database.prepare(
      `SELECT id, session_id, repo_mount_id, execution_mode, fs_root, state, metadata
         FROM workspaces
        WHERE id = @workspace_id`,
    );

    // `created_at, id`: two binds can share a clock instant, and planner order is not testable.
    this.#listWorkspacesStmt = database.prepare(
      `SELECT id, session_id, repo_mount_id, execution_mode, fs_root, state, metadata
         FROM workspaces
        WHERE session_id = @session_id
        ORDER BY created_at ASC, id ASC`,
    );

    this.#listWorkspacesByMountStmt = database.prepare(
      `SELECT id, session_id, repo_mount_id, execution_mode, fs_root, state, metadata
         FROM workspaces
        WHERE session_id = @session_id AND repo_mount_id = @repo_mount_id
        ORDER BY created_at ASC, id ASC`,
    );
  }

  /**
   * Bind a workspace to an attached mount (`repo.workspaceBind`); it lands `preparing` with a NULL
   * `fs_root` that {@link completeRootPreparation} fills, recording the admitted folder and its
   * checkout. A session that already has a live workspace on the mount is answered that workspace
   * as it stands, its mode and state whatever the request asked, and nothing is probed or written.
   * Throws `SessionNotFoundError`, before any probe or write, when `sessionId` names no session,
   * `RepoMountNotFoundError` for a mount that is not attached, `RepoMountManagedError` for another
   * chat's managed workspace, and `RepoRootResolutionError` (`root_mismatch`) for a mount whose
   * folder holds another repository than the one attached there.
   */
  async bind(input: BindWorkspaceInput): Promise<WorkspaceBindResponse> {
    if (this.#selectSessionStmt.get({ sessionId: input.sessionId }) === undefined) {
      throw sessionNotFound(input.sessionId);
    }
    const boundEarlier = this.#readLiveWorkspace(input);
    if (boundEarlier !== undefined) {
      return boundEarlier;
    }

    const mountRow = this.#selectAttachedMountStmt.get({
      repo_mount_id: input.repoMountId,
    }) as MountRow | undefined;
    if (mountRow === undefined) {
      throw new RepoMountNotFoundError(input.repoMountId);
    }
    // A managed mount is its own chat's folder alone; its owner never changes, so the read decides.
    if (mountRow.managed_session_id !== null && mountRow.managed_session_id !== input.sessionId) {
      throw new RepoMountManagedError(input.repoMountId);
    }

    // The mode before any filesystem work.
    assertModeOffered(input.executionMode, mountRow.managed_session_id !== null);

    // A bind that names no folder roots at the working tree the person attached, never at the
    // repository's main checkout.
    const namesFolder = input.directory !== undefined && input.directory.length > 0;
    const admitted = await this.#admitOnHealthyMount(
      mountRow,
      namesFolder ? input.directory : mountRow.local_path,
      null,
    );
    const boundRoot = namesFolder ? admitted.executionRoot : admitted.checkoutRoot;

    const workspaceId = this.#newWorkspaceId();
    const createdAt = this.#now();

    // The mount's attachment, and that the session has no live workspace on it, are re-tested in
    // this write; zero rows means a detach cascade or another bind won the race, and the refusal
    // takes the event with it.
    const insertRow: WriteStatement = {
      sql: BIND_WORKSPACE_SQL,
      bindings: {
        id: workspaceId,
        session_id: input.sessionId,
        repo_mount_id: mountRow.id,
        execution_mode: input.executionMode,
        bound_root: boundRoot,
        checkout_root: admitted.checkoutRoot,
        now: createdAt,
      },
      expectedRowCount: 1,
    };

    // The birth event carries `repoMountId`, the only place a transcript reader learns the
    // workspace/mount association. The session's row is re-tested in the same write, so a purge
    // between the read above and this write refuses it.
    return expectSingleRowChanged(
      this.#events
        .emitWorkspacePreparing({
          sessionId: input.sessionId,
          workspaceId,
          repoMountId: mountRow.id,
          actor: input.actor ?? null,
          transactionalPrelude: [sessionExistsStatement(input.sessionId), insertRow],
        })
        .then(
          (): WorkspaceBindResponse => ({
            workspaceId: WorkspaceIdSchema.parse(workspaceId),
            executionMode: input.executionMode,
            state: "preparing",
          }),
          (error: unknown): WorkspaceBindResponse => {
            if (!(error instanceof WriteRefusedError)) {
              throw error;
            }
            if (error.statementIndex === 0) {
              throw sessionNotFound(input.sessionId);
            }
            // A bind of this session to this mount that committed during the awaits above is the
            // answer; with none, the mount left `attached` and the refusal stands.
            const boundMeanwhile = this.#readLiveWorkspace(input);
            if (boundMeanwhile === undefined) {
              throw error;
            }
            return boundMeanwhile;
          },
        ),
      workspaceId,
      "bind",
      "its repo mount",
    );
  }

  /**
   * Admits `folder` for a move of the workspace into another tree, as a bind admits its pick.
   * Throws `RepoMountNotFoundError` for a mount not attached, `WorkspaceStaleError` when the mount
   * folder is unreachable, `RepoRootResolutionError` (`root_mismatch`) when it holds another
   * repository, and `TrustEnvelopeViolationError` for a folder outside the mount's trees.
   */
  async admitFolder(workspaceId: string, folder: string): Promise<AdmittedExecutionRoot> {
    const row = this.#requireWorkspaceRow(workspaceId);
    return this.#admitOnHealthyMount(this.#requireMountRowFor(row), folder, workspaceId);
  }

  /**
   * Refuses, writing nothing, a workspace whose mount is not attached (`RepoMountNotFoundError`),
   * whose mount folder is gone (`WorkspaceStaleError`), or whose mount folder holds another
   * repository than the one attached there (`RepoRootResolutionError`, `root_mismatch`).
   */
  async assertMountHealthy(workspaceId: string): Promise<void> {
    const row = this.#requireWorkspaceRow(workspaceId);
    await this.#refuseUnhealthyMount(this.#requireMountRowFor(row), workspaceId);
  }

  /**
   * List a session's workspaces through the health projection (`repo.workspaceList`), persisting
   * any derived stale transition. A per-row failure fails the whole response: dropping the row
   * would shorten the list the person uses to decide what to detach.
   */
  async list(request: WorkspaceListRequest): Promise<WorkspaceListResponse> {
    // One binding from two statements that select the same columns and must project identically.
    let rows: WorkspaceRow[];
    if (request.repoMountId === undefined) {
      rows = this.#listWorkspacesStmt.all({ session_id: request.sessionId }) as WorkspaceRow[];
    } else {
      rows = this.#listWorkspacesByMountStmt.all({
        session_id: request.sessionId,
        repo_mount_id: request.repoMountId,
      }) as WorkspaceRow[];
    }

    const workspaces: WorkspaceListResponse["workspaces"] = [];
    for (const row of rows) {
      workspaces.push(await this.#projectRow(row));
    }
    return { workspaces };
  }

  /**
   * The write gate before a run: probes first (persisting a derived stale transition), then
   * refuses `stale` with `workspace.stale` and `preparing`/`archived` with an invariant error. A
   * `ready` workspace whose mount folder now holds another repository turns `stale` with the
   * reason recorded; one whose mount folder is gone is refused without a write, and so is one whose
   * git could not answer (`RepoRootResolutionError`, `vcs_error`). Holds nothing.
   */
  async assertWritable(workspaceId: string): Promise<void> {
    const row = this.#requireWorkspaceRow(workspaceId);
    const observedState = await this.#observeState(row);

    switch (observedState) {
      case "ready":
        await this.#assertMountIdentity(row);
        return;
      case "stale":
        throw new WorkspaceStaleError(workspaceId);
      case "preparing":
      case "archived":
        throw new WorkspaceServiceInvariantError(
          `workspace "${workspaceId}" cannot accept writes in state "${observedState}"`,
          { kind: "illegal_state_transition", workspaceId },
        );
      default: {
        const unreachable: never = observedState;
        throw new WorkspaceServiceInvariantError(
          `workspace "${workspaceId}" reported an unmodeled state "${String(unreachable)}"`,
          { kind: "workspace_row_unprojectable", workspaceId },
        );
      }
    }
  }

  /**
   * Enter the preparation cycle, `ready | stale -> preparing`, in `targetMode`. The mode is checked
   * against the mount first, since completion takes none. Does not call
   * {@link assertWritable}, which refuses `stale`, a legal predecessor here.
   */
  async beginRootPreparation(
    workspaceId: string,
    targetMode: ExecutionMode,
    options: { readonly actor?: string | null } = {},
  ): Promise<void> {
    const row = this.#requireWorkspaceRow(workspaceId);
    const mountRow = this.#requireMountRowFor(row);

    assertModeOffered(targetMode, mountRow.managed_session_id !== null);

    // Precise refusal before the compare-and-swap, which can only say the predecessor was illegal.
    this.#refuseIllegalPredecessor(row, ["ready", "stale"], "begin preparing");

    await expectSingleRowChanged(
      this.#events.emitWorkspacePreparing({
        sessionId: row.session_id,
        workspaceId,
        actor: options.actor ?? null,
        transactionalPrelude: [
          {
            sql: BEGIN_ROOT_PREPARATION_SQL,
            bindings: { workspace_id: workspaceId, execution_mode: targetMode, now: this.#now() },
            expectedRowCount: 1,
          },
        ],
      }),
      workspaceId,
      "begin preparing",
    );
  }

  /**
   * Finish the cycle, `preparing -> ready`, adopting the execution root the preparation made, the
   * checkout it sits in, the mode it made it in and, after a move, the folder now bound, and
   * clearing any recorded failure. No path is checked for containment (the preparation made or
   * admitted them) but each must be absolute: `fsRoot` becomes an approval scope root and
   * `checkoutRoot` the tree every turn snapshot captures.
   */
  async completeRootPreparation(
    workspaceId: string,
    fsRoot: string,
    options: CompletedRootPreparation & { readonly actor?: string | null },
  ): Promise<void> {
    assertAbsoluteExecutionRoot(fsRoot, workspaceId);
    assertAbsoluteExecutionRoot(options.checkoutRoot, workspaceId);
    if (options.boundRoot !== undefined) {
      assertAbsoluteExecutionRoot(options.boundRoot, workspaceId);
    }
    const row = this.#requireWorkspaceRow(workspaceId);
    this.#refuseIllegalPredecessor(row, ["preparing"], "finish preparing");

    await expectSingleRowChanged(
      this.#events.emitWorkspaceReady({
        sessionId: row.session_id,
        workspaceId,
        actor: options.actor ?? null,
        transactionalPrelude: [
          {
            sql: COMPLETE_ROOT_PREPARATION_SQL,
            bindings: {
              workspace_id: workspaceId,
              fs_root: fsRoot,
              execution_mode: options.executionMode ?? null,
              checkout_root: options.checkoutRoot,
              bound_root: options.boundRoot ?? null,
              now: this.#now(),
            },
            expectedRowCount: 1,
          },
        ],
      }),
      workspaceId,
      "finish preparing",
    );
  }

  /**
   * Abandon the cycle, `preparing -> stale`, recording the detail through
   * {@link normalizeWorkspaceLastError} in `metadata.lastError` (none when nothing publishable
   * remains). `stale` is already what the write gate refuses.
   */
  async failRootPreparation(
    workspaceId: string,
    failureDetail: string,
    options: { readonly actor?: string | null } = {},
  ): Promise<void> {
    const row = this.#requireWorkspaceRow(workspaceId);
    this.#refuseIllegalPredecessor(row, ["preparing"], "record a preparation failure for");

    const lastError = normalizeWorkspaceLastError(failureDetail);
    const now = this.#now();
    const recordFailure: WriteStatement =
      lastError === null
        ? {
            sql: FAIL_ROOT_PREPARATION_WITHOUT_DETAIL_SQL,
            bindings: { workspace_id: workspaceId, now },
            expectedRowCount: 1,
          }
        : {
            sql: FAIL_ROOT_PREPARATION_WITH_DETAIL_SQL,
            bindings: { workspace_id: workspaceId, last_error: lastError, now },
            expectedRowCount: 1,
          };
    await expectSingleRowChanged(
      this.#events.emitWorkspaceStale({
        sessionId: row.session_id,
        workspaceId,
        actor: options.actor ?? null,
        transactionalPrelude: [recordFailure],
      }),
      workspaceId,
      "record a preparation failure for",
    );
  }

  /**
   * Persist a stale transition, and announce it; `lastError` records why, through
   * {@link normalizeWorkspaceLastError}. Returns `false` when the row is already `stale` or
   * `archived`, vanished, or was staled by a concurrent reader (every read path calls this, so it
   * is idempotent).
   */
  async markStale(
    workspaceId: string,
    options: { readonly actor?: string | null; readonly lastError?: string } = {},
  ): Promise<boolean> {
    const row = this.#findWorkspaceRow(workspaceId);
    if (
      row === undefined ||
      row.state === ("stale" satisfies WorkspaceState) ||
      row.state === ("archived" satisfies WorkspaceState)
    ) {
      return false;
    }

    const lastError =
      options.lastError === undefined ? null : normalizeWorkspaceLastError(options.lastError);
    const now = this.#now();
    const recordStale: WriteStatement =
      lastError === null
        ? {
            sql: MARK_STALE_SQL,
            bindings: { workspace_id: workspaceId, now },
            expectedRowCount: 1,
          }
        : {
            sql: MARK_STALE_WITH_DETAIL_SQL,
            bindings: { workspace_id: workspaceId, last_error: lastError, now },
            expectedRowCount: 1,
          };
    try {
      await this.#events.emitWorkspaceStale({
        sessionId: row.session_id,
        workspaceId,
        actor: options.actor ?? null,
        // A refusal is the only way to decline the event: the append path inserts the event row
        // after the prelude regardless. A concurrent reader staling the row since the read is an
        // expected race.
        transactionalPrelude: [recordStale],
      });
    } catch (error) {
      // Only the refusal; anything else is a durability failure `#observeState` attributes.
      if (error instanceof WriteRefusedError) {
        return false;
      }
      throw error;
    }
    return true;
  }

  /**
   * Probe a row if its state owes one, persist any derived stale transition, and return the state
   * to report. The one place the on-read floor is implemented, so `list` and `assertWritable`
   * agree on the current state.
   */
  async #observeState(
    row: WorkspaceRow,
    options: { readonly actor?: string | null } = {},
  ): Promise<WorkspaceState> {
    const projection = await this.#deriveHealth(row);

    if (projection.staleTransitionRequired) {
      try {
        await this.markStale(row.id, options);
      } catch (error) {
        // The health derived fine and the write failed: do not send the person to a healthy row.
        throw wrapRowFailure(error, row.id, "stale_transition_durability_failure");
      }
    }
    return projection.observedState;
  }

  /**
   * Every failure in here is a projection failure; `markStale`'s is a durability one, and the two
   * must not borrow each other's discriminant.
   */
  async #deriveHealth(row: WorkspaceRow): Promise<WorkspaceHealthProjection> {
    // Cast, not parse: the projector's membership check refuses out-of-vocabulary values, and
    // parsing here would move that refusal.
    const state = row.state as WorkspaceState;
    try {
      // A NULL `fs_root` under a probe-bearing state reaches the projector with a `null` probe: it
      // checks the NULL root first, so the throw names the real defect.
      let probe: FilesystemPathProbe | null = null;
      if (PROBE_BEARING_WORKSPACE_STATES.has(state) && row.fs_root !== null) {
        // Verbatim: no re-resolution between the column and the projector.
        probe = await this.#probePath(row.fs_root);
      }
      return computeWorkspaceHealth({ state, fsRoot: row.fs_root }, probe);
    } catch (error) {
      throw wrapRowFailure(error, row.id, "workspace_row_unprojectable");
    }
  }

  async #projectRow(row: WorkspaceRow): Promise<WorkspaceListResponse["workspaces"][number]> {
    try {
      const observedState = await this.#observeState(row);
      // Identifier and mode parses share the wrapper: a corrupt id is the same class as a corrupt
      // state.
      const projected: WorkspaceListResponse["workspaces"][number] = {
        id: WorkspaceIdSchema.parse(row.id),
        repoMountId: RepoMountIdSchema.parse(row.repo_mount_id),
        executionMode: ExecutionModeSchema.parse(row.execution_mode),
        state: observedState,
        ...(row.fs_root === null ? {} : { fsRoot: row.fs_root }),
      };
      const lastError = readLastError(row);
      return lastError === null ? projected : { ...projected, lastError };
    } catch (error) {
      // An already-attributed failure passes through unchanged.
      throw wrapRowFailure(error, row.id, "workspace_row_unprojectable");
    }
  }

  // Refuses a run on a mount whose folder is gone (not persisted: it may come back) or holds
  // another repository than the one attached (persisted: only a re-attach repairs it).
  async #assertMountIdentity(row: WorkspaceRow): Promise<void> {
    const mountRow = this.#requireMountRowFor(row);
    const mountHealth = await this.#probeMountHealth(mountRow);
    if (mountHealth.status === "unreachable") {
      throw new WorkspaceStaleError(row.id);
    }
    if (mountHealth.status === "identity_mismatch") {
      try {
        await this.markStale(row.id, {
          lastError: new RepoRootResolutionError("root_mismatch").message,
        });
      } catch (error) {
        throw wrapRowFailure(error, row.id, "stale_transition_durability_failure");
      }
      throw new WorkspaceStaleError(row.id);
    }
  }

  /**
   * The picked folder admitted on a mount that is reachable and still holds its repository.
   * Reachability comes before containment: `validateExecutionRoot` `realpath`s its candidate, which
   * fails on a vanished root and would report `repo.outside_trust_envelope` (422) instead of
   * `workspace.stale` (409). A pick never follows a retargeted `.git`.
   */
  async #admitOnHealthyMount(
    mountRow: MountRow,
    directory: string | undefined,
    workspaceId: string | null,
  ): Promise<AdmittedExecutionRoot> {
    await this.#refuseUnhealthyMount(mountRow, workspaceId);
    const attachedMountRootRows = this.#selectAttachedMountRootsStmt.all() as ReadonlyArray<{
      readonly canonical_root: string;
    }>;
    return this.#trustEnvelope.validateExecutionRoot({
      mountCanonicalRoot: mountRow.canonical_root,
      directory,
      attachedMountRoots: attachedMountRootRows.map((mountRootRow) => mountRootRow.canonical_root),
      provenanceRoots: this.#readProvenanceRoots(mountRow),
    });
  }

  async #refuseUnhealthyMount(mountRow: MountRow, workspaceId: string | null): Promise<void> {
    const mountHealth = await this.#probeMountHealth(mountRow);
    if (mountHealth.status === "unreachable") {
      throw new WorkspaceStaleError(workspaceId);
    }
    if (mountHealth.status === "identity_mismatch") {
      throw new RepoRootResolutionError("root_mismatch");
    }
  }

  #probeMountHealth(mountRow: MountRow): ReturnType<typeof probeRepoMountHealth> {
    return probeRepoMountHealth(
      { canonicalRoot: mountRow.canonical_root, commonDirAnchor: mountRow.common_dir },
      this.#mountHealthSeams,
    );
  }

  // A managed mount's folder is the daemon's own; a project's admits the worktrees the daemon made.
  #readProvenanceRoots(mountRow: MountRow): readonly string[] {
    if (mountRow.managed_session_id !== null) {
      return [mountRow.canonical_root];
    }
    const rows = this.#selectDaemonWorktreeRootsStmt.all({
      repo_mount_id: mountRow.id,
    }) as ReadonlyArray<{ readonly fs_root: string }>;
    return rows.map((worktreeRow) => worktreeRow.fs_root);
  }

  // The session's live workspace on the mount as stored, or `undefined` when it has none.
  #readLiveWorkspace(input: BindWorkspaceInput): WorkspaceBindResponse | undefined {
    const row = this.#selectLiveWorkspaceStmt.get({
      session_id: input.sessionId,
      repo_mount_id: input.repoMountId,
    }) as Pick<WorkspaceRow, "id" | "execution_mode" | "state"> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      workspaceId: WorkspaceIdSchema.parse(row.id),
      executionMode: ExecutionModeSchema.parse(row.execution_mode),
      state: WorkspaceStateSchema.parse(row.state),
    };
  }

  #findWorkspaceRow(workspaceId: string): WorkspaceRow | undefined {
    return this.#selectWorkspaceStmt.get({
      workspace_id: workspaceId,
    }) as WorkspaceRow | undefined;
  }

  #requireWorkspaceRow(workspaceId: string): WorkspaceRow {
    const row = this.#findWorkspaceRow(workspaceId);
    if (row === undefined) {
      throw new WorkspaceNotFoundError(workspaceId);
    }
    return row;
  }

  /** Resolve a workspace's mount, refusing with `repo.not_found` when it is not `attached`. */
  #requireMountRowFor(row: WorkspaceRow): MountRow {
    const mountRow = this.#selectAttachedMountStmt.get({
      repo_mount_id: row.repo_mount_id,
    }) as MountRow | undefined;
    if (mountRow === undefined) {
      throw new RepoMountNotFoundError(row.repo_mount_id);
    }
    return mountRow;
  }

  #refuseIllegalPredecessor(
    row: WorkspaceRow,
    legalPredecessors: readonly WorkspaceState[],
    attemptedAction: string,
  ): void {
    if (legalPredecessors.includes(row.state as WorkspaceState)) {
      return;
    }
    throw new WorkspaceServiceInvariantError(
      `cannot ${attemptedAction} workspace "${row.id}" in state "${row.state}"`,
      { kind: "illegal_state_transition", workspaceId: row.id },
    );
  }
}

function sessionNotFound(sessionId: SessionId): SessionNotFoundError {
  return new SessionNotFoundError(`session ${sessionId} does not exist`, { sessionId });
}
