// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Worktree event payloads beyond the shared lifecycle payload: a worktree created and retired, a session swept back to the repository root, and a session's branch changed.

import type { RepoMountId, WorkspaceId } from "../repo/mount.js";
import type { SessionId } from "../session/id.js";
import type { RemovedWorktreeId, WorktreeId, WorktreeState } from "./lifecycle.js";

/**
 * `worktree.created`'s payload, naming on a put-back the kept copy the tree came from, so no
 * event type of its own is needed.
 */
export interface WorktreeCreatedPayload {
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
  state: WorktreeState;
  /**
   * The envelope's actor, repeated; a system event sends `null` or leaves it out.
   */
  actor?: string | null;
  /**
   * The kept copy a put-back restored.
   */
  restoredFrom?: RemovedWorktreeId;
}
/**
 * `worktree.retired`'s payload, naming the kept copy when the removal was a discard that kept
 * one.
 */
export interface WorktreeRetiredPayload {
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
  state: WorktreeState;
  /**
   * The envelope's actor, repeated; a system event sends `null` or leaves it out.
   */
  actor?: string | null;
  /**
   * The kept copy.
   */
  removedWorktreeId?: RemovedWorktreeId;
}
/**
 * `session.sweptToCheckout`'s payload, appended to each session a removal moved back to the
 * repository root. It records a move, not a state change.
 */
export interface SessionSweptToCheckoutPayload {
  /**
   * The session moved.
   */
  sessionId: SessionId;
  /**
   * The mount.
   */
  repoMountId: RepoMountId;
  /**
   * The removed tree.
   */
  worktreeId: WorktreeId;
  /**
   * Present when the same removal cleared a pending working-folder move that pointed at it.
   */
  pendingMoveCleared?: true;
}
/**
 * `session.branch.changed`'s payload: the branch a session's folder is on changed outside the app,
 * and the daemon wrote it back to the session's record; one is appended to each session standing
 * in that folder.
 */
export interface SessionBranchChangedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The mount.
   */
  repoMountId: RepoMountId;
  /**
   * The tree, `null` for the repository's own checkout.
   */
  worktreeId: WorktreeId | null;
  /**
   * The branch now, `null` while HEAD is detached.
   */
  branch: string | null;
  /**
   * The branch before, `null` while HEAD was detached.
   */
  previousBranch: string | null;
}

export {
  validateSessionBranchChangedPayload,
  validateSessionSweptToCheckoutPayload,
  validateWorktreeCreatedPayload,
  validateWorktreeRetiredPayload,
} from "../checks/worktree/events.js";
