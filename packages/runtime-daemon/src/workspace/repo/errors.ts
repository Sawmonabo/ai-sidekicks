/**
 * Typed carriers for the `repo.*` error codes, each a `DaemonDomainError` subclass with its code
 * fixed: `code` becomes `data.type` and `detail` becomes `data.fields`.
 *
 * - Only the two `repo.not_found` carriers, a mount's and a project's, set `jsonRpcCode` (`-32602`,
 *   as `session.not_found` does); the others take `-32603` and consumers discriminate on
 *   `data.type`.
 * - Two messages are text the daemon did not write: `RepoCloneRefusedError`'s git line and
 *   `RepoCloneUnavailableError`'s failed start, whose paths `sanitizeErrorMessage` strips on the
 *   wire. Every other message never echoes a path and no other class accepts a caller-supplied
 *   message. A closed reason (`RepoRootResolutionError`, `TrustEnvelopeViolationError`) makes that
 *   airtight; the ones that interpolate an id rely on ids being opaque, with
 *   `sanitizeErrorMessage` and `sanitizeFields` as a backstop.
 */

import type { AgentId } from "@ai-sidekicks/contracts/agent/definition";
import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/error-code";
import type { ProjectId } from "@ai-sidekicks/contracts/project";
import {
  REPO_CLONE_REFUSED_CODE,
  REPO_CLONE_UNAVAILABLE_CODE,
  type RepoCloneRefusedDetails,
} from "@ai-sidekicks/contracts/repo/clone";
import {
  REPO_FOLDER_UNREACHABLE_CODE,
  REPO_REATTACH_CONFLICT_CODE,
  REPO_REATTACH_REFUSED_CODE,
  type RepoAlreadyAttachedDetails,
  type RepoOutsideTrustEnvelopeDetails,
  type RepoOutsideTrustEnvelopeReason,
  type RepoReattachConflictDetails,
  type RepoReattachRefusedDetails,
} from "@ai-sidekicks/contracts/repo/folders";
import type { RepoMountId } from "@ai-sidekicks/contracts/repo/mount";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { DaemonDomainError } from "../../ipc/domain-error.js";

/**
 * The `repo.*` dotted identifiers this module raises besides the re-attach codes, which come from
 * the contracts. Subclasses do not redeclare `code` (under
 * `useDefineForClassFields` that would clobber the base value), so discriminate by `instanceof`.
 */
type RepoErrorCode =
  | "repo.not_found"
  | "repo.root_resolution_failed"
  | "repo.outside_trust_envelope"
  | "repo.already_attached"
  | "repo.detach_conflict"
  | "repo.mount_managed";

/** Why canonical-root resolution failed; closed and non-path-bearing, so safe on the wire. */
export type RepoRootResolutionReason =
  // Relative, `~`, or a driveless Windows root like `\repos\foo` (which `win32.isAbsolute`
  // accepts).
  | "not_absolute"
  | "path_not_found"
  | "not_readable"
  // Only on git's positive verdict; a missing git or a damaged checkout is `vcs_error`.
  | "not_a_repository"
  | "vcs_error"
  // The path's working tree is neither the repository's main checkout nor one git lists for it
  // (a planted `.git` pointer, a redirected toplevel), or the repository is no longer the one
  // attached there.
  | "root_mismatch";

const ROOT_RESOLUTION_MESSAGES: Record<RepoRootResolutionReason, string> = {
  not_absolute: "canonical repository root resolution failed: the supplied path is not absolute",
  path_not_found: "canonical repository root resolution failed: the supplied path does not exist",
  not_readable: "canonical repository root resolution failed: the supplied path is not readable",
  not_a_repository:
    "canonical repository root resolution failed: the supplied path is not a git repository",
  vcs_error:
    "canonical repository root resolution failed: the version-control root query did not complete",
  root_mismatch:
    "canonical repository root resolution failed: the path's working tree is not one git names " +
    "for its repository, or the repository is not the one attached there",
};

/**
 * `repo.not_found` naming a project: the project record does not exist, or was forgotten. Rides
 * `-32602` as a mount's `repo.not_found` does.
 */
export class ProjectNotFoundError extends DaemonDomainError {
  readonly projectId: string;

  constructor(projectId: ProjectId) {
    super(`project ${projectId} does not exist`, {
      code: "repo.not_found" satisfies RepoErrorCode,
      jsonRpcCode: JsonRpcErrorCode.InvalidParams,
      detail: { projectId },
    });
    this.projectId = projectId;
  }
}

/** `repo.not_found`: the repo mount does not exist. */
export class RepoMountNotFoundError extends DaemonDomainError {
  readonly repoMountId: string;

  constructor(repoMountId: string) {
    super(`repo mount ${repoMountId} does not exist`, {
      code: "repo.not_found" satisfies RepoErrorCode,
      // An unresolved id is a param-shape failure, as with `session.not_found`.
      jsonRpcCode: JsonRpcErrorCode.InvalidParams,
      detail: { repoMountId },
    });
    this.repoMountId = repoMountId;
  }
}

/**
 * `repo.root_resolution_failed`. Takes only the closed `reason`, so the attempted path never enters
 * the carrier.
 */
export class RepoRootResolutionError extends DaemonDomainError {
  readonly reason: RepoRootResolutionReason;

  constructor(reason: RepoRootResolutionReason) {
    super(ROOT_RESOLUTION_MESSAGES[reason], {
      code: "repo.root_resolution_failed" satisfies RepoErrorCode,
      detail: { reason },
    });
    this.reason = reason;
  }
}

