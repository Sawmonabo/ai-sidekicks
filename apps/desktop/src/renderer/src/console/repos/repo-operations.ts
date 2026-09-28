// The repository calls a surface in this family is handed, named once.
//
// A surface takes its calls as an argument and reaches for no bridge to make them: the
// mount reader, the mode switch, and the attach, bind, prepare and retire controllers all
// send what they are given, and a test hands them stubs. A call answers the response
// itself; a rejection propagates to whoever made the call.
//
// The reads take an abort signal and the acts deliberately do not. A read is asked by a
// surface that may go away before the answer lands, so the signal lets the call stop. An
// act records something, and one that reached the daemon has happened: abandoning the
// console's half of it would leave a person looking at a surface that says it did not
// occur while the daemon's own transition says it did.

import type {
  ExecutionMode,
  ExecutionModeSelectResponse,
  ExecutionRootPrepareRequest,
  ExecutionRootPrepareResponse,
  RepoAttachResponse,
  RepoMountId,
  RepoMountReadResponse,
  WorkspaceBindRequest,
  WorkspaceBindResponse,
  WorkspaceExecutionModeCapabilitiesReadResponse,
  WorkspaceId,
  WorkspaceListResponse,
  WorktreeId,
  WorktreeRetireResponse,
  WorktreeReuseCheckResponse,
  WorktreeStatusReadResponse,
} from "@ai-sidekicks/contracts";

/** The subsystem name the act controllers give the store, which stamps it on a rejection. */
export const REPO_REFUSAL_ORIGIN = "repos";

/** The calls the repos, workspaces and execution-root surfaces make. */
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
  /** Every execution root this session holds, in one unfiltered read. */
  readonly readWorktreeStatus: (
    sessionId: string,
    signal: AbortSignal,
  ) => Promise<WorktreeStatusReadResponse>;
  /** Attach one local checkout to this session. The path travels verbatim. */
  readonly attachRepository: (request: {
    readonly sessionId: string;
    readonly localPath: string;
  }) => Promise<RepoAttachResponse>;
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
  /** Record one worktree's retirement: recorded, not deleted from disk. */
  readonly retireWorktree: (worktreeId: WorktreeId) => Promise<WorktreeRetireResponse>;
}
