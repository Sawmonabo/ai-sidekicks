//! The `repo.*` method table: every method on mounts, workspaces, projects, clones, git reads and
//! worktrees.

use crate::jsonrpc::streaming::SubscribeAckResponse;
use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::project::{
    ProjectBranchPatternUpdateRequest, ProjectEditResponse, ProjectEnvironmentUpdateRequest,
    ProjectList, ProjectListRequest, ProjectRenameRequest, ProjectSetupUpdateRequest,
    ProjectStateChangeRequest,
};
use crate::repo::clone::{
    RepoCloneAnswerRequest, RepoCloneFolderReadRequest, RepoCloneFolderReadResponse,
    RepoCloneProjectRequest, RepoCloneRequest, RepoCloneResponse, RepoCloneStatus,
};
use crate::repo::folders::{
    RepoAttachRequest, RepoAttachResponse, RepoDetachResponse, RepoFolderListRequest,
    RepoFolderListResponse, RepoMountListRequest, RepoMountListResponse, RepoMountReadResponse,
    RepoMountReattachResponse, RepoMountRequest,
};
use crate::repo::git_reads::{
    RepoBranchListRequest, RepoBranchListResponse, RepoFileReadRequest, RepoFileReadResponse,
    WorkingTreeChange, WorkingTreeSubscribeRequest,
};
use crate::repo::workspace::{
    WorkspaceBindRequest, WorkspaceBindResponse, WorkspaceListRequest, WorkspaceListResponse,
};
use crate::typescript::TypeScriptModule;
use crate::worktree::copy_progress::{WorktreeCopyProgress, WorktreeCopySubscribeRequest};
use crate::worktree::lifecycle::{
    ExecutionRootPrepareRequest, ExecutionRootPrepareResponse, WorktreeRetireRequest,
    WorktreeRetireResponse, WorktreeStatusReadRequest, WorktreeStatusReadResponse,
};
use crate::worktree::removed::{
    RemovedWorktreeListRequest, RemovedWorktreeListResponse, RemovedWorktreeRequest,
    WorktreeRestoreResponse,
};
use crate::worktree::setup::{WorktreeSetupRequest, WorktreeSetupStatus};

