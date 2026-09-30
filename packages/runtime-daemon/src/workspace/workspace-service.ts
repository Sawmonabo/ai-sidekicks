/**
 * Workspace lifecycle service: the daemon-side owner of the `workspaces` table.
 *
 * - Every transition writes its row inside the emitter's `transactionalPrelude`, so the row and its
 *   event commit together. The writes are compare-and-swap `UPDATE`s that re-check and throw inside
 *   the prelude.
 * - `fs_root` is an approval-scope boundary: a bind and `beginRootPreparation` write NULL, and only
 *   `completeRootPreparation` writes a path.
 * - The four `workspace.*` domain errors follow the carrier pattern of `./repo-errors.js`; every
 *   code comes from the error registry, and this module mints none.
 */

import type { Database, Statement } from "better-sqlite3";

import {
  ExecutionModeSchema,
  JsonRpcErrorCode,
  RepoMountIdSchema,
  WorkspaceIdSchema,
  WORKSPACE_LAST_ERROR_MAX_LEN,
  type ExecutionMode,
  type VcsType,
  type WorkspaceBindRequest,
  type WorkspaceBindResponse,
  type WorkspaceListRequest,
  type WorkspaceListResponse,
  type WorkspaceState,
} from "@ai-sidekicks/contracts";

import { DaemonDomainError } from "../ipc/domain-error.js";
import { SessionNotFoundError } from "../ipc/session-errors.js";

import { RepoMountNotFoundError } from "./repo-errors.js";
import {
  DEFAULT_DIRECTORY_READABILITY_PROBE,
  TrustEnvelopeValidator,
  type DirectoryReadabilityProbe,
} from "./trust-envelope.js";
import type { WorkspaceEventEmitter } from "./workspace-event-emitter.js";
import { mintUuidV7 } from "../ids/uuid-v7.js";
import {
  computeExecutionModeCapabilities,
  computeRepoMountHealth,
  computeWorkspaceHealth,
  PROBE_BEARING_WORKSPACE_STATES,
  type FilesystemPathProbe,
  type WorkspaceHealthProjection,
} from "./workspace-projector.js";

/**
 * The workspace-scoped codes this module raises; the provisioner's `workspace.*` codes are not
 * listed.
 */
export type WorkspaceServiceErrorCode =
  | "workspace.not_found"
  | "workspace.mode_unsupported"
  | "workspace.stale"
  | "workspace.busy";

/** Registered `workspace.*` codes raised by this service, in registry order. */
export const WORKSPACE_SERVICE_ERROR_CODES: readonly WorkspaceServiceErrorCode[] = [
  "workspace.not_found",
  "workspace.mode_unsupported",
  "workspace.stale",
  "workspace.busy",
];

/**
 * `workspace.not_found` — the named workspace does not exist (notional HTTP 404). The only
 * carrier here that sets `jsonRpcCode` (`-32602`, as `repo.not_found` does); the others take the
 * mapper's `-32603` default.
 */
export class WorkspaceNotFoundError extends DaemonDomainError {
  /** The workspace id that did not resolve. Projects to `data.fields.workspaceId`. */
  readonly workspaceId: string;

  constructor(workspaceId: string) {
    super(`workspace ${workspaceId} does not exist`, {
      code: "workspace.not_found" satisfies WorkspaceServiceErrorCode,
      jsonRpcCode: JsonRpcErrorCode.InvalidParams,
      httpStatus: 404,
      detail: { workspaceId },
    });
    this.workspaceId = workspaceId;
  }
}

/**
 * `workspace.mode_unsupported` — the execution mode is unavailable on this mount (notional HTTP
 * 400). Carries the capability matrix's own bounded reason. `availableModes` is copied so a caller
 * that keeps mutating its array cannot rewrite an error already thrown.
 */
export class WorkspaceModeUnsupportedError extends DaemonDomainError {
  /** The refused mode. Projects to `data.fields.executionMode`. */
  readonly executionMode: ExecutionMode;
  /** The modes that ARE available on the mount. Projects to `data.fields.availableModes`. */
  readonly availableModes: readonly ExecutionMode[];

