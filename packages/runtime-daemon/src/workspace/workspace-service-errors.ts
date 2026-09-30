/**
 * The typed errors the workspace service throws and the closed set of codes they carry. Each error
 * names its subject and never embeds a path or credential.
 */

import { JsonRpcErrorCode, type ExecutionMode } from "@ai-sidekicks/contracts";
import { DaemonDomainError } from "../ipc/domain-error.js";

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
export class StaleTransitionRaceError extends Error {
  constructor(workspaceId: string) {
    super(
      `WorkspaceService.markStale: workspace ${workspaceId} was staled by another reader ` +
        `between the read and the write transaction; aborting so no second ` +
        `workspace.stale event is appended for one transition.`,
    );
    this.name = "StaleTransitionRaceError";
  }
}
