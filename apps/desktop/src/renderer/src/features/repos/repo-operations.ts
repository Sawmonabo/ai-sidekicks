// The repository calls a component is handed, named once so a test hands stubs. The reads take
// an abort signal and the acts do not: a view may go away before a read lands, but an act that
// reached the daemon has happened, and abandoning it would leave the view saying it did not.

import type { ExecutionMode, RepoMountId, WorkspaceId } from "@ai-sidekicks/contracts/repo/repo";
import type {
  ExecutionModeSelectResponse,
  ExecutionRootPrepareRequest,
  ExecutionRootPrepareResponse,
  WorktreeRetireRequest,
  WorktreeRetireResponse,
  WorktreeReuseCheckResponse,
  WorktreeStatusReadResponse,
} from "@ai-sidekicks/contracts/worktree/worktree";
import type {
  RepoAttachRequest,
  RepoAttachResponse,
  RepoMountReadResponse,
} from "@ai-sidekicks/contracts/repo/folders";
import type {
  WorkspaceBindRequest,
  WorkspaceBindResponse,
  WorkspaceExecutionModeCapabilitiesReadResponse,
  WorkspaceListResponse,
} from "@ai-sidekicks/contracts/workspace";

/** The calls the repos, workspaces and execution-root views make. */
export interface RepoOperations {
  /** One mount, with the freshly probed health verdict only this read carries. */
  readonly readMount: (
    repoMountId: RepoMountId,
    signal: AbortSignal,
  ) => Promise<RepoMountReadResponse>;
  /** Every workspace in the session, which is also how the section learns which mounts exist. */
  readonly listWorkspaces: (
    sessionId: string,
    signal: AbortSignal,
  ) => Promise<WorkspaceListResponse>;
  /** Which modes this workspace may take now. */
  readonly readWorkspaceExecutionModes: (
    workspaceId: WorkspaceId,
    signal: AbortSignal,
  ) => Promise<WorkspaceExecutionModeCapabilitiesReadResponse>;
  /** What a workspace on this mount could be bound as. The pre-bind arm of the same read. */
  readonly readMountExecutionModes: (
    repoMountId: RepoMountId,
    signal: AbortSignal,
  ) => Promise<WorkspaceExecutionModeCapabilitiesReadResponse>;
  /** Record one explicit mode switch. Exactly one mutation per switch. */
  readonly selectExecutionMode: (
    workspaceId: WorkspaceId,
    executionMode: ExecutionMode,
  ) => Promise<ExecutionModeSelectResponse>;
  /** The worktrees of the project whose folder this is, in one read. */
  readonly readWorktreeStatus: (
    repoMountId: RepoMountId,
    signal: AbortSignal,
  ) => Promise<WorktreeStatusReadResponse>;
  /** Attach one folder to this machine, by its path or by another device's folder token. */
  readonly attachRepository: (request: RepoAttachRequest) => Promise<RepoAttachResponse>;
  /** Bind a workspace on one mount, in one explicit execution mode. */
  readonly bindWorkspace: (request: WorkspaceBindRequest) => Promise<WorkspaceBindResponse>;
  /** Prepare an execution root now, ahead of any run. */
  readonly prepareExecutionRoot: (
    request: ExecutionRootPrepareRequest,
  ) => Promise<ExecutionRootPrepareResponse>;
  /** Ask whether one branch already has a live checkout on this mount. */
  readonly checkWorktreeReuse: (
    repoMountId: RepoMountId,
    branchName: string,
    signal: AbortSignal,
  ) => Promise<WorktreeReuseCheckResponse>;
  /**
   * Remove one worktree. `discard: false` is the ordinary removal, which removes nothing
   * the confirm did not show; `discard: true` is sent only from the discard confirm.
   */
  readonly retireWorktree: (request: WorktreeRetireRequest) => Promise<WorktreeRetireResponse>;
}
