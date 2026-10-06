/**
 * Workspace lifecycle service: the daemon-side owner of the `workspaces` table.
 *
 * - Every transition writes its row in the emitter's `transactionalPrelude`, so the row and its
 *   event commit together. The writes are compare-and-swap `UPDATE`s expecting one row; a moved row
 *   refuses the write, event and all.
 * - `fs_root` is an approval-scope boundary: a bind and `beginRootPreparation` write NULL, and only
 *   `completeRootPreparation` writes a path.
 * - The four `workspace.*` domain errors follow the carrier pattern of `./repo/errors.js`; every
 *   code comes from the error registry, and this module mints none.
 */

import type { Statement } from "better-sqlite3";
import {
  ExecutionModeSchema,
  RepoMountIdSchema,
  WorkspaceIdSchema,
  type ExecutionMode,
  type VcsType,
  type WorkspaceState,
} from "@ai-sidekicks/contracts/repo/mount";
import type {
  WorkspaceBindRequest,
  WorkspaceBindResponse,
  WorkspaceListRequest,
  WorkspaceListResponse,
} from "@ai-sidekicks/contracts/repo/workspace";
import type { DatabaseConnections } from "../database/connections.js";
import type { WriteStatement } from "../database/statement.js";
import { WriteRefusedError, type DatabaseWriter } from "../database/writer.js";
import { SessionNotFoundError } from "../ipc/session-errors.js";
import { RepoMountNotFoundError } from "./repo/errors.js";
import { TrustEnvelopeValidator } from "./trust-envelope.js";
import type { WorkspaceEventEmitter } from "./event-emitter.js";
import { mintUuidV7 } from "../uuid-v7.js";
import {
  computeExecutionModeCapabilities,
  computeRepoMountHealth,
  computeWorkspaceHealth,
  PROBE_BEARING_WORKSPACE_STATES,
  type FilesystemPathProbe,
  type WorkspaceHealthProjection,
} from "./projector.js";
import {
  assertAbsoluteExecutionRoot,
  createDefaultPathProbe,
  expectSingleRowChanged,
  type FilesystemPathProbeFn,
  HOLDING_RUN_ID_METADATA_PATH,
  LAST_ERROR_METADATA_PATH,
  type MountRow,
  readHoldingRunId,
  readLastError,
  type WorkspaceRow,
  wrapRowFailure,
} from "./row-guards.js";
import {
  WorkspaceBusyError,
  WorkspaceModeUnsupportedError,
  WorkspaceNotFoundError,
  WorkspaceServiceInvariantError,
  WorkspaceStaleError,
} from "./errors.js";
import { normalizeWorkspaceLastError } from "./last-error.js";

// `SELECT` rather than `VALUES` re-tests the mount's attachment inside the write: a detach cascade
// can flip the mount during `bind`'s awaits, and the foreign key would still hold. Zero rows
// refuses the write and takes the `workspace.preparing` event with it.
const BIND_WORKSPACE_SQL = `INSERT INTO workspaces (
     id, session_id, repo_mount_id, execution_mode, fs_root, state, metadata,
     created_at, updated_at
   )
   SELECT @id, @session_id, @repo_mount_id, @execution_mode, NULL, 'preparing', '{}',
          @now, @now
     FROM repo_mounts
    WHERE id = @repo_mount_id AND state = 'attached'`;

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