methods! {
    /// Every `repo.*` method.
    pub const REPO_METHOD_DESCRIPTORS = [
        /// Attaches a folder as a project's mount.
        RepoAttach = mutation "repo.attach" {
            mutating: true,
            params: RepoAttachRequest,
            result: RepoAttachResponse,
            refusals: [
                RepoAlreadyAttached,
                RepoFolderUnreachable,
                RepoRootResolutionFailed,
            ],
        },
        /// One mount, with its health probed for the read.
        RepoMountRead = query "repo.mountRead" {
            mutating: false,
            params: RepoMountRequest,
            result: RepoMountReadResponse,
            refusals: [RepoNotFound],
        },
        /// Every folder the service can reach.
        RepoMountList = query "repo.mountList" {
            mutating: false,
            params: RepoMountListRequest,
            result: RepoMountListResponse,
            refusals: [],
        },
        /// Detaches a project's mount, deleting the project.
        RepoDetach = mutation "repo.detach" {
            mutating: true,
            params: RepoMountRequest,
            result: RepoDetachResponse,
            refusals: [RepoNotFound, RepoDetachConflict, RepoMountManaged],
        },
        /// Attaches a mismatched mount's folder fresh under the same project.
        RepoMountReattach = mutation "repo.mountReattach" {
            mutating: true,
            params: RepoMountRequest,
            result: RepoMountReattachResponse,
            refusals: [
                RepoNotFound,
                RepoReattachRefused,
                RepoReattachConflict,
                RepoRootResolutionFailed,
                RepoAlreadyAttached,
            ],
        },
        /// Lists the machine's folders for another device to browse.
        RepoFolderList = query "repo.folderList" {
            mutating: false,
            params: RepoFolderListRequest,
            result: RepoFolderListResponse,
            refusals: [],
        },
        /// Binds a session's workspace to a mount.
        RepoWorkspaceBind = mutation "repo.workspaceBind" {
            mutating: true,
            params: WorkspaceBindRequest,
            result: WorkspaceBindResponse,
            refusals: [
                SessionNotFound,
                RepoNotFound,
                RepoMountManaged,
                RepoOutsideTrustEnvelope,
                WorkspaceModeUnsupported,
            ],
        },
        /// A session's workspaces.
        RepoWorkspaceList = query "repo.workspaceList" {
            mutating: false,
            params: WorkspaceListRequest,
            result: WorkspaceListResponse,
            refusals: [],
        },
        /// Every project, sent on subscribe and again on each change.
        RepoProjectList = subscription "repo.projectList" {
            mutating: false,
            params: ProjectListRequest,
            result: SubscribeAckResponse,
            emission: ProjectList,
            refusals: [],
        },
        /// Renames a project.
        RepoProjectRename = mutation "repo.projectRename" {
            mutating: true,
            params: ProjectRenameRequest,
            result: ProjectEditResponse,
            refusals: [],
        },
        /// Moves a project into the archived group.
        RepoProjectArchive = mutation "repo.projectArchive" {
            mutating: true,
            params: ProjectStateChangeRequest,
            result: ProjectEditResponse,
            refusals: [],
        },
        /// Moves a project out of the archived group.
        RepoProjectReactivate = mutation "repo.projectReactivate" {
            mutating: true,
            params: ProjectStateChangeRequest,
            result: ProjectEditResponse,
            refusals: [],
        },
        /// Replaces a project's setup.
        RepoProjectSetupUpdate = mutation "repo.projectSetupUpdate" {
            mutating: true,
            params: ProjectSetupUpdateRequest,
            result: ProjectEditResponse,
            refusals: [],
        },
        /// Replaces a project's environment rows.
        RepoProjectEnvironmentUpdate = mutation "repo.projectEnvironmentUpdate" {
            mutating: true,
            params: ProjectEnvironmentUpdateRequest,
            result: ProjectEditResponse,
            refusals: [DaemonEnvironmentNameRefused],
        },
        /// Sets or clears a project's branch pattern.
        RepoProjectBranchPatternUpdate = mutation "repo.projectBranchPatternUpdate" {
            mutating: true,
            params: ProjectBranchPatternUpdateRequest,
            result: ProjectEditResponse,
            refusals: [DaemonBranchPatternRefused],
        },
        /// Starts a clone into a new or failed project.
        RepoClone = mutation "repo.clone" {
            mutating: true,
            params: RepoCloneRequest,
            result: RepoCloneResponse,
            refusals: [RepoCloneRefused, RepoCloneUnavailable],
        },
        /// Follows a clone's card.
        RepoCloneSubscribe = subscription "repo.cloneSubscribe" {
            mutating: false,
            params: RepoCloneProjectRequest,
            result: SubscribeAckResponse,
            emission: RepoCloneStatus,
            refusals: [RepoCloneUnavailable],
        },
        /// Answers git's question.
        RepoCloneAnswer = mutation "repo.cloneAnswer" {
            mutating: true,
            params: RepoCloneAnswerRequest,
            result: EmptyPayload,
            refusals: [RepoCloneUnavailable],
        },
        /// Cancels a clone.
        RepoCloneCancel = mutation "repo.cloneCancel" {
            mutating: true,
            params: RepoCloneProjectRequest,
            result: EmptyPayload,
            refusals: [RepoCloneUnavailable],
        },
        /// Where a clone goes, and why.
        RepoCloneFolderRead = query "repo.cloneFolderRead" {
            mutating: false,
            params: RepoCloneFolderReadRequest,
            result: RepoCloneFolderReadResponse,
            refusals: [RepoCloneUnavailable],
        },
        /// Pulls a cloned project's large files.
        RepoLargeFilesPull = mutation "repo.largeFilesPull" {
            mutating: true,
            params: RepoCloneProjectRequest,
            result: EmptyPayload,
            refusals: [RepoCloneUnavailable],
        },
        /// The branches both base pickers list.
        RepoBranchList = query "repo.branchList" {
            mutating: false,
            params: RepoBranchListRequest,
            result: RepoBranchListResponse,
            refusals: [RepoNotFound],
        },
        /// A file's lines, or a diff gap's.
        RepoFileRead = query "repo.fileRead" {
            mutating: false,
            params: RepoFileReadRequest,
            result: RepoFileReadResponse,
            refusals: [],
        },
        /// Signals each change of a session's working folder.
        RepoWorkingTreeSubscribe = subscription "repo.workingTreeSubscribe" {
            mutating: false,
            params: WorkingTreeSubscribeRequest,
            result: SubscribeAckResponse,
            emission: WorkingTreeChange,
            refusals: [SessionNotFound],
        },
        /// Makes a workspace's root before a run starts.
        RepoExecutionRootPrepare = mutation "repo.executionRootPrepare" {
            mutating: true,
            params: ExecutionRootPrepareRequest,
            result: ExecutionRootPrepareResponse,
            refusals: [
                WorkspaceNotFound,
                WorkspaceBranchNameRequired,
                WorkspaceStale,
                WorkspacePreparationFailed,
                WorktreeBranchCollision,
                WorktreeCreateFailed,
            ],
        },
        /// Removes a worktree.
        RepoWorktreeRetire = mutation "repo.worktreeRetire" {
            mutating: true,
            params: WorktreeRetireRequest,
            result: WorktreeRetireResponse,
            refusals: [
                WorktreeNotFound,
                WorktreeRetireConflict,
                WorktreeRetireFolderHeld,
                WorktreeRetireIncomplete,
            ],
        },
        /// A project's checkout and standing trees.
        RepoWorktreeStatusRead = query "repo.worktreeStatusRead" {
            mutating: false,
            params: WorktreeStatusReadRequest,
            result: WorktreeStatusReadResponse,
            refusals: [],
        },
        /// Follows a tree's setup card.
        RepoWorktreeSetupSubscribe = subscription "repo.worktreeSetupSubscribe" {
            mutating: false,
            params: WorktreeSetupRequest,
            result: SubscribeAckResponse,
            emission: WorktreeSetupStatus,
            refusals: [WorktreeNotFound],
        },
        /// Runs a tree's failed setup step and the ones after it.
        RepoWorktreeSetupRetry = mutation "repo.worktreeSetupRetry" {
            mutating: true,
            params: WorktreeSetupRequest,
            result: EmptyPayload,
            refusals: [WorktreeNotFound],
        },
        /// Follows the copies under way.
        RepoWorktreeCopySubscribe = subscription "repo.worktreeCopySubscribe" {
            mutating: false,
            params: WorktreeCopySubscribeRequest,
            result: SubscribeAckResponse,
            emission: WorktreeCopyProgress,
            refusals: [],
        },
        /// The kept worktrees.
        RepoRemovedWorktreeList = query "repo.removedWorktreeList" {
            mutating: false,
            params: RemovedWorktreeListRequest,
            result: RemovedWorktreeListResponse,
            refusals: [],
        },
        /// Puts a kept worktree back.
        RepoWorktreeRestore = mutation "repo.worktreeRestore" {
            mutating: true,
            params: RemovedWorktreeRequest,
            result: WorktreeRestoreResponse,
            refusals: [WorktreeRemovedNotFound],
        },
        /// Deletes a kept worktree.
        RepoRemovedWorktreeDelete = mutation "repo.removedWorktreeDelete" {
            mutating: true,
            params: RemovedWorktreeRequest,
            result: EmptyPayload,
            refusals: [WorktreeRemovedNotFound],
        },
    ];
}

/// The TypeScript module of every repo method.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "repo/methods",
    doc: "Every repo method: mounts, workspaces, projects, clones, git reads and worktrees.",
    definitions: &[],
    constants: &[],
    method_tables: &[&REPO_METHOD_DESCRIPTORS],
};
