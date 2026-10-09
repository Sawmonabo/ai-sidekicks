// Typed carriers for the `worktree.*` error codes and the two `workspace.*` codes that
// execution-root preparation raises. Every class extends `DaemonDomainError`: `code` becomes the
// envelope's `data.type` and `detail` becomes `data.fields`.
//
// - A caller-supplied branch name that collides with a live checkout is refused, never adapted.
// - Prepare-time unavailability is `worktree.create_failed`; a mode the mount does not offer, at
//   bind or prepare, is `workspace.mode_unsupported`, so no `worktree.unsupported` code exists.
// - Only `WorktreeNotFoundError` and `RemovedWorktreeNotFoundError` set `jsonRpcCode` (`-32602`),
//   since each answers an id that did not resolve; the rest default to `-32603`.
// - No filesystem path reaches a message: reasons are closed sets looked up in a table, and the
//   other carriers interpolate only opaque ids, git ref names and commit ids. The git line a
//   message carries is git's refusal of a branch name, which names only branches.
// - `repo.not_found` stays with `RepoMountNotFoundError`, so `instanceof` never depends on which
//   module a throw site imported.

import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/error-code";
import {
  WORKTREE_REMOVED_NOT_FOUND_CODE,
  WORKTREE_RETIRE_CONFLICT_CODE,
  WORKTREE_RETIRE_FOLDER_HELD_CODE,
  WORKTREE_RETIRE_INCOMPLETE_CODE,
  type WorktreeCarryCheckoutRunningDetails,
  type WorktreeRemovedNotFoundCode,
  type WorktreeRetireConflictCode,
  type WorktreeRetireConflictDetails,
  type WorktreeRetireFolderHeldCode,
  type WorktreeRetireIncompleteCode,
  type WorktreeRetireIncompleteDetails,
} from "@ai-sidekicks/contracts/worktree/lifecycle";

import { DaemonDomainError } from "../../ipc/domain-error.js";

// Each `super()` call pins its literal with `satisfies`. Subclasses do not redeclare `code`: under
// `useDefineForClassFields` that would clobber the base constructor's value, so discriminate by
// `instanceof`, never by narrowing `code`.

/** The `worktree.*` error codes, in registry order. */
type WorktreeErrorCode =
  | "worktree.not_found"
  | WorktreeRemovedNotFoundCode
  | "worktree.create_failed"
  | "worktree.branch_collision"
  | WorktreeRetireConflictCode
  | WorktreeRetireFolderHeldCode
  | WorktreeRetireIncompleteCode;

/**
 * The `workspace.*` codes this module carries; the others have carriers in
 * `../../workspace/errors.js`.
 */
type WorkspaceErrorCode = "workspace.execution_root_unresolved" | "workspace.branch_name_required";

/**
 * Why worktree creation failed; closed and path-free, so it is safe on the wire. The two
 * `branch_name_*` reasons carry git's own line refusing the name; `carry_failed` carries the
 * command that recovers the stashed work; `carry_checkout_running` names the run in the way.
 */
export type WorktreeCreateFailureReason =
  | WorktreeCreateFailureTableReason
  | "branch_name_invalid"
  | "branch_name_taken"
  | "carry_failed";

/** The reasons whose message comes from the table. */
type WorktreeCreateFailureTableReason =
  | "base_ref_option_like"
  | "base_ref_unresolved"
  | "branch_name_underivable"
  | "carry_base_mismatch"
  | "carry_checkout_running"
  | "execution_root_unavailable"
  | "git_invocation_failed"
  | "worktree_folder_taken";

const WORKTREE_CREATE_FAILURE_MESSAGES: Record<WorktreeCreateFailureTableReason, string> = {
  base_ref_option_like:
    "worktree creation failed: the supplied base ref begins with '-' and would be read as a " +
    "git option rather than as a commit-ish",
  base_ref_unresolved:
    "worktree creation failed: no base ref was supplied and the repo mount's HEAD does not " +
    "resolve to a branch",
  branch_name_underivable:
    "worktree creation failed: no branch name could be derived, since neither the session's " +
    "title nor a run id gave a tail",
  carry_base_mismatch:
    "worktree creation refused: uncommitted work is carried only onto a tree cut from the branch " +
    "the session is on",
  carry_checkout_running:
    "worktree creation refused: another session's run is live in the checkout the uncommitted " +
    "work would be carried from, and stashing it would take the work from under that run",
  execution_root_unavailable:
    "worktree creation failed: the daemon's worktrees folder could not be prepared",
  git_invocation_failed: "worktree creation failed: the git worktree invocation did not complete",
  worktree_folder_taken:
    "worktree creation failed: the folder the worktree would be made in already exists",
};

/** `worktree.not_found`: the worktree id did not resolve. */
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
 * `worktree.removed_not_found`: no kept copy has the id, such as one a put-back or deletion queued
 * before it already removed.
 */
export class RemovedWorktreeNotFoundError extends DaemonDomainError {
  readonly removedWorktreeId: string;

  constructor(removedWorktreeId: string) {
    super(`kept worktree ${removedWorktreeId} does not exist`, {
      code: WORKTREE_REMOVED_NOT_FOUND_CODE,
      jsonRpcCode: JsonRpcErrorCode.InvalidParams,
      detail: { removedWorktreeId },
    });
    this.removedWorktreeId = removedWorktreeId;
  }
}

