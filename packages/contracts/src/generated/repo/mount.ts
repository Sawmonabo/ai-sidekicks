// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A repository mount's ids and states, its probed health and the payload of a health change, and the payload every `workspace.*` and `worktree.*` lifecycle event carries.

import type { WireInstant } from "../internal/wire-scalars.js";
import type { SessionId } from "../session/id.js";

/**
 * The daemon-minted id of one repository mount.
 */
export type RepoMountId = string & { readonly __brand: "RepoMountId" };
/**
 * The daemon-minted id of one workspace.
 */
export type WorkspaceId = string & { readonly __brand: "WorkspaceId" };
/**
 * How a workspace uses its mount: `boundRoot` works in the root already bound to it (the mount's
 * own checkout), `provisionedWorktree` in a worktree the daemon provisions for it.
 */
export type ExecutionMode = "boundRoot" | "provisionedWorktree";
/**
 * A workspace's lifecycle state. `rootLost` means its working root became unavailable and write
 * runs are blocked until repair.
 */
export type WorkspaceState = "preparing" | "ready" | "rootLost" | "archived";
/**
 * A mount's lifecycle state. `detached` is terminal: re-attaching creates a new mount rather than
 * reviving the old one.
 */
export type RepoMountState = "attached" | "detached" | "archived";
/**
 * The version-control system behind a mount. `repoMount.attach` refuses a path that is not a git
 * repository, so every mount is `git`.
 */
export type VcsType = "git";
/**
 * A mount's health, probed on every read and never stored. `unreachable` means the root cannot be
 * probed and outranks the rest; `identityMismatch` means the root's git common directory is not
 * the one recorded at attach, and `isRepository` says whether git still answers for the root,
 * which decides whether re-attaching can recover it.
 */
export type RepoMountHealth =
  | {
      status: "healthy";
      /**
       * When it was probed.
       */
      checkedAt: WireInstant;
      /**
       * Only a mismatch says whether git still answers.
       */
      isRepository?: never;
    }
  | {
      status: "unreachable";
      /**
       * When it was probed.
       */
      checkedAt: WireInstant;
      /**
       * Only a mismatch says whether git still answers.
       */
      isRepository?: never;
    }
  | {
      status: "identityMismatch";
      /**
       * Whether git still answers for the root.
       */
      isRepository: boolean;
      /**
       * When it was probed.
       */
      checkedAt: WireInstant;
    };

/**
 * The `repoMount.health.changed` payload: a mount's health after the daemon's re-probe changed
 * it, sent on the stream of every session on that mount.
 */
export interface RepoMountHealthChangedPayload {
  /**
   * The mount.
   */
  repoMountId: RepoMountId;
  /**
   * Its health now.
   */
  health: RepoMountHealth;
}
/**
 * The payload of a `workspace.*` lifecycle event.
 */
export interface WorkspaceLifecyclePayload {
  /**
   * The envelope's session, repeated so a projector can read the payload alone.
   */
  sessionId: SessionId;
  /**
   * The mount, when it is the subject or beside it.
   */
  repoMountId?: RepoMountId;
  /**
   * The workspace, when it is the subject or beside it.
   */
  workspaceId?: WorkspaceId;
  /**
   * The worktree, when it is the subject.
   */
  worktreeId?: string;
  /**
   * The subject's state after the transition.
   */
  state: WorkspaceState;
  /**
   * The envelope's actor, repeated; a system event sends `null` or leaves it out.
   */
  actor?: string | null;
}

export {
  validateExecutionMode,
  validateRepoMountHealth,
  validateRepoMountHealthChangedPayload,
  validateRepoMountId,
  validateRepoMountState,
  validateVcsType,
  validateWorkspaceId,
  validateWorkspaceLifecyclePayload,
  validateWorkspaceState,
} from "../checks/repo/mount.js";
