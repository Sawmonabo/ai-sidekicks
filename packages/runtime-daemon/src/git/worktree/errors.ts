// Typed carriers for the `worktree.*` error codes and the three `workspace.*` codes that
// execution-root preparation raises. Every class extends `DaemonDomainError`: `code` becomes the
// envelope's `data.type` and `detail` becomes `data.fields`.
//
// - A caller-supplied branch name that collides with a live checkout is refused, never adapted.
// - Prepare-time unavailability is `worktree.create_failed`; a mode the mount does not offer, at
//   bind or prepare, is `workspace.mode_unsupported`, so no `worktree.unsupported` code exists.
// - Only `WorktreeNotFoundError` sets `jsonRpcCode` (`-32602`); the rest default to `-32603`.
// - No filesystem path reaches a message: reasons are closed enums looked up in a table, and the
//   other carriers interpolate only opaque ids and git ref names. The one git line a message
//   carries is git's refusal of a branch name, which names nothing but that branch.
// - `workspace.busy` and `repo.not_found` stay with `WorkspaceBusyError` and
//   `RepoMountNotFoundError`, so `instanceof` never depends on which module a throw site imported.

import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/error-code";
import {
  WORKTREE_RETIRE_CONFLICT_CODE,
  type WorktreeRetireConflictCode,
} from "@ai-sidekicks/contracts/worktree/lifecycle";

import { DaemonDomainError } from "../../ipc/domain-error.js";

// Each `super()` call pins its literal with `satisfies`. Subclasses do not redeclare `code`: under
// `useDefineForClassFields` that would clobber the base constructor's value, so discriminate by
// `instanceof`, never by narrowing `code`.

/** The `worktree.*` error codes, in registry order. */
type WorktreeErrorCode =
  | "worktree.not_found"
  | "worktree.create_failed"
  | "worktree.branch_collision"
  | WorktreeRetireConflictCode;

/**
 * The `workspace.*` codes this module carries; the others have carriers in
 * `../../workspace/errors.js`.
 */
type WorkspaceErrorCode =
  | "workspace.branch_mismatch"
  | "workspace.execution_root_unresolved"
  | "workspace.branch_name_required";

/**
 * Why worktree creation failed; closed and path-free, so it is safe on the wire. The last reason,
 * `branch_name_underivable`, belongs to `deriveWorktreeBranchName` alone: `create` requires a
 * `branchName`, so it cannot reach it.
 */
export type WorktreeCreateFailureReason =
  | WorktreeCreateFailureTableReason
  | "branch_name_invalid"
  | "branch_name_underivable";

/** The reasons whose message comes from the table; `branch_name_invalid` carries git's line. */
type WorktreeCreateFailureTableReason =
  | "base_ref_option_like"
  | "base_ref_unresolved"
  | "branch_name_unavailable"
  | "execution_root_unavailable"
  | "git_invocation_failed";

const WORKTREE_CREATE_FAILURE_MESSAGES: Record<
  WorktreeCreateFailureTableReason | "branch_name_underivable",
  string
> = {
  base_ref_option_like:
    "worktree creation failed: the supplied base ref begins with '-' and would be read as a " +
    "git option rather than as a commit-ish",
  base_ref_unresolved:
    "worktree creation failed: no base ref was supplied and the repo mount's HEAD does not " +
    "resolve to a branch",
  branch_name_unavailable:
    "worktree creation failed: no usable branch name was available under the request's " +
    "collision policy and the ref-length cap",
  execution_root_unavailable:
    "worktree creation failed: the daemon execution root could not be prepared",
  git_invocation_failed: "worktree creation failed: the git worktree invocation did not complete",
  branch_name_underivable:
    "worktree creation failed: no branch name could be derived, since neither a slugifiable " +
    "summary nor a run id was available",
};

/**
 * `worktree.not_found`: the worktree id did not resolve. The only class in its namespace that sets
 * `jsonRpcCode`.
 */
export class WorktreeNotFoundError extends DaemonDomainError {
  readonly worktreeId: string;

  constructor(worktreeId: string) {
    super(`worktree ${worktreeId} does not exist`, {
      code: "worktree.not_found" satisfies WorktreeErrorCode,
      jsonRpcCode: JsonRpcErrorCode.InvalidParams,
      detail: { worktreeId },
    });
    this.worktreeId = worktreeId;
  }
}

/**
 * `worktree.create_failed`; the workspace goes `stale` via `failRootPreparation`. The message is
 * the closed reason's, except `branch_name_invalid`, whose message is git's own `fatal:` line
 * refusing the name, shown as git prints it. A `cause` (git's rejection, which can name a path)
 * stays on the error for local logs and never reaches the wire.
 */
export class WorktreeCreateFailedError extends DaemonDomainError {
  readonly reason: WorktreeCreateFailureReason;

