// The repository calls a component is handed, named once so a test hands stubs. The reads take
// an abort signal and the acts do not: a view may go away before a read lands, but an act that
// reached the daemon has happened, and abandoning it would leave the view saying it did not.

import type { ProjectId } from "@ai-sidekicks/contracts/project";
import type { RepoMountId } from "@ai-sidekicks/contracts/repo/mount";
import type {
  ExecutionRootPrepareRequest,
  ExecutionRootPrepareResponse,
  WorktreeRetireRequest,
  WorktreeRetireResponse,
  WorktreeStatusReadResponse,
} from "@ai-sidekicks/contracts/worktree/lifecycle";
import type {
  RepoAttachRequest,
  RepoAttachResponse,
  RepoMountReadResponse,
} from "@ai-sidekicks/contracts/repo/folders";
import type {
  WorkspaceBindRequest,
  WorkspaceBindResponse,
  WorkspaceListResponse,
} from "@ai-sidekicks/contracts/repo/workspace";

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
  /** Every worktree git lists for one project's repository, in one read. */
  readonly readWorktreeStatus: (
    projectId: ProjectId,
    signal: AbortSignal,
  ) => Promise<WorktreeStatusReadResponse>;
  /** Attach one folder to this machine, by its path. */
  readonly attachRepository: (request: RepoAttachRequest) => Promise<RepoAttachResponse>;
  /** Bind a workspace on one mount, in one explicit execution mode. */
  readonly bindWorkspace: (request: WorkspaceBindRequest) => Promise<WorkspaceBindResponse>;
  /** Prepare an execution root now, ahead of any run. */
  readonly prepareExecutionRoot: (
    request: ExecutionRootPrepareRequest,
  ) => Promise<ExecutionRootPrepareResponse>;
  /**
   * Remove one worktree. `discard: false` is the ordinary removal, which removes nothing
   * the confirm did not show; `discard: true` is sent only from the discard confirm.
   */
  readonly retireWorktree: (request: WorktreeRetireRequest) => Promise<WorktreeRetireResponse>;
}
