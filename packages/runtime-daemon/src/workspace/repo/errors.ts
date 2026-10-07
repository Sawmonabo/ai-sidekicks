/**
 * Typed carriers for the six `repo.*` error codes, each a `DaemonDomainError` subclass with its
 * code fixed: `code` becomes `data.type` and `detail` becomes `data.fields`.
 *
 * - Only `RepoMountNotFoundError` sets `jsonRpcCode` (`-32602`, as `session.not_found` does); the
 *   others take `-32603` and consumers discriminate on `data.type`.
 * - Messages never echo a path and no class accepts a caller-supplied message. A closed reason
 *   enum (`RepoRootResolutionError`) or no arguments (`TrustEnvelopeViolationError`) makes that
 *   airtight; the two that interpolate an id rely on ids being opaque, with `sanitizeErrorMessage`
 *   and `sanitizeFields` as a backstop.
 */

import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/message";

import { DaemonDomainError } from "../../ipc/domain-error.js";

/**
 * The six canonical `repo.*` dotted identifiers. Subclasses do not redeclare `code` (under
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
  | "not_a_git_repository"
  | "vcs_error"
  // git's toplevel is not verifiably the path's root (closes a config redirecting the toplevel).
  | "root_mismatch";

const ROOT_RESOLUTION_MESSAGES: Record<RepoRootResolutionReason, string> = {
  not_absolute: "canonical repository root resolution failed: the supplied path is not absolute",
  path_not_found: "canonical repository root resolution failed: the supplied path does not exist",
  not_readable: "canonical repository root resolution failed: the supplied path is not readable",
  not_a_git_repository:
    "canonical repository root resolution failed: the supplied path is not a git repository",
  vcs_error:
    "canonical repository root resolution failed: the version-control root query did not complete",
  root_mismatch:
    "canonical repository root resolution failed: the reported root did not contain the " +
    "supplied path, or did not report itself as its own root",
};

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
 * attached mount roots. Argument-free on purpose: the no-path rule is then structural, and adding a
 * parameter later is additive whereas retracting a leaky one is not.
 */
export class TrustEnvelopeViolationError extends DaemonDomainError {
  constructor() {
    super(
      "workspace binding rejected: the resolved execution root is outside the declared local " +
        "trust envelope",
      {
        code: "repo.outside_trust_envelope" satisfies RepoErrorCode,
      },
    );
  }
}

/**
 * `repo.already_attached`: the canonical root is already attached on this node. Carries the
 * conflicting mount's id rather than the root, so the refusal names no path.
 */
export class RepoAlreadyAttachedError extends DaemonDomainError {
  readonly conflictingRepoMountId: string;

  constructor(conflictingRepoMountId: string) {
    super(
      "repo attach refused: the resolved canonical root is already actively attached on this " +
        `node (repo mount ${conflictingRepoMountId})`,
      {
        code: "repo.already_attached" satisfies RepoErrorCode,
        detail: { conflictingRepoMountId },
      },
    );
    this.conflictingRepoMountId = conflictingRepoMountId;
  }
}

/**
 * `repo.detach_conflict`: detach refused while an agent runs in a dependent workspace.
 * `runningSessionId` names the session running there, so the refusal can say who holds the folder.
 */
export class RepoDetachConflictError extends DaemonDomainError {
  readonly runningSessionId: string;

  constructor(runningSessionId: string) {
    super(`repo detach refused: session ${runningSessionId} is running in a dependent workspace`, {
      code: "repo.detach_conflict" satisfies RepoErrorCode,
      detail: { runningSessionId },
    });
    this.runningSessionId = runningSessionId;
  }
}

/**
 * `repo.mount_managed`: the mount is a chat's managed workspace, which only that chat binds and
 * only its purge removes, so another session's bind and any detach are refused.
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