  constructor(reason: "branch_name_invalid", gitRefusalLine: string, cause: unknown);
  constructor(reason: Exclude<WorktreeCreateFailureReason, "branch_name_invalid">, cause?: unknown);
  constructor(
    reason: WorktreeCreateFailureReason,
    gitRefusalLineOrCause?: unknown,
    branchNameRefusalCause?: unknown,
  ) {
    super(
      reason === "branch_name_invalid"
        ? String(gitRefusalLineOrCause)
        : WORKTREE_CREATE_FAILURE_MESSAGES[reason],
      {
        code: "worktree.create_failed" satisfies WorktreeErrorCode,
        detail: { reason },
      },
    );
    this.reason = reason;
    const cause: unknown =
      reason === "branch_name_invalid" ? branchNameRefusalCause : gitRefusalLineOrCause;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/**
 * `worktree.branch_collision`: a caller-supplied branch name collides with a live checkout on the
 * same mount. Raised only on the `onCollision: 'refuse'` arm; `suffix` never does.
 */
export class WorktreeBranchCollisionError extends DaemonDomainError {
  readonly repoMountId: string;
  readonly branchName: string;

  constructor(repoMountId: string, branchName: string) {
    super(
      `worktree creation refused: branch ${branchName} already has a live checkout on repo ` +
        `mount ${repoMountId}`,
      {
        code: "worktree.branch_collision" satisfies WorktreeErrorCode,
        detail: { repoMountId, branchName },
      },
    );
    this.repoMountId = repoMountId;
    this.branchName = branchName;
  }
}

/**
 * `worktree.retire_conflict`: retire refused while a `busy` workspace holds the worktree as its
 * execution root for an active run; it clears when the run releases it.
 */
export class WorktreeRetireConflictError extends DaemonDomainError {
  readonly worktreeId: string;
  readonly holdingWorkspaceId: string;

  constructor(worktreeId: string, holdingWorkspaceId: string) {
    super(
      `worktree ${worktreeId} cannot be retired: workspace ${holdingWorkspaceId} is holding ` +
        `it for an active run`,
      {
        code: WORKTREE_RETIRE_CONFLICT_CODE,
        detail: { worktreeId, holdingWorkspaceId },
      },
    );
    this.worktreeId = worktreeId;
    this.holdingWorkspaceId = holdingWorkspaceId;
  }
}

/**
 * `workspace.branch_mismatch`: `bound-root` bind-only verification found the main checkout on a
 * different branch than requested; the daemon never switches branches there.
 */
export class WorkspaceBranchMismatchError extends DaemonDomainError {
  readonly workspaceId: string;
  readonly requestedBranchName: string;
  readonly currentBranchName: string;

  constructor(workspaceId: string, requestedBranchName: string, currentBranchName: string) {
    super(
      `bound-root bind refused for workspace ${workspaceId}: the checkout is on ` +
        `${currentBranchName}, not the requested ${requestedBranchName}; the daemon never ` +
        "switches branches in the main checkout",
      {
        code: "workspace.branch_mismatch" satisfies WorkspaceErrorCode,
        detail: { workspaceId, requestedBranchName, currentBranchName },
      },
    );
    this.workspaceId = workspaceId;
    this.requestedBranchName = requestedBranchName;
    this.currentBranchName = currentBranchName;
  }
}

/**
 * `workspace.execution_root_unresolved`: root preparation failed at the setup gate, which ends
 * the run `failed` with this error as its cause. Carries the cause's dotted code, not the cause
 * object, whose message would reopen the prose channel.
 *
 * @consumedBy the run setup gate, which fails a run whose execution root cannot be made
 */
export class WorkspaceExecutionRootUnresolvedError extends DaemonDomainError {
  readonly workspaceId: string;
  /** The wrapped cause's dotted code, or `null` when it carried none. */
  readonly causeCode: string | null;

  constructor(workspaceId: string, causeCode: string | null) {
    super(
      causeCode === null
        ? `workspace ${workspaceId} has no resolved execution root: root preparation failed ` +
            `and the run ended failed`
        : `workspace ${workspaceId} has no resolved execution root: root preparation failed ` +
            `with ${causeCode} and the run ended failed`,
      {
        code: "workspace.execution_root_unresolved" satisfies WorkspaceErrorCode,
        detail: causeCode === null ? { workspaceId } : { workspaceId, causeCode },
      },
    );
    this.workspaceId = workspaceId;
    this.causeCode = causeCode;
  }
}

/**
 * `workspace.branch_name_required`: a wire `repo.executionRootPrepare` omitted `branchName`; the
 * daemon derives one only from a run id, which exists only on the run-setup gate path. Raised
 * before any git call.
 */
export class WorkspaceBranchNameRequiredError extends DaemonDomainError {
  readonly workspaceId: string;

  constructor(workspaceId: string) {
    super(
      `execution root prepare refused for workspace ${workspaceId}: a wire prepare must ` +
        "carry a branch name, because the daemon's derivation inputs exist only on the " +
        "run-setup gate path",
      {
        code: "workspace.branch_name_required" satisfies WorkspaceErrorCode,
        detail: { workspaceId },
      },
    );
    this.workspaceId = workspaceId;
  }
}
