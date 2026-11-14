// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Binding a session's workspace to a mount, and listing a session's workspaces.

import type { SessionId } from "../session/id.js";
import type { ExecutionMode, RepoMountId, WorkspaceId, WorkspaceState } from "./mount.js";

/**
 * The longest `lastError` a workspace carries: captured git or provisioning output, scrubbed
 * of credentials before it is cut, since a cut secret is a fragment the scrubber misses.
 */
export const WORKSPACE_LAST_ERROR_MAX_LEN = 8192 as const;

/**
 * `workspace.bind`: the session, the attached mount and the mode to bind in. `directory` is
 * relative to the mount root, or an absolute folder naming one of the mount's listed working
 * trees or a folder inside one, and the daemon keeps it inside those trees once symlinks resolve.
 */
export interface WorkspaceBindRequest {
  /**
   * The session; the mount belongs to the machine, so the caller names it.
   */
  sessionId: SessionId;
  /**
   * The mount.
   */
  repoMountId: RepoMountId;
  /**
   * The mode, required so an omitted one never reads as a chosen one.
   */
  executionMode: ExecutionMode;
  /**
   * The folder inside the mount.
   */
  directory?: string;
}
/**
 * The `workspace.bind` result: the new workspace, its bound mode and its state, which may be
 * other than `preparing`.
 */
export interface WorkspaceBindResponse {
  /**
   * The workspace.
   */
  workspaceId: WorkspaceId;
  /**
   * Its mode.
   */
  executionMode: ExecutionMode;
  /**
   * Its state.
   */
  state: WorkspaceState;
}
/**
 * `workspace.list`: a session's workspaces, narrowed to one mount when it is named.
 */
export interface WorkspaceListRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The mount to narrow to.
   */
  repoMountId?: RepoMountId;
}
/**
 * One workspace in a `workspace.list` result.
 */
export interface WorkspaceListEntry {
  /**
   * The workspace, by a bare `id` as a read names its own row.
   */
  id: WorkspaceId;
  /**
   * Its mount.
   */
  repoMountId: RepoMountId;
  /**
   * Its mode.
   */
  executionMode: ExecutionMode;
  /**
   * Its health, which is its lifecycle state.
   */
  state: WorkspaceState;
  /**
   * Its execution root, absent while it is `preparing`.
   */
  fsRoot?: string;
  /**
   * The failure that made it `rootLost`, when one did.
   */
  lastError?: string;
}
/**
 * The `workspace.list` result.
 */
export interface WorkspaceListResponse {
  /**
   * The workspaces.
   */
  workspaces: WorkspaceListEntry[];
}

export {
  validateWorkspaceBindRequest,
  validateWorkspaceBindResponse,
  validateWorkspaceListEntry,
  validateWorkspaceListRequest,
  validateWorkspaceListResponse,
} from "../checks/repo/workspace.js";