/**
 * `repo.outside_trust_envelope`: a path or workspace binding resolves outside the machine's
 * attached mount roots, reason `outside_project`, or names a tree whose removal is committed while
 * its folder waits for deletion, reason `worktree_removed`. It takes only the closed reason, so
 * the no-path rule is structural.
 */
export class TrustEnvelopeViolationError extends DaemonDomainError {
  constructor(reason: RepoOutsideTrustEnvelopeReason = "outside_project") {
    const detail: RepoOutsideTrustEnvelopeDetails = { reason };
    super(
      "workspace binding rejected: the resolved execution root is outside the declared local " +
        "trust envelope",
      {
        code: "repo.outside_trust_envelope" satisfies RepoErrorCode,
        detail: { ...detail },
      },
    );
  }
}

/**
 * `repo.already_attached`: the folder's repository is already attached on this node, by its
 * canonical root or by its git common directory. Carries the conflicting mount's id and its
 * project's (`null` for a chat's managed workspace) rather than the root, so the refusal names no
 * path.
 */
export class RepoAlreadyAttachedError extends DaemonDomainError {
  readonly conflictingRepoMountId: RepoMountId;
  readonly conflictingProjectId: ProjectId | null;

  constructor(conflictingRepoMountId: RepoMountId, conflictingProjectId: ProjectId | null) {
    const detail: RepoAlreadyAttachedDetails = { conflictingRepoMountId, conflictingProjectId };
    super(
      "repo attach refused: the folder's repository is already attached on this node as repo " +
        `mount ${conflictingRepoMountId}; bind a workspace on that mount to work in this folder`,
      {
        code: "repo.already_attached" satisfies RepoErrorCode,
        detail: { ...detail },
      },
    );
    this.conflictingRepoMountId = conflictingRepoMountId;
    this.conflictingProjectId = conflictingProjectId;
  }
}

/**
 * `repo.detach_conflict`: detach refused while an agent runs anywhere in the project.
 * `runningSessionId` names the session running there, so the refusal can say who holds the folder.
 */
export class RepoDetachConflictError extends DaemonDomainError {
  readonly runningSessionId: string;

  constructor(runningSessionId: string) {
    super(`repo detach refused: session ${runningSessionId} is running in the project`, {
      code: "repo.detach_conflict" satisfies RepoErrorCode,
      detail: { runningSessionId },
    });
    this.runningSessionId = runningSessionId;
  }
}

/**
 * `repo.mount_managed`: the mount is a chat's managed workspace, which only that chat binds and
 * only its purge removes, so another session's bind, any detach and a move of the chat to another
 * folder are refused.
 */
export class RepoMountManagedError extends DaemonDomainError {
  readonly repoMountId: string;

  constructor(repoMountId: string) {
    super(`repo mount ${repoMountId} is a chat's managed workspace`, {
      code: "repo.mount_managed" satisfies RepoErrorCode,
      detail: { repoMountId },
    });
    this.repoMountId = repoMountId;
  }
}

/**
 * `repo.reattach_refused`: the mount does not read `identity_mismatch`, so there is nothing for a
 * re-attach to recover.
 */
export class RepoReattachRefusedError extends DaemonDomainError {
  constructor(repoMountId: string) {
    const detail: RepoReattachRefusedDetails = { reason: "identity_matches" };
    super(`repo mount ${repoMountId} still holds the repository attached there`, {
      code: REPO_REATTACH_REFUSED_CODE,
      detail: { ...detail },
    });
  }
}

/**
 * `repo.reattach_conflict`: re-attach refused while an agent runs anywhere in the project, naming
 * the running agent and its session.
 */
export class RepoReattachConflictError extends DaemonDomainError {
  readonly runningSessionId: SessionId;
  readonly runningAgentId: AgentId;

  constructor(runningSessionId: SessionId, runningAgentId: AgentId) {
    const detail: RepoReattachConflictDetails = { runningSessionId, runningAgentId };
    super(
      `repo re-attach refused: agent ${runningAgentId} is running in session ${runningSessionId}`,
      { code: REPO_REATTACH_CONFLICT_CODE, detail: { ...detail } },
    );
    this.runningSessionId = runningSessionId;
    this.runningAgentId = runningAgentId;
  }
}

/**
 * `repo.folder_unreachable`: the folder lies inside another WSL distribution than the one the
 * service runs in. Argument-free, so the refusal names no path.
 */
export class RepoFolderUnreachableError extends DaemonDomainError {
  constructor() {
    super("the background service cannot reach this folder", {
      code: REPO_FOLDER_UNREACHABLE_CODE,
    });
  }
}

/**
 * `repo.clone_refused`, refused before git starts and before anything is written: reason
 * `destination_not_empty` when the clone's destination exists and is not empty, and
 * `no_directory_name`, with git's own line, when the address leaves no folder name.
 */
export class RepoCloneRefusedError extends DaemonDomainError {
  constructor(detail: RepoCloneRefusedDetails) {
    // Git's own line where there is one; neither message names a path.
    const message =
      detail.reason === "no_directory_name"
        ? detail.line
        : "the clone's destination is already there and is not empty";
    super(message, {
      code: REPO_CLONE_REFUSED_CODE,
      detail: { ...detail },
    });
  }
}

/**
 * `repo.clone_unavailable`: the clone service is not running, so no clone verb can run. Carries
 * no detail; `message` is a failed start's own text, or empty when the service was never started.
 */
export class RepoCloneUnavailableError extends DaemonDomainError {
  constructor(message: string) {
    super(message, { code: REPO_CLONE_UNAVAILABLE_CODE });
  }
}