  constructor(
    executionMode: ExecutionMode,
    availableModes: readonly ExecutionMode[],
    reason: string,
  ) {
    super(`execution mode ${executionMode} is unavailable on this repo mount: ${reason}`, {
      code: "workspace.mode_unsupported" satisfies WorkspaceServiceErrorCode,
      httpStatus: 400,
      detail: { executionMode, availableModes: [...availableModes], reason },
    });
    this.executionMode = executionMode;
    this.availableModes = [...availableModes];
  }
}

/**
 * `workspace.stale` — the execution root is gone (notional HTTP 409). Also raised by
 * {@link WorkspaceService.bind} with a `null` subject when the mount root is unreachable. No path
 * is echoed, since a daemon error can reach a remote caller.
 */
export class WorkspaceStaleError extends DaemonDomainError {
  /** The stale workspace, or `null` when the subject is a not-yet-created bind. */
  readonly workspaceId: string | null;

  constructor(workspaceId: string | null) {
    super(
      workspaceId === null
        ? "workspace binding refused: the repo mount's execution root is no longer reachable"
        : `workspace ${workspaceId} is stale: its execution root is no longer reachable`,
      {
        code: "workspace.stale" satisfies WorkspaceServiceErrorCode,
        httpStatus: 409,
        detail: workspaceId === null ? {} : { workspaceId },
      },
    );
    this.workspaceId = workspaceId;
  }
}

/**
 * `workspace.busy` — the workspace is held by a run (notional HTTP 409). Names the holding run,
 * the caller's only repair affordance, or `null` when the row carries no attribution.
 */
export class WorkspaceBusyError extends DaemonDomainError {
  /** The busy workspace. Projects to `data.fields.workspaceId`. */
  readonly workspaceId: string;
  /** The run holding it, or `null` when the row carries no attribution. */
  readonly holdingRunId: string | null;

  constructor(workspaceId: string, holdingRunId: string | null) {
    super(
      holdingRunId === null
        ? `workspace ${workspaceId} is busy`
        : `workspace ${workspaceId} is busy: held by run ${holdingRunId}`,
      {
        code: "workspace.busy" satisfies WorkspaceServiceErrorCode,
        httpStatus: 409,
        detail: holdingRunId === null ? { workspaceId } : { workspaceId, holdingRunId },
      },
    );
    this.workspaceId = workspaceId;
    this.holdingRunId = holdingRunId;
  }
}

/**
 * Discriminants for {@link WorkspaceServiceInvariantError}; they differ only in what an operator
 * should inspect, and nothing branches on them.
 */
export type WorkspaceServiceInvariantKind =
  /**
   * A stored row cannot be projected onto the wire shape (bad state, NULL `fs_root` under a
   * probe-bearing state, a probe of another path, or an id the contracts refuse). A probe of
   * another path is a bug in this module; the rest is corrupt data.
   */
  | "workspace_row_unprojectable"
  /**
   * The on-read floor derived a stale transition it could not make durable (locked database, full
   * disk, size refusal). The row is fine; the write path is the defect.
   */
  | "stale_transition_durability_failure"
  /** A daemon-internal caller asked for a transition the lifecycle does not admit. */
  | "illegal_state_transition"
  /**
   * A caller offered an execution root that is not one complete location (see
   * {@link assertAbsoluteExecutionRoot}); completing it would widen the approval scope.
   */
  | "non_absolute_execution_root";

/**
 * A daemon-internal failure with no registered wire code, so not a `DaemonDomainError`: borrowing
 * a code would misreport the cause. It reaches the IPC boundary as an anonymous `-32603`.
 */
export class WorkspaceServiceInvariantError extends Error {
  /** What broke. See {@link WorkspaceServiceInvariantKind}. */
  readonly kind: WorkspaceServiceInvariantKind;
  /** The row this failure attaches to, or `null` when no row is implicated. */
  readonly workspaceId: string | null;

