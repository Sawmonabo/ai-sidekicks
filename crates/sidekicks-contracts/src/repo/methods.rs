//! The `repo.*` method table: every method on mounts, workspaces, projects, clones, git reads and
//! worktrees.

use crate::jsonrpc::streaming::SubscribeAckResponse;
use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::project::{
    ProjectBranchPatternUpdateRequest, ProjectEditResponse, ProjectEnvironmentUpdateRequest,
    ProjectList, ProjectRenameRequest, ProjectSetupUpdateRequest, ProjectStateChangeRequest,
};
use crate::repo::clone::{
    RepoCloneAnswerRequest, RepoCloneFolderReadResponse, RepoCloneProjectRequest, RepoCloneRequest,
    RepoCloneResponse, RepoCloneStatus,
};
use crate::repo::folders::{
    RepoAttachRequest, RepoAttachResponse, RepoDetachResponse, RepoFolderListRequest,
    RepoFolderListResponse, RepoMountListResponse, RepoMountReadResponse,
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
        RepoAttach = mutation "repoMount.attach" {
            mutating: true,
            params: RepoAttachRequest,
            result: RepoAttachResponse,
            refusals: [
                RepoAlreadyAttached,
                RepoDistributionNeedsWsl2,
                RepoDistributionNotFound,
                RepoRootResolutionFailed,
            ],
        },
        /// One mount, with its health probed for the read.
        RepoMountRead = query "repoMount.read" {
            mutating: false,
            params: RepoMountRequest,
            result: RepoMountReadResponse,
            refusals: [RepoNotFound],
        },
        /// Every folder the service can reach.
        RepoMountList = query "repoMount.list" {
            mutating: false,
            params: EmptyPayload,
            result: RepoMountListResponse,
            refusals: [],
        },
        /// Detaches a project's mount, deleting the project.
        RepoDetach = mutation "repoMount.detach" {
            mutating: true,
            params: RepoMountRequest,
            result: RepoDetachResponse,
            refusals: [RepoNotFound, RepoDetachConflict, RepoMountManaged],
        },
        /// Attaches a mismatched mount's folder fresh under the same project.
        RepoMountReattach = mutation "repoMount.reattach" {
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
        RepoFolderList = query "machine.folder.list" {
            mutating: false,
            params: RepoFolderListRequest,
            result: RepoFolderListResponse,
            refusals: [
                RepoDistributionNeedsWsl2,
                RepoDistributionNotFound,
                RepoTopLevelUnavailable,
            ],
        },
        /// Binds a session's workspace to a mount.
        RepoWorkspaceBind = mutation "workspace.bind" {
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
        RepoWorkspaceList = query "workspace.list" {
            mutating: false,
            params: WorkspaceListRequest,
            result: WorkspaceListResponse,
            refusals: [SessionNotFound],
        },
        /// Every project, sent on subscribe and again on each change.
        RepoProjectList = subscription "project.subscribe" {
            mutating: false,
            params: EmptyPayload,
            result: SubscribeAckResponse,
            emission: ProjectList,
            refusals: [],
        },
        /// Renames a project.
        RepoProjectRename = mutation "project.rename" {
            mutating: true,
            params: ProjectRenameRequest,
            result: ProjectEditResponse,
            refusals: [],
        },
        /// Moves a project into the archived group.
        RepoProjectArchive = mutation "project.archive" {
            mutating: true,
            params: ProjectStateChangeRequest,
            result: ProjectEditResponse,
            refusals: [],
        },
        /// Moves a project out of the archived group.
        RepoProjectReactivate = mutation "project.reactivate" {
            mutating: true,
            params: ProjectStateChangeRequest,
            result: ProjectEditResponse,
            refusals: [],
        },
        /// Replaces a project's setup.
        RepoProjectSetupUpdate = mutation "project.setup.update" {
            mutating: true,
            params: ProjectSetupUpdateRequest,
            result: ProjectEditResponse,
            refusals: [],
        },
        /// Replaces a project's environment rows.
        RepoProjectEnvironmentUpdate = mutation "project.environment.update" {
            mutating: true,
            params: ProjectEnvironmentUpdateRequest,
            result: ProjectEditResponse,
            refusals: [DaemonEnvironmentNameRefused],
        },
        /// Sets or clears a project's branch pattern.
        RepoProjectBranchPatternUpdate = mutation "project.branchPattern.update" {
            mutating: true,
            params: ProjectBranchPatternUpdateRequest,
            result: ProjectEditResponse,
            refusals: [DaemonBranchPatternRefused],
        },
        /// Starts a clone into a new or failed project.
        RepoClone = mutation "project.clone.start" {
            mutating: true,
            params: RepoCloneRequest,
            result: RepoCloneResponse,
            refusals: [
                RepoCloneRefused,
                RepoCloneUnavailable,
                RepoDistributionNeedsWsl2,
                RepoDistributionNotFound,
            ],
        },
        /// Follows a clone's card.
        RepoCloneSubscribe = subscription "project.clone.subscribe" {
            mutating: false,
            params: RepoCloneProjectRequest,
            result: SubscribeAckResponse,
            emission: RepoCloneStatus,
            refusals: [RepoCloneUnavailable],
        },
        /// Answers git's question.
        RepoCloneAnswer = mutation "project.clone.answer" {
            mutating: true,
            params: RepoCloneAnswerRequest,
            result: EmptyPayload,
            refusals: [RepoCloneUnavailable],
        },
        /// Cancels a clone.
        RepoCloneCancel = mutation "project.clone.cancel" {
            mutating: true,
            params: RepoCloneProjectRequest,
            result: EmptyPayload,
            refusals: [RepoCloneUnavailable],
        },
        /// Where a clone goes, and why.
        RepoCloneFolderRead = query "project.clone.folder.read" {
            mutating: false,
            params: EmptyPayload,
            result: RepoCloneFolderReadResponse,
            refusals: [RepoCloneUnavailable],
        },
        /// Pulls a cloned project's large files.
        RepoLargeFilesPull = mutation "project.largeFile.pull" {
            mutating: true,
            params: RepoCloneProjectRequest,
            result: EmptyPayload,
            refusals: [RepoCloneUnavailable],
        },
        /// The branches both base pickers list.
        RepoBranchList = query "project.branch.list" {
            mutating: false,
            params: RepoBranchListRequest,
            result: RepoBranchListResponse,
            refusals: [RepoNotFound],
        },
        /// A file's lines, or a diff gap's.
        RepoFileRead = query "project.file.read" {
            mutating: false,
            params: RepoFileReadRequest,
            result: RepoFileReadResponse,
            refusals: [SessionNotFound],
        },
        /// Signals each change of a session's working folder.
        RepoWorkingTreeSubscribe = subscription "session.workingFolder.subscribe" {
            mutating: false,
            params: WorkingTreeSubscribeRequest,
            result: SubscribeAckResponse,
            emission: WorkingTreeChange,
            refusals: [SessionNotFound],
        },
        /// Makes a workspace's root before a run starts.
        RepoExecutionRootPrepare = mutation "workspace.executionRoot.prepare" {
            mutating: true,
            params: ExecutionRootPrepareRequest,
            result: ExecutionRootPrepareResponse,
            refusals: [
                WorkspaceNotFound,
                WorkspaceBranchNameRequired,
                WorkspaceRootUnavailable,
                WorkspacePreparationFailed,
                WorktreeBranchCollision,
                WorktreeCreateFailed,
            ],
        },
        /// Removes a worktree.
        RepoWorktreeRetire = mutation "worktree.retire" {
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
        RepoWorktreeStatusRead = query "worktree.status.read" {
            mutating: false,
            params: WorktreeStatusReadRequest,
            result: WorktreeStatusReadResponse,
            refusals: [SessionNotFound],
        },
        /// Follows a tree's setup card.
        RepoWorktreeSetupSubscribe = subscription "worktree.setup.subscribe" {
            mutating: false,
            params: WorktreeSetupRequest,
            result: SubscribeAckResponse,
            emission: WorktreeSetupStatus,
            refusals: [WorktreeNotFound],
        },
        /// Runs a tree's failed setup step and the ones after it.
        RepoWorktreeSetupRetry = mutation "worktree.setup.retry" {
            mutating: true,
            params: WorktreeSetupRequest,
            result: EmptyPayload,
            refusals: [WorktreeNotFound],
        },
        /// Follows the copies under way.
        RepoWorktreeCopySubscribe = subscription "worktree.copy.subscribe" {
            mutating: false,
            params: WorktreeCopySubscribeRequest,
            result: SubscribeAckResponse,
            emission: WorktreeCopyProgress,
            refusals: [],
        },
        /// The kept worktrees.
        RepoRemovedWorktreeList = query "worktree.removed.list" {
            mutating: false,
            params: RemovedWorktreeListRequest,
            result: RemovedWorktreeListResponse,
            refusals: [],
        },
        /// Puts a kept worktree back.
        RepoWorktreeRestore = mutation "worktree.restore" {
            mutating: true,
            params: RemovedWorktreeRequest,
            result: WorktreeRestoreResponse,
            refusals: [WorktreeRemovedNotFound],
        },
        /// Deletes a kept worktree.
        RepoRemovedWorktreeDelete = mutation "worktree.removed.delete" {
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
