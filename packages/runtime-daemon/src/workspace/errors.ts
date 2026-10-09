/**
 * The typed errors the workspace service throws and the closed set of codes they carry. Each error
 * names its subject and never embeds a path or credential.
 */

import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/error-code";
import type { ExecutionMode } from "@ai-sidekicks/contracts/repo/mount";
import { DaemonDomainError } from "../ipc/domain-error.js";

/**
 * The workspace-scoped codes this module raises; the execution-root service's `workspace.*` codes
 * are not listed.
 */
type WorkspaceServiceErrorCode =
  | "workspace.not_found"
  | "workspace.mode_unsupported"
  | "workspace.stale";

/**
 * `workspace.not_found` — the named workspace does not exist. The only carrier here that sets
 * `jsonRpcCode` (`-32602`, as `repo.not_found` does); the others take the mapper's `-32603`
 * default.
 */
export class WorkspaceNotFoundError extends DaemonDomainError {
  /** The workspace id that did not resolve. Projects to `data.fields.workspaceId`. */
  readonly workspaceId: string;

  constructor(workspaceId: string) {
    super(`workspace ${workspaceId} does not exist`, {
      code: "workspace.not_found" satisfies WorkspaceServiceErrorCode,
      jsonRpcCode: JsonRpcErrorCode.InvalidParams,
      detail: { workspaceId },
    });
    this.workspaceId = workspaceId;
  }
}

/**
 * `workspace.mode_unsupported` — a worktree was asked of a chat's managed workspace, which offers
 * only its own root.
 */
export class WorkspaceModeUnsupportedError extends DaemonDomainError {
  /** The refused mode. Projects to `data.fields.executionMode`. */
  readonly executionMode: ExecutionMode;

  constructor(executionMode: ExecutionMode) {
    super(
      `execution mode ${executionMode} is unavailable on this repo mount: a chat's managed ` +
        "workspace offers only its own root",
      {
        code: "workspace.mode_unsupported" satisfies WorkspaceServiceErrorCode,
        detail: { executionMode },
      },
    );
    this.executionMode = executionMode;
  }
}

/**
 * `workspace.stale` — the execution root is gone, or its mount's folder is unreachable or holds
 * another repository now. Also raised by {@link WorkspaceService.bind} with a `null` subject when
 * the mount root is unreachable. No path is echoed, since a daemon error can reach a remote caller.
 */
export class WorkspaceStaleError extends DaemonDomainError {
  /** The stale workspace, or `null` when the subject is a not-yet-created bind. */
  readonly workspaceId: string | null;

  constructor(workspaceId: string | null) {
    super(
      workspaceId === null
        ? "workspace binding refused: the repo mount's execution root is no longer reachable"
        : `workspace ${workspaceId} is stale: new runs are blocked until it is repaired`,
      {
        code: "workspace.stale" satisfies WorkspaceServiceErrorCode,
        detail: workspaceId === null ? {} : { workspaceId },
      },
    );
    this.workspaceId = workspaceId;
  }
}

/**
 * Discriminants for {@link WorkspaceServiceInvariantError}; they differ only in what the person
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
  | "non_absolute_execution_root"
  /** A run's root has no branch context recorded, so its run context cannot be written. */
  | "branch_context_missing";

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