  constructor(
    message: string,
    options: {
      readonly kind: WorkspaceServiceInvariantKind;
      readonly workspaceId?: string | null;
      readonly cause?: unknown;
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    // Mirrors `DaemonDomainError`: the name comes from the constructor that ran.
    this.name = new.target.name;
    this.kind = options.kind;
    this.workspaceId = options.workspaceId ?? null;
  }
}

/**
 * Module-private abort signal for `markStale`'s compare-and-swap. The append path inserts the event
 * row after the prelude regardless, so only a throw stops a duplicate `workspace.stale`;
 * `markStale` catches this class and returns `false`.
 */
class StaleTransitionRaceError extends Error {
  constructor(workspaceId: string) {
    super(
      `WorkspaceService.markStale: workspace ${workspaceId} was staled by another reader ` +
        `between the read and the write transaction; aborting so no second ` +
        `workspace.stale event is appended for one transition.`,
    );
    this.name = "StaleTransitionRaceError";
  }
}

/** Marker appended to a truncated detail; counted inside the cap, which is also the wire cap. */
export const WORKSPACE_LAST_ERROR_TRUNCATION_MARKER = "...[truncated]";

// URL userinfo (`scheme://user:password@host`): the one credential shape with no recognizable
// token prefix, so no other pattern catches it.
const URL_USERINFO_PATTERN = /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@]+@/g;

// Header-style credentials, including git's `x-access-token` form for GitHub App tokens.
const HEADER_CREDENTIAL_PATTERN =
  /((?:authorization|proxy-authorization|private-token|x-auth-token|x-access-token)\s*[:=]\s*)(?:bearer\s+|basic\s+|token\s+)?[^\s,;]+/gi;

