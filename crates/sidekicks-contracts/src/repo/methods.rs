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
    ProjectCloneAnswerRequest, ProjectCloneFolderReadResponse, ProjectCloneStartRequest,
    ProjectCloneStartResponse, RepoCloneProjectRequest, RepoCloneStatus,
};
use crate::repo::folders::{
    MachineFolderListRequest, MachineFolderListResponse, RepoMountAttachRequest,
    RepoMountAttachResponse, RepoMountDetachResponse, RepoMountListResponse, RepoMountReadResponse,
    RepoMountReattachResponse, RepoMountRequest,
};
use crate::repo::git_reads::{
    ProjectBranchListRequest, ProjectBranchListResponse, ProjectFileReadRequest,
    ProjectFileReadResponse, WorkingTreeChange, WorkingTreeSubscribeRequest,
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
        RepoMountAttach = mutation "repoMount.attach" {
            mutating: true,
            params: RepoMountAttachRequest,
            result: RepoMountAttachResponse,
            refusals: [
                RepoMountAlreadyAttached,
                RepoMountDistributionNeedsWsl2,
                RepoMountDistributionNotFound,
                RepoMountRootResolutionFailed,
            ],
        },
        /// One mount, with its health probed for the read.
        RepoMountRead = query "repoMount.read" {
            mutating: false,
            params: RepoMountRequest,
            result: RepoMountReadResponse,
            refusals: [RepoMountNotFound],
        },
        /// Every folder the service can reach.
        RepoMountList = query "repoMount.list" {
            mutating: false,
            params: EmptyPayload,
            result: RepoMountListResponse,
            refusals: [],
        },
        /// Detaches a project's mount, deleting the project.
        RepoMountDetach = mutation "repoMount.detach" {
            mutating: true,
            params: RepoMountRequest,
            result: RepoMountDetachResponse,
            refusals: [RepoMountNotFound, RepoMountDetachConflict, RepoMountManaged],
        },
        /// Attaches a mismatched mount's folder fresh under the same project.
        RepoMountReattach = mutation "repoMount.reattach" {
            mutating: true,
            params: RepoMountRequest,
            result: RepoMountReattachResponse,
            refusals: [
                RepoMountNotFound,
                RepoMountReattachRefused,
                RepoMountReattachConflict,
                RepoMountRootResolutionFailed,
                RepoMountAlreadyAttached,
            ],
        },
        /// Lists the machine's folders for another device to browse.
        MachineFolderList = query "machine.folder.list" {
            mutating: false,
            params: MachineFolderListRequest,
            result: MachineFolderListResponse,
            refusals: [
                RepoMountDistributionNeedsWsl2,
                RepoMountDistributionNotFound,
                MachineFolderTopLevelNotOffered,
            ],
        },
        /// Binds a session's workspace to a mount.
        WorkspaceBind = mutation "workspace.bind" {
            mutating: true,
            params: WorkspaceBindRequest,
            result: WorkspaceBindResponse,
            refusals: [
                SessionNotFound,
                RepoMountNotFound,
                RepoMountManaged,
                RepoMountOutsideTrustEnvelope,
                WorkspaceModeUnsupported,
            ],
        },
        /// A session's workspaces.
        WorkspaceList = query "workspace.list" {
            mutating: false,
            params: WorkspaceListRequest,
            result: WorkspaceListResponse,
            refusals: [SessionNotFound],
        },
        /// Every project, sent on subscribe and again on each change.
        ProjectSubscribe = subscription "project.subscribe" {
            mutating: false,
            params: EmptyPayload,
            result: SubscribeAckResponse,
            emission: ProjectList,
            refusals: [],
        },
        /// Renames a project.
        ProjectRename = mutation "project.rename" {
            mutating: true,
            params: ProjectRenameRequest,
            result: ProjectEditResponse,
            refusals: [],
        },
        /// Moves a project into the archived group.
        ProjectArchive = mutation "project.archive" {
            mutating: true,
            params: ProjectStateChangeRequest,
            result: ProjectEditResponse,
            refusals: [],
        },
        /// Moves a project out of the archived group.
        ProjectReactivate = mutation "project.reactivate" {
            mutating: true,
            params: ProjectStateChangeRequest,
            result: ProjectEditResponse,
            refusals: [],
        },
        /// Replaces a project's setup.
        ProjectSetupUpdate = mutation "project.setup.update" {
            mutating: true,
            params: ProjectSetupUpdateRequest,
            result: ProjectEditResponse,
            refusals: [],
        },
        /// Replaces a project's environment rows.
        ProjectEnvironmentUpdate = mutation "project.environment.update" {
            mutating: true,
            params: ProjectEnvironmentUpdateRequest,
            result: ProjectEditResponse,
            refusals: [ProjectEnvironmentNameRefused],
        },
        /// Sets or clears a project's branch pattern.
        ProjectBranchPatternUpdate = mutation "project.branchPattern.update" {
            mutating: true,
            params: ProjectBranchPatternUpdateRequest,
            result: ProjectEditResponse,
            refusals: [ProjectBranchPatternRefused],
        },
        /// Starts a clone into a new or failed project.
        ProjectCloneStart = mutation "project.clone.start" {
            mutating: true,
            params: ProjectCloneStartRequest,
            result: ProjectCloneStartResponse,
            refusals: [
                ProjectCloneRefused,
                ProjectCloneUnavailable,
                RepoMountDistributionNeedsWsl2,
                RepoMountDistributionNotFound,
            ],
        },
        /// Follows a clone's card.
        ProjectCloneSubscribe = subscription "project.clone.subscribe" {
            mutating: false,
            params: RepoCloneProjectRequest,
            result: SubscribeAckResponse,
            emission: RepoCloneStatus,
            refusals: [ProjectCloneUnavailable],
        },
        /// Answers git's question.
        ProjectCloneAnswer = mutation "project.clone.answer" {
            mutating: true,
            params: ProjectCloneAnswerRequest,
            result: EmptyPayload,
            refusals: [ProjectCloneUnavailable],
        },
        /// Cancels a clone.
        ProjectCloneCancel = mutation "project.clone.cancel" {
            mutating: true,
            params: RepoCloneProjectRequest,
            result: EmptyPayload,
            refusals: [ProjectCloneUnavailable],
        },
        /// Where a clone goes, and why.
        ProjectCloneFolderRead = query "project.clone.folder.read" {
            mutating: false,
            params: EmptyPayload,
            result: ProjectCloneFolderReadResponse,
            refusals: [ProjectCloneUnavailable],
        },
        /// Pulls a cloned project's large files.
        ProjectLargeFilePull = mutation "project.largeFile.pull" {
            mutating: true,
            params: RepoCloneProjectRequest,
            result: EmptyPayload,
            refusals: [ProjectCloneUnavailable],
        },
        /// The branches both base pickers list.
        ProjectBranchList = query "project.branch.list" {
            mutating: false,
            params: ProjectBranchListRequest,
            result: ProjectBranchListResponse,
            refusals: [RepoMountNotFound],
        },
        /// A file's lines, or a diff gap's.
        ProjectFileRead = query "project.file.read" {
            mutating: false,
            params: ProjectFileReadRequest,
            result: ProjectFileReadResponse,
            refusals: [SessionNotFound],
        },
        /// Signals each change of a session's working folder.
        SessionWorkingFolderSubscribe = subscription "session.workingFolder.subscribe" {
            mutating: false,
            params: WorkingTreeSubscribeRequest,
            result: SubscribeAckResponse,
            emission: WorkingTreeChange,
            refusals: [SessionNotFound],
        },
        /// Makes a workspace's root before a run starts.
        WorkspaceExecutionRootPrepare = mutation "workspace.executionRoot.prepare" {
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
        WorktreeRetire = mutation "worktree.retire" {
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
        WorktreeStatusRead = query "worktree.status.read" {
            mutating: false,
            params: WorktreeStatusReadRequest,
            result: WorktreeStatusReadResponse,
            refusals: [SessionNotFound],
        },
        /// Follows a tree's setup card.
        WorktreeSetupSubscribe = subscription "worktree.setup.subscribe" {
            mutating: false,
            params: WorktreeSetupRequest,
            result: SubscribeAckResponse,
            emission: WorktreeSetupStatus,
            refusals: [WorktreeNotFound],
        },
        /// Runs a tree's failed setup step and the ones after it.
        WorktreeSetupRetry = mutation "worktree.setup.retry" {
            mutating: true,
            params: WorktreeSetupRequest,
            result: EmptyPayload,
            refusals: [WorktreeNotFound],
        },
        /// Follows the copies under way.
        WorktreeCopySubscribe = subscription "worktree.copy.subscribe" {
            mutating: false,
            params: WorktreeCopySubscribeRequest,
            result: SubscribeAckResponse,
            emission: WorktreeCopyProgress,
            refusals: [],
        },
        /// The kept worktrees.
        WorktreeRemovedList = query "worktree.removed.list" {
            mutating: false,
            params: RemovedWorktreeListRequest,
            result: RemovedWorktreeListResponse,
            refusals: [],
        },
        /// Puts a kept worktree back.
        WorktreeRestore = mutation "worktree.restore" {
            mutating: true,
            params: RemovedWorktreeRequest,
            result: WorktreeRestoreResponse,
            refusals: [WorktreeRemovedNotFound],
        },
        /// Deletes a kept worktree.
        WorktreeRemovedDelete = mutation "worktree.removed.delete" {
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