// A cycle can complete without re-entering through `beginRootPreparation`; clear it here too.
const COMPLETE_ROOT_PREPARATION_SQL = `UPDATE workspaces
      SET fs_root = @fs_root,
          state = 'ready',
          metadata = json_remove(metadata, '${LAST_ERROR_METADATA_PATH}'),
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

// `stale` is absent (re-staling is a no-op) and so is terminal `archived`. So is `busy`: a run
// keeps its hold to the end, and the first read after the release stales the row.
const MARK_STALE_SQL = `UPDATE workspaces
      SET state = 'stale',
          updated_at = @now
    WHERE id = @workspace_id AND state IN ('preparing', 'ready')`;

// The compare-and-swap is the mutual exclusion: of concurrent runs reading `ready`, exactly one
// changes the row.
const MARK_BUSY_SQL = `UPDATE workspaces
      SET state = 'busy',
          metadata = json_set(metadata, '${HOLDING_RUN_ID_METADATA_PATH}', @run_id),
          updated_at = @now
    WHERE id = @workspace_id AND state = 'ready'`;

// Only a held row is released; the release is no health verdict, so the next read probes it.
const RELEASE_BUSY_SQL = `UPDATE workspaces
      SET state = 'ready',
          metadata = json_remove(metadata, '${HOLDING_RUN_ID_METADATA_PATH}'),
          updated_at = @now
    WHERE id = @workspace_id AND state = 'busy'`;

/**
 * The session-existence predicate a bind checks first (`SessionService.rebuildSession` satisfies
 * it; `null` means no such session). A `rebuildSession` that throws (a corrupt event chain)
 * propagates unchanged, since a 404 would send the person to recreate a session that exists.
 */
export interface SessionExistenceReader {
  rebuildSession(sessionId: string): unknown;
}

/** Constructor dependencies. Every optional member defaults to the real one. */
export interface WorkspaceServiceDeps {
  /**
   * The daemon database: reads prepared on its reader in the constructor, writes through its
   * writer, the one the event log appends through.
   */
  readonly database: DatabaseConnections;
  /** The single seam through which workspace lifecycle events are appended. */
  readonly events: WorkspaceEventEmitter;
  readonly sessions: SessionExistenceReader;
  /** Containment validator. Defaults to a stock `TrustEnvelopeValidator`. */
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
 * Owns every workspace lifecycle transition and statement against `workspaces`, except the detach
 * cascade's read and archive write in `./repo/mount-service.js`, which share the mount flip's
 * write. Legal predecessor states live in each `UPDATE`'s `WHERE` clause.
 */
export class WorkspaceService {
  readonly #events: WorkspaceEventEmitter;
  readonly #sessions: SessionExistenceReader;
  readonly #trustEnvelope: TrustEnvelopeValidator;
  readonly #probePath: FilesystemPathProbeFn;
  readonly #now: () => string;
  readonly #newWorkspaceId: () => string;

  readonly #selectAttachedMountStmt: Statement;
  readonly #selectAttachedMountRootsStmt: Statement;
  readonly #selectWorkspaceStmt: Statement;
  readonly #listWorkspacesStmt: Statement;
  readonly #listWorkspacesByMountStmt: Statement;
  readonly #writer: Pick<DatabaseWriter, "write">;

  constructor(deps: WorkspaceServiceDeps) {
    this.#events = deps.events;
    this.#sessions = deps.sessions;
    this.#trustEnvelope = deps.trustEnvelope ?? new TrustEnvelopeValidator();
    this.#probePath = deps.probePath ?? createDefaultPathProbe();
    this.#now = deps.now ?? ((): string => new Date().toISOString());
    this.#newWorkspaceId = deps.newWorkspaceId ?? mintUuidV7;

    const database = deps.database.reader;
    this.#writer = deps.database.writer;

    // Attached only: a detached mount is not a bind target, and `repo.not_found` is more honest.
    this.#selectAttachedMountStmt = database.prepare(
      `SELECT id, canonical_root, vcs_type
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
   * `fs_root` that {@link completeRootPreparation} fills. Throws `SessionNotFoundError`, before any
   * read or write, when `sessionId` names no session.
   */
  async bind(input: BindWorkspaceInput): Promise<WorkspaceBindResponse> {
    if (this.#sessions.rebuildSession(input.sessionId) === null) {
      throw new SessionNotFoundError(`session ${input.sessionId} does not exist`, {
        sessionId: input.sessionId,
      });
    }

    const mountRow = this.#selectAttachedMountStmt.get({
      repo_mount_id: input.repoMountId,
    }) as MountRow | undefined;
    if (mountRow === undefined) {
      throw new RepoMountNotFoundError(input.repoMountId);
    }

    // Mode capability before any filesystem work.
    const capabilities = computeExecutionModeCapabilities({
      vcsType: mountRow.vcs_type as VcsType,
    });
    if (!capabilities.availableModes.includes(input.executionMode)) {
      throw new WorkspaceModeUnsupportedError(
        input.executionMode,
        capabilities.availableModes,
        capabilities.restrictions?.[input.executionMode] ??
          "the mount's capability matrix does not offer this mode",
      );
    }

    // Reachability before containment: `validateExecutionRoot` `realpath`s its candidate, which
    // fails on a vanished root and would report `repo.outside_trust_envelope` (403) instead of
    // `workspace.stale` (409).
    const mountRootProbe = await this.#probePath(mountRow.canonical_root);
    const mountHealth = computeRepoMountHealth(
      { canonicalRoot: mountRow.canonical_root },
      mountRootProbe,
    );
    if (mountHealth.status !== "healthy") {
      throw new WorkspaceStaleError(null);
    }

    // Containment against every attached mount. The resolved root is discarded: neither mode
    // executes in the requested directory.
    const attachedMountRootRows = this.#selectAttachedMountRootsStmt.all() as ReadonlyArray<{
      readonly canonical_root: string;
    }>;
    await this.#trustEnvelope.validateExecutionRoot({
      mountCanonicalRoot: mountRow.canonical_root,
      directory: input.directory,
      attachedMountRoots: attachedMountRootRows.map((mountRootRow) => mountRootRow.canonical_root),
    });

    const workspaceId = this.#newWorkspaceId();
    const createdAt = this.#now();

    // The mount's attachment is re-tested in this write; zero rows means a detach cascade won the
    // race, and the refusal takes the event with it.
    const insertRow: WriteStatement = {
      sql: BIND_WORKSPACE_SQL,
      bindings: {
        id: workspaceId,
        session_id: input.sessionId,
        repo_mount_id: mountRow.id,
        execution_mode: input.executionMode,
        now: createdAt,
      },
      expectedRowCount: 1,
    };

    // The birth event carries `repoMountId`, the only place a transcript reader learns the
    // workspace/mount association.
    await expectSingleRowChanged(
      this.#events.emitWorkspacePreparing({
        sessionId: input.sessionId,
        workspaceId,
        repoMountId: mountRow.id,
        actor: input.actor ?? null,
        transactionalPrelude: [insertRow],
      }),
      workspaceId,
      "bind",
      "its repo mount",
    );

    return {
      workspaceId: WorkspaceIdSchema.parse(workspaceId),
      executionMode: input.executionMode,
      state: "preparing",
    };
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
   * The write gate: probes first (persisting a derived stale transition), then refuses `stale` with
   * `workspace.stale` and `preparing`/`archived` with an invariant error. `busy` passes; the
   * `workspace.busy` refusal belongs to {@link markBusy}, the call that contends for the hold.
   */
  async assertWritable(workspaceId: string): Promise<void> {
    const row = this.#requireWorkspaceRow(workspaceId);
    const observedState = await this.#observeState(row);

    switch (observedState) {
      case "ready":
      case "busy":
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
   * against the mount's matrix first, since completion takes none. Does not call
   * {@link assertWritable}, which refuses `stale`, a legal predecessor here.
   */
  async beginRootPreparation(
    workspaceId: string,
    targetMode: ExecutionMode,
    options: { readonly actor?: string | null } = {},
  ): Promise<void> {
    const row = this.#requireWorkspaceRow(workspaceId);
    const mountRow = this.#requireMountRowFor(row);

    const capabilities = computeExecutionModeCapabilities({
      vcsType: mountRow.vcs_type as VcsType,
    });
    if (!capabilities.availableModes.includes(targetMode)) {
      throw new WorkspaceModeUnsupportedError(
        targetMode,
        capabilities.availableModes,
        capabilities.restrictions?.[targetMode] ??
          "the mount's capability matrix does not offer this mode",
      );
    }

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
   * Finish the cycle, `preparing -> ready`, adopting the execution root the preparation made and
   * clearing any recorded failure. `fsRoot` is not checked for containment (the preparation made it
   * under daemon control) but must be absolute, since it becomes an approval scope root.
   */
  async completeRootPreparation(
    workspaceId: string,
    fsRoot: string,
    options: { readonly actor?: string | null } = {},
  ): Promise<void> {
    assertAbsoluteExecutionRoot(fsRoot, workspaceId);
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
            bindings: { workspace_id: workspaceId, fs_root: fsRoot, now: this.#now() },
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
   * Persist the stale transition the health projection derives, and announce it. Returns `false`
   * when the row is already `stale` or `archived`, vanished, was staled by a concurrent reader
   * (every read path calls this, so it is idempotent), or is `busy`: a held workspace keeps its
   * run's hold until the run releases it, and the read after the release stales it.
   */
  async markStale(
    workspaceId: string,
    options: { readonly actor?: string | null } = {},
  ): Promise<boolean> {
    const row = this.#findWorkspaceRow(workspaceId);
    if (
      row === undefined ||
      row.state === ("stale" satisfies WorkspaceState) ||
      row.state === ("archived" satisfies WorkspaceState) ||
      row.state === ("busy" satisfies WorkspaceState)
    ) {
      return false;
    }

    try {
      await this.#events.emitWorkspaceStale({
        sessionId: row.session_id,
        workspaceId,
        actor: options.actor ?? null,
        // A refusal is the only way to decline the event: the append path inserts the event row
        // after the prelude regardless. A concurrent reader staling the row, or a run taking its
        // hold, since the read is an expected race.
        transactionalPrelude: [
          {
            sql: MARK_STALE_SQL,
            bindings: { workspace_id: workspaceId, now: this.#now() },
            expectedRowCount: 1,
          },
        ],
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
   * Take the run hold, `ready -> busy`, persisting `runId` to `metadata.holdingRunId` (not on the
   * wire) so {@link WorkspaceBusyError} can name the holder. Emits no event, as workspace events
   * have no `busy` type. Probes first, so a vanished root is refused now rather than mid-run.
   */
  async markBusy(
    workspaceId: string,
    runId: string,
    options: { readonly actor?: string | null } = {},
  ): Promise<void> {
    const row = this.#requireWorkspaceRow(workspaceId);

    // Contention is answered before the probe: the loser needs to know who won, not a filesystem
    // verdict.
    if (row.state === ("busy" satisfies WorkspaceState)) {
      throw new WorkspaceBusyError(workspaceId, readHoldingRunId(row));
    }

    const observedState = await this.#observeState(row, options);
    if (observedState === "stale") {
      throw new WorkspaceStaleError(workspaceId);
    }
    if (observedState !== "ready") {
      throw new WorkspaceServiceInvariantError(
        `workspace "${workspaceId}" cannot be held in state "${observedState}"`,
        { kind: "illegal_state_transition", workspaceId },
      );
    }

    const [taken] = await this.#writer.write([
      {
        sql: MARK_BUSY_SQL,
        bindings: { workspace_id: workspaceId, run_id: runId, now: this.#now() },
      },
    ]);
    if (taken?.rowCount !== 1) {
      // The compare-and-swap lost; re-read to answer with the reason, not the mechanism.
      const currentRow = this.#findWorkspaceRow(workspaceId);
      if (currentRow === undefined) {
        throw new WorkspaceNotFoundError(workspaceId);
      }
      if (currentRow.state === ("busy" satisfies WorkspaceState)) {
        throw new WorkspaceBusyError(workspaceId, readHoldingRunId(currentRow));
      }
      if (currentRow.state === ("stale" satisfies WorkspaceState)) {
        throw new WorkspaceStaleError(workspaceId);
      }
      throw new WorkspaceServiceInvariantError(
        `workspace "${workspaceId}" left state "ready" before the hold could be taken ` +
          `(now "${currentRow.state}")`,
        { kind: "illegal_state_transition", workspaceId },
      );
    }
  }

  /**
   * Release the run hold, `busy -> ready`, emitting no event; returns `true` when a hold was
   * released. A non-`busy` row is a no-op: this runs in a `finally` where a throw would mask the
   * run's real failure. A root that vanished mid-run is staled by the next read's probe.
   */
  async releaseBusy(workspaceId: string): Promise<boolean> {
    const [released] = await this.#writer.write([
      { sql: RELEASE_BUSY_SQL, bindings: { workspace_id: workspaceId, now: this.#now() } },
    ]);
    return released?.rowCount === 1;
  }

  /**
   * Probe a row if its state owes one, persist any derived stale transition, and return the state
   * to report. The one place the on-read floor is implemented, so `list`, `assertWritable` and
   * `markBusy` agree on the current state.
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
    if (row.state === ("busy" satisfies WorkspaceState)) {
      throw new WorkspaceBusyError(row.id, readHoldingRunId(row));
    }
    throw new WorkspaceServiceInvariantError(
      `cannot ${attemptedAction} workspace "${row.id}" in state "${row.state}"`,
      { kind: "illegal_state_transition", workspaceId: row.id },
    );
  }
}