const KEY_VALUE_CREDENTIAL_PATTERN =
  /((?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|token)\s*[:=]\s*)(["']?)[^\s"'&,;]+/gi;

const KNOWN_TOKEN_PREFIX_PATTERN =
  /\b(?:gh[pousr]_|github_pat_|glpat-|xox[abprs]-|sk-|AKIA)[A-Za-z0-9_-]{8,}/g;

const CREDENTIAL_REDACTION = "***";

/**
 * Remove credential material from a captured failure detail. Over-redaction is the accepted
 * direction (`token: not found` becomes `token: ***`); under-redaction would put a live credential
 * on the wire.
 */
export function scrubCredentials(rawDetail: string): string {
  return rawDetail
    .replace(URL_USERINFO_PATTERN, `$1${CREDENTIAL_REDACTION}@`)
    .replace(HEADER_CREDENTIAL_PATTERN, `$1${CREDENTIAL_REDACTION}`)
    .replace(KEY_VALUE_CREDENTIAL_PATTERN, `$1$2${CREDENTIAL_REDACTION}`)
    .replace(KNOWN_TOKEN_PREFIX_PATTERN, CREDENTIAL_REDACTION);
}

/**
 * Cut a detail to `WORKSPACE_LAST_ERROR_MAX_LEN` with a marker. The cap counts UTF-16 code units,
 * as Zod's `.max()` does; the cut backs off one unit rather than split a surrogate pair.
 */
export function truncateWorkspaceLastError(detail: string): string {
  if (detail.length <= WORKSPACE_LAST_ERROR_MAX_LEN) {
    return detail;
  }
  let cutAt = WORKSPACE_LAST_ERROR_MAX_LEN - WORKSPACE_LAST_ERROR_TRUNCATION_MARKER.length;
  const lastRetainedUnit = detail.charCodeAt(cutAt - 1);
  if (lastRetainedUnit >= 0xd800 && lastRetainedUnit <= 0xdbff) {
    cutAt -= 1;
  }
  return `${detail.slice(0, cutAt)}${WORKSPACE_LAST_ERROR_TRUNCATION_MARKER}`;
}

/**
 * Make a raw failure detail safe to persist and legal on the wire, or `null` when nothing
 * publishable survives. Truncating before scrubbing could cut a credential mid-pattern and leave a
 * live secret.
 */
export function normalizeWorkspaceLastError(rawDetail: string): string | null {
  // NULs first: one could split a token past its pattern, and the wire schema forbids them.
  const nulFree = rawDetail.replace(/\0/g, "");
  const scrubbed = scrubCredentials(nulFree);
  // Tested before truncation: the marker's characters would let an over-cap blank detail pass.
  if (!/\S/.test(scrubbed)) {
    return null;
  }
  return truncateWorkspaceLastError(scrubbed);
}

/**
 * Measure a path's reachability. The seam is at probe granularity so a test can return a
 * `FilesystemPathProbe` this module did not build. Production sets `probedPath` from its argument
 * only; re-canonicalizing it would defeat the projector's path-match guard.
 */
export type FilesystemPathProbeFn = (path: string) => Promise<FilesystemPathProbe>;

/**
 * The session-existence predicate a bind checks first (`SessionService.replay` satisfies it; `null`
 * means no such session). A `replay` that throws (a corrupt event chain) propagates unchanged,
 * since a 404 would send an operator to recreate a session that exists.
 */
export interface SessionExistenceReader {
  replay(sessionId: string): unknown;
}

/** Constructor dependencies. Every optional member defaults to the real one. */
export interface WorkspaceServiceDeps {
  /**
   * Open daemon database, statements prepared in the constructor. Must be the event log's own
   * connection: on another one, row/event atomicity is silently lost.
   */
  readonly database: Database;
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

/** The `repo_mounts` columns this service reads. */
interface MountRow {
  readonly id: string;
  readonly canonical_root: string;
  readonly vcs_type: string;
}

/** The `workspaces` columns this service reads. */
interface WorkspaceRow {
  readonly id: string;
  readonly session_id: string;
  readonly repo_mount_id: string;
  readonly execution_mode: string;
  readonly fs_root: string | null;
  readonly state: string;
  readonly metadata: string;
}

/** Inputs for {@link WorkspaceService.bind}. */
export interface BindWorkspaceInput extends WorkspaceBindRequest {
  /** Envelope actor; defaults to the system actor. */
  readonly actor?: string | null;
}

// `lastError` crosses the wire on the list response; `holdingRunId` is daemon-internal and never
// does.
const LAST_ERROR_METADATA_KEY = "lastError";
const LAST_ERROR_METADATA_PATH = `$.${LAST_ERROR_METADATA_KEY}`;
const HOLDING_RUN_ID_METADATA_KEY = "holdingRunId";
/** The JSON path in `workspaces.metadata` of the run holding a `busy` workspace. */
export const HOLDING_RUN_ID_METADATA_PATH: string = `$.${HOLDING_RUN_ID_METADATA_KEY}`;

/**
 * Owns every workspace lifecycle transition and statement against `workspaces`, except the detach
 * cascade's read and archive write in `./repo-mount-service.js`, which share the mount flip's
 * transaction. Legal predecessor states live in each `UPDATE`'s `WHERE` clause.
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
  readonly #bindWorkspaceStmt: Statement;
  readonly #beginReprovisionStmt: Statement;
  readonly #completeReprovisionStmt: Statement;
  readonly #failReprovisionWithDetailStmt: Statement;
  readonly #failReprovisionWithoutDetailStmt: Statement;
  readonly #markStaleStmt: Statement;
  readonly #markBusyStmt: Statement;
  readonly #releaseBusyStmt: Statement;

  constructor(deps: WorkspaceServiceDeps) {
    this.#events = deps.events;
    this.#sessions = deps.sessions;
    this.#trustEnvelope = deps.trustEnvelope ?? new TrustEnvelopeValidator();
    this.#probePath = deps.probePath ?? createDefaultPathProbe();
    this.#now = deps.now ?? ((): string => new Date().toISOString());
    this.#newWorkspaceId = deps.newWorkspaceId ?? mintUuidV7;

    const database = deps.database;

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

    // `SELECT` rather than `VALUES` re-tests the mount's attachment inside the write transaction: a
    // detach cascade can flip the mount during `bind`'s awaits, and the foreign key would still
    // hold. Zero rows changed aborts the prelude and takes the `workspace.preparing` event with it.
    this.#bindWorkspaceStmt = database.prepare(
      `INSERT INTO workspaces (
         id, session_id, repo_mount_id, execution_mode, fs_root, state, metadata,
         created_at, updated_at
       )
       SELECT @id, @session_id, @repo_mount_id, @execution_mode, NULL, 'preparing', '{}',
              @now, @now
         FROM repo_mounts
        WHERE id = @repo_mount_id AND state = 'attached'`,
    );

    // `stale` is a legal predecessor so a failed switch can be retried. `fs_root` is nulled because
    // a stale root would keep matching approvals; `lastError` is cleared so a retried `preparing`
    // row does not advertise the last failure. `execution_mode` is set: completion takes no mode.
    this.#beginReprovisionStmt = database.prepare(
      `UPDATE workspaces
          SET execution_mode = @execution_mode,
              fs_root = NULL,
              state = 'preparing',
              metadata = json_remove(metadata, '${LAST_ERROR_METADATA_PATH}'),
              updated_at = @now
        WHERE id = @workspace_id AND state IN ('ready', 'stale')`,
    );

    // A cycle can complete without re-entering through `beginRootPreparation`; clear it here too.
    this.#completeReprovisionStmt = database.prepare(
      `UPDATE workspaces
          SET fs_root = @fs_root,
              state = 'ready',
              metadata = json_remove(metadata, '${LAST_ERROR_METADATA_PATH}'),
              updated_at = @now
        WHERE id = @workspace_id AND state = 'preparing'`,
    );

    // `json_set`, not a whole-blob rewrite: `metadata` is shared and holds keys other writers own.
    this.#failReprovisionWithDetailStmt = database.prepare(
      `UPDATE workspaces
          SET state = 'stale',
              metadata = json_set(metadata, '${LAST_ERROR_METADATA_PATH}', @last_error),
              updated_at = @now
        WHERE id = @workspace_id AND state = 'preparing'`,
    );

    this.#failReprovisionWithoutDetailStmt = database.prepare(
      `UPDATE workspaces
          SET state = 'stale',
              metadata = json_remove(metadata, '${LAST_ERROR_METADATA_PATH}'),
              updated_at = @now
        WHERE id = @workspace_id AND state = 'preparing'`,
    );

    // `stale` is absent (re-staling is a no-op) and so is terminal `archived`. The hold is released
    // in the same statement so `workspace.busy` never names a long-gone run.
    this.#markStaleStmt = database.prepare(
      `UPDATE workspaces
          SET state = 'stale',
              metadata = json_remove(metadata, '${HOLDING_RUN_ID_METADATA_PATH}'),
              updated_at = @now
        WHERE id = @workspace_id AND state IN ('preparing', 'ready', 'busy')`,
    );

    // The compare-and-swap is the mutual exclusion: concurrent runs reading `ready` produce exactly
    // one `changes === 1`.
    this.#markBusyStmt = database.prepare(
      `UPDATE workspaces
          SET state = 'busy',
              metadata = json_set(metadata, '${HOLDING_RUN_ID_METADATA_PATH}', @run_id),
              updated_at = @now
        WHERE id = @workspace_id AND state = 'ready'`,
    );

    // `state = 'busy'` is the never-auto-heal rule: a workspace staled mid-run stays stale.
    this.#releaseBusyStmt = database.prepare(
      `UPDATE workspaces
          SET state = 'ready',
              metadata = json_remove(metadata, '${HOLDING_RUN_ID_METADATA_PATH}'),
              updated_at = @now
        WHERE id = @workspace_id AND state = 'busy'`,
    );
  }

  /**
   * Bind a workspace to an attached mount (`repo.workspaceBind`); it lands `preparing` with a NULL
   * `fs_root` that {@link completeRootPreparation} fills. Throws `SessionNotFoundError`, before any
   * read or write, when `sessionId` names no session.
   */
  async bind(input: BindWorkspaceInput): Promise<WorkspaceBindResponse> {
    if (this.#sessions.replay(input.sessionId) === null) {
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
    // race, and aborting rolls the event back.
    const insertRow = (): void => {
      assertSingleRowChanged(
        this.#bindWorkspaceStmt.run({
          id: workspaceId,
          session_id: input.sessionId,
          repo_mount_id: mountRow.id,
          execution_mode: input.executionMode,
          now: createdAt,
        }),
        workspaceId,
        "bind",
        "its repo mount",
      );
    };

    // The birth event carries `repoMountId`, the only place a timeline reader learns the
    // workspace/mount association.
    await this.#events.emitWorkspacePreparing({
      sessionId: input.sessionId,
      workspaceId,
      repoMountId: mountRow.id,
      actor: input.actor ?? null,
      transactionalPrelude: insertRow,
    });

    return {
      workspaceId: WorkspaceIdSchema.parse(workspaceId),
      executionMode: input.executionMode,
      state: "preparing",
    };
  }

  /**
   * List a session's workspaces through the health projection (`repo.workspaceList`), persisting
   * any derived stale transition. A per-row failure fails the whole response: dropping the row
   * would shorten the roster an operator uses to decide what to detach.
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
   * Enter the reprovision cycle, `ready | stale -> preparing`, in `targetMode`. The mode is checked
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
    this.#refuseIllegalPredecessor(row, ["ready", "stale"], "reprovision");

    const now = this.#now();
    await this.#events.emitWorkspacePreparing({
      sessionId: row.session_id,
      workspaceId,
      actor: options.actor ?? null,
      transactionalPrelude: () => {
        assertSingleRowChanged(
          this.#beginReprovisionStmt.run({
            workspace_id: workspaceId,
            execution_mode: targetMode,
            now,
          }),
          workspaceId,
          "reprovision",
        );
      },
    });
  }

  /**
   * Finish the cycle, `preparing -> ready`, adopting the provisioner's execution root and clearing
   * any recorded failure. `fsRoot` is not checked for containment (the provisioner made it under
   * daemon control) but must be absolute, since it becomes an approval scope root.
   */
  async completeRootPreparation(
    workspaceId: string,
    fsRoot: string,
    options: { readonly actor?: string | null } = {},
  ): Promise<void> {
    assertAbsoluteExecutionRoot(fsRoot, workspaceId);
    const row = this.#requireWorkspaceRow(workspaceId);
    this.#refuseIllegalPredecessor(row, ["preparing"], "complete provisioning of");

    const now = this.#now();
    await this.#events.emitWorkspaceReady({
      sessionId: row.session_id,
      workspaceId,
      actor: options.actor ?? null,
      transactionalPrelude: () => {
        assertSingleRowChanged(
          this.#completeReprovisionStmt.run({ workspace_id: workspaceId, fs_root: fsRoot, now }),
          workspaceId,
          "complete provisioning of",
        );
      },
    });
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
    this.#refuseIllegalPredecessor(row, ["preparing"], "record a provisioning failure for");

    const lastError = normalizeWorkspaceLastError(failureDetail);
    const now = this.#now();
    await this.#events.emitWorkspaceStale({
      sessionId: row.session_id,
      workspaceId,
      actor: options.actor ?? null,
      transactionalPrelude: () => {
        const result =
          lastError === null
            ? this.#failReprovisionWithoutDetailStmt.run({ workspace_id: workspaceId, now })
            : this.#failReprovisionWithDetailStmt.run({
                workspace_id: workspaceId,
                last_error: lastError,
                now,
              });
        assertSingleRowChanged(result, workspaceId, "record a provisioning failure for");
      },
    });
  }

  /**
   * Persist the stale transition the health projection derives, and announce it. Returns `false`
   * when the row is already `stale` or `archived`, vanished, or was staled by a concurrent reader
   * (every read path calls this, so it is idempotent). `busy -> stale` is written.
   */
  async markStale(
    workspaceId: string,
    options: { readonly actor?: string | null } = {},
  ): Promise<boolean> {
    const row = this.#findWorkspaceRow(workspaceId);
    if (
      row === undefined ||
      row.state === ("stale" satisfies WorkspaceState) ||
      row.state === ("archived" satisfies WorkspaceState)
    ) {
      return false;
    }

    const now = this.#now();
    try {
      await this.#events.emitWorkspaceStale({
        sessionId: row.session_id,
        workspaceId,
        actor: options.actor ?? null,
        transactionalPrelude: () => {
          // Aborting is the only way to decline the event: the append path inserts the event row
          // after the prelude regardless. A concurrent reader winning is an expected race.
          const result = this.#markStaleStmt.run({ workspace_id: workspaceId, now });
          if (result.changes !== 1) {
            throw new StaleTransitionRaceError(workspaceId);
          }
        },
      });
    } catch (error) {
      // Only the sentinel; anything else is a durability failure `#observeState` attributes.
      if (error instanceof StaleTransitionRaceError) {
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

    const changes = this.#markBusyStmt.run({
      workspace_id: workspaceId,
      run_id: runId,
      now: this.#now(),
    }).changes;
    if (changes !== 1) {
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
   * run's real failure, and a workspace that went stale mid-run stays stale.
   */
  releaseBusy(workspaceId: string): boolean {
    return this.#releaseBusyStmt.run({ workspace_id: workspaceId, now: this.#now() }).changes === 1;
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
        // The health derived fine and the write failed: do not send the operator to a healthy row.
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

/**
 * The production probe. Clock first so `checkedAt` is never newer than the observation it stamps
 * (a hung network mount can take seconds).
 */
function createDefaultPathProbe(): FilesystemPathProbeFn {
  return async (path: string): Promise<FilesystemPathProbe> => {
    const checkedAt = new Date().toISOString();
    let reachable = true;
    try {
      await readDirectory(path);
    } catch {
      reachable = false;
    }
    return { probedPath: path, reachable, checkedAt };
  };
}

// One implementation of "can the daemon open this directory?", shared with the trust envelope.
const readDirectory: DirectoryReadabilityProbe = DEFAULT_DIRECTORY_READABILITY_PROBE;

/** The failure classes attributed to a row; `Extract`, so renaming a parent member breaks here. */
type RowAttributedInvariantKind = Extract<
  WorkspaceServiceInvariantKind,
  "workspace_row_unprojectable" | "stale_transition_durability_failure"
>;

/**
 * Fixed message per attributed class; a total `Record`, so a class added without one fails to
 * compile.
 */
const ROW_FAILURE_MESSAGES: Record<RowAttributedInvariantKind, string> = {
  workspace_row_unprojectable: "cannot be projected onto the workspace list response",
  stale_transition_durability_failure: "derived a stale transition that could not be made durable",
};

/**
 * Attribute a per-row failure to its workspace, leaving an already-attributed one alone, so a
 * failed stale write is not relabeled `workspace_row_unprojectable` one layer out.
 */
function wrapRowFailure(
  error: unknown,
  workspaceId: string,
  kind: RowAttributedInvariantKind,
): WorkspaceServiceInvariantError {
  if (error instanceof WorkspaceServiceInvariantError) {
    return error;
  }
  return new WorkspaceServiceInvariantError(
    `workspace "${workspaceId}" ${ROW_FAILURE_MESSAGES[kind]}`,
    { kind, workspaceId, cause: error },
  );
}

/**
 * Refuse an execution root that needs the daemon's own context to become concrete: a relative
 * path, `~`, or a driveless Windows root such as `\repos\app`.
 */
function assertAbsoluteExecutionRoot(candidate: string, workspaceId: string): void {
  if (namesOneCompleteLocation(candidate)) {
    return;
  }
  // Not echoed: the IPC sanitizer redacts only absolute-form paths.
  throw new WorkspaceServiceInvariantError(
    "execution root does not name one complete location; the daemon would have to " +
      "supply the missing piece from its own context",
    { kind: "non_absolute_execution_root", workspaceId },
  );
}

// The complete forms: POSIX absolute, Windows drive-absolute (`C:\repos\app`, `C:/repos/app`) and
// UNC; a lone leading backslash is the driveless root refused above. Not `node:path`'s
// platform-dependent `isAbsolute`: a root stored on one machine must be recognized on another.
const ABSOLUTE_PATH_PATTERN = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;

function namesOneCompleteLocation(candidate: string): boolean {
  return ABSOLUTE_PATH_PATTERN.test(candidate);
}

/**
 * Assert a compare-and-swap moved exactly one row. Called inside a `transactionalPrelude`, where
 * the throw aborts the transaction and takes the event row with it. `movedSubject` names the row
 * that failed the predicate (for `bind`'s conditional insert, the repo mount).
 */
function assertSingleRowChanged(
  result: { readonly changes: number },
  workspaceId: string,
  attemptedAction: string,
  movedSubject: string = "it",
): void {
  if (result.changes !== 1) {
    throw new WorkspaceServiceInvariantError(
      `cannot ${attemptedAction} workspace "${workspaceId}": ${movedSubject} left its ` +
        "expected state before the write committed",
      { kind: "illegal_state_transition", workspaceId },
    );
  }
}

/**
 * Read one string key from a row's `metadata` blob; a non-string value or an unparseable blob
 * reads as `null`.
 */
function readMetadataString(row: WorkspaceRow, key: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.metadata);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const value = (parsed as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

function readLastError(row: WorkspaceRow): string | null {
  return readMetadataString(row, LAST_ERROR_METADATA_KEY);
}

function readHoldingRunId(row: WorkspaceRow): string | null {
  return readMetadataString(row, HOLDING_RUN_ID_METADATA_KEY);
}