/**
 * `worktree.create_failed`; the workspace goes `stale` via `failRootPreparation`. The message is
 * the closed reason's, except the reasons that carry a line of their own: git's `fatal:` line
 * refusing the name as git printed it, with none of its `hint:` lines, or the carry's recovery
 * command. `carry_checkout_running` carries the running session and agent in its detail. A
 * `cause` (git's rejection, which can name a path) stays on the error for local logs and never
 * reaches the wire.
 */
export class WorktreeCreateFailedError extends DaemonDomainError {
  readonly reason: WorktreeCreateFailureReason;

  constructor(
    reason: "branch_name_invalid" | "branch_name_taken" | "carry_failed",
    message: string,
    cause: unknown,
  );
  constructor(
    reason: "carry_checkout_running",
    running: Omit<WorktreeCarryCheckoutRunningDetails, "reason">,
  );
  constructor(
    reason: Exclude<WorktreeCreateFailureTableReason, "carry_checkout_running">,
    cause?: unknown,
  );
  constructor(reason: WorktreeCreateFailureReason, second?: unknown, lineCause?: unknown) {
    const carriesLine =
      reason === "branch_name_invalid" ||
      reason === "branch_name_taken" ||
      reason === "carry_failed";
    const isCarryRunning = reason === "carry_checkout_running";
    const detail: Record<string, unknown> = isCarryRunning
      ? { reason, ...(second as Omit<WorktreeCarryCheckoutRunningDetails, "reason">) }
      : { reason };
    super(carriesLine ? String(second) : WORKTREE_CREATE_FAILURE_MESSAGES[reason], {
      code: "worktree.create_failed" satisfies WorktreeErrorCode,
      detail,
    });
    this.reason = reason;
    const cause: unknown = carriesLine ? lineCause : isCarryRunning ? undefined : second;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/**
 * `worktree.branch_collision`: a caller-supplied branch name collides with a live checkout the
 * daemon made on the same mount. Raised only on the `onCollision: 'refuse'` arm; `suffix` never
 * does.
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
 * `worktree.retire_conflict`: a removal refused because an agent runs in the tree (naming the
 * session it runs in), or because a plain removal would lose what the tree now holds (carrying the
 * current risks, so the confirm redraws them).
 */
export class WorktreeRetireConflictError extends DaemonDomainError {
  readonly details: WorktreeRetireConflictDetails;

  constructor(details: WorktreeRetireConflictDetails) {
    super(
      details.reason === "root_busy"
        ? `worktree ${details.worktreeId} cannot be removed: session ${details.runningSessionId} ` +
            "is running in it"
        : `worktree ${details.worktreeId} cannot be removed without discarding: it holds ` +
            "uncommitted, ignored or unpushed work",
      { code: WORKTREE_RETIRE_CONFLICT_CODE, detail: { ...details } },
    );
    this.details = details;
  }
}

/**
 * `worktree.retire_folder_held`: a discard refused because the system would not move the tree
 * aside while a program outside the app holds a file in it open. Nothing was removed.
 */
export class WorktreeRetireFolderHeldError extends DaemonDomainError {
  readonly worktreeId: string;

  constructor(worktreeId: string, cause: unknown) {
    super(`worktree ${worktreeId} cannot be moved aside: a program outside the app holds a file`, {
      code: WORKTREE_RETIRE_FOLDER_HELD_CODE,
      detail: { worktreeId },
    });
    this.worktreeId = worktreeId;
    this.cause = cause;
  }
}

/**
 * `worktree.retire_incomplete`: a discard whose move across volumes copied the tree whole to its
 * kept place but could not remove the original completely. The kept copy is listed and the tree
 * stays live; `cause` holds the removal's failure, which can name a path, for local logs only.
 */
export class WorktreeRetireIncompleteError extends DaemonDomainError {
  readonly details: WorktreeRetireIncompleteDetails;

  constructor(details: WorktreeRetireIncompleteDetails, cause: unknown) {
    super(
      `worktree ${details.worktreeId} was copied to kept copy ${details.removedWorktreeId}, but ` +
        "its original folder could not be removed completely",
      { code: WORKTREE_RETIRE_INCOMPLETE_CODE, detail: { ...details } },
    );
    this.details = details;
    this.cause = cause;
  }
}

/**
 * `workspace.execution_root_unresolved`: root preparation failed at the setup gate, which ends
 * the run `failed` with this error as its cause. Carries the cause's dotted code in its detail and
 * the cause itself on `cause`, whose message never reaches the wire.
 */
export class WorkspaceExecutionRootUnresolvedError extends DaemonDomainError {
  readonly workspaceId: string;
  /** The wrapped cause's dotted code, or `null` when it carried none. */
  readonly causeCode: string | null;

  constructor(workspaceId: string, cause: unknown) {
    const causeCode = cause instanceof DaemonDomainError ? cause.code : null;
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
    this.cause = cause;
  }
}

/**
 * `workspace.branch_name_required`: a wire `repo.executionRootPrepare` omitted `branchName`; the
 * daemon derives one only on the run-setup gate's path. Raised before any git call.
 */
export class WorkspaceBranchNameRequiredError extends DaemonDomainError {
  readonly workspaceId: string;

  constructor(workspaceId: string) {
    super(
      `execution root prepare refused for workspace ${workspaceId}: a wire prepare must ` +
        "carry a branch name, because the daemon derives one only when a run is set up",
      {
        code: "workspace.branch_name_required" satisfies WorkspaceErrorCode,
        detail: { workspaceId },
      },
    );
    this.workspaceId = workspaceId;
  }
}
