// The `repo.*` method table: every method's name, procedure type, mutating flag and schemas. It
// imports every `repo.*` contract file and none imports it, so it sees the whole namespace without
// a cycle. It imports nothing from `../event/session-event.js` and nothing whose imports reach it,
// which would close an eager module cycle.
import {
  defineMethodDescriptors,
  type MethodDescriptor,
  type SubscriptionMethodDescriptor,
  EmptyPayloadSchema,
  type EmptyPayload,
} from "../method-descriptor.js";
import {
  ProjectBranchPatternUpdateRequestSchema,
  ProjectEditResponseSchema,
  ProjectListRequestSchema,
  ProjectListResponseSchema,
  ProjectListSchema,
  ProjectRenameRequestSchema,
  ProjectSetupUpdateRequestSchema,
  ProjectEnvironmentUpdateRequestSchema,
  ProjectStateChangeRequestSchema,
  type ProjectBranchPatternUpdateRequest,
  type ProjectEditResponse,
  type ProjectList,
  type ProjectListRequest,
  type ProjectListResponse,
  type ProjectRenameRequest,
  type ProjectSetupUpdateRequest,
  type ProjectEnvironmentUpdateRequest,
  type ProjectStateChangeRequest,
} from "../project.js";
import {
  RemovedWorktreeListRequestSchema,
  RemovedWorktreeListResponseSchema,
  RemovedWorktreeRequestSchema,
  WorktreeRestoreResponseSchema,
  type RemovedWorktreeListRequest,
  type RemovedWorktreeListResponse,
  type RemovedWorktreeRequest,
  type WorktreeRestoreResponse,
} from "../worktree/removed-worktree.js";
import {
  RepoCloneAnswerRequestSchema,
  RepoCloneFolderReadRequestSchema,
  RepoCloneFolderReadResponseSchema,
  RepoCloneProjectRequestSchema,
  RepoCloneRequestSchema,
  RepoCloneResponseSchema,
  RepoCloneStatusSchema,
  RepoCloneSubscribeResponseSchema,
  type RepoCloneAnswerRequest,
  type RepoCloneFolderReadRequest,
  type RepoCloneFolderReadResponse,
  type RepoCloneProjectRequest,
  type RepoCloneRequest,
  type RepoCloneResponse,
  type RepoCloneStatus,
  type RepoCloneSubscribeResponse,
} from "./clone.js";
import {
  RepoAttachRequestSchema,
  RepoAttachResponseSchema,
  RepoDetachRequestSchema,
  RepoDetachResponseSchema,
  RepoFolderListRequestSchema,
  RepoFolderListResponseSchema,
  RepoMountListRequestSchema,
  RepoMountListResponseSchema,
  RepoMountReadRequestSchema,
  RepoMountReadResponseSchema,
  type RepoAttachRequest,
  type RepoAttachResponse,
  type RepoDetachRequest,
  type RepoDetachResponse,
  type RepoFolderListRequest,
  type RepoFolderListResponse,
  type RepoMountListRequest,
  type RepoMountListResponse,
  type RepoMountReadRequest,
  type RepoMountReadResponse,
} from "./folders.js";
import {
  RepoBranchListRequestSchema,
  RepoBranchListResponseSchema,
  RepoFileReadRequestSchema,
  RepoFileReadResponseSchema,
  WorkingTreeChangeSchema,
  WorkingTreeSubscribeRequestSchema,
  WorkingTreeSubscribeResponseSchema,
  type RepoBranchListRequest,
  type RepoBranchListResponse,
  type RepoFileReadRequest,
  type RepoFileReadResponse,
  type WorkingTreeChange,
  type WorkingTreeSubscribeRequest,
  type WorkingTreeSubscribeResponse,
} from "./git-reads.js";
import {
  WorkspaceBindRequestSchema,
  WorkspaceBindResponseSchema,
  WorkspaceListRequestSchema,
  WorkspaceListResponseSchema,
  type WorkspaceBindRequest,
  type WorkspaceBindResponse,
  type WorkspaceListRequest,
  type WorkspaceListResponse,
} from "../workspace.js";
import {
  ExecutionRootPrepareRequestSchema,
  ExecutionRootPrepareResponseSchema,
  WorktreeRetireRequestSchema,
  WorktreeRetireResponseSchema,
  WorktreeStatusReadRequestSchema,
  WorktreeStatusReadResponseSchema,
  type ExecutionRootPrepareRequest,
  type ExecutionRootPrepareResponse,
  type WorktreeRetireRequest,
  type WorktreeRetireResponse,
  type WorktreeStatusReadRequest,
  type WorktreeStatusReadResponse,
} from "../worktree/worktree.js";
import {
  WorktreeSetupRequestSchema,
  WorktreeSetupStatusSchema,
  WorktreeSetupSubscribeResponseSchema,
  type WorktreeSetupRequest,
  type WorktreeSetupStatus,
  type WorktreeSetupSubscribeResponse,
} from "../worktree/setup.js";

/**
 * The `repo.*` descriptors, keyed by method name. A descriptor registers nothing: a method reaches
 * the wire only when the daemon service that answers it registers a handler against it.
 */
export interface RepoMethodDescriptors {
  readonly "repo.attach": MethodDescriptor<"repo.attach", RepoAttachRequest, RepoAttachResponse>;
  readonly "repo.mountRead": MethodDescriptor<
    "repo.mountRead",
    RepoMountReadRequest,
    RepoMountReadResponse
  >;
  readonly "repo.mountList": MethodDescriptor<
    "repo.mountList",
    RepoMountListRequest,
    RepoMountListResponse
  >;
  readonly "repo.detach": MethodDescriptor<"repo.detach", RepoDetachRequest, RepoDetachResponse>;
  readonly "repo.folderList": MethodDescriptor<
    "repo.folderList",
    RepoFolderListRequest,
    RepoFolderListResponse
  >;
  readonly "repo.workspaceBind": MethodDescriptor<
    "repo.workspaceBind",
    WorkspaceBindRequest,
    WorkspaceBindResponse
  >;
  readonly "repo.workspaceList": MethodDescriptor<
    "repo.workspaceList",
    WorkspaceListRequest,
    WorkspaceListResponse
  >;
  readonly "repo.projectList": SubscriptionMethodDescriptor<
    "repo.projectList",
    ProjectListRequest,
    ProjectListResponse,
    ProjectList
  >;
  readonly "repo.projectRename": MethodDescriptor<
    "repo.projectRename",
    ProjectRenameRequest,
    ProjectEditResponse
  >;
  readonly "repo.projectArchive": MethodDescriptor<
    "repo.projectArchive",
    ProjectStateChangeRequest,
    ProjectEditResponse
  >;
  readonly "repo.projectReactivate": MethodDescriptor<
    "repo.projectReactivate",
    ProjectStateChangeRequest,
    ProjectEditResponse
  >;
  readonly "repo.projectSetupUpdate": MethodDescriptor<
    "repo.projectSetupUpdate",
    ProjectSetupUpdateRequest,
    ProjectEditResponse
  >;
  readonly "repo.projectEnvironmentUpdate": MethodDescriptor<
    "repo.projectEnvironmentUpdate",
    ProjectEnvironmentUpdateRequest,
    ProjectEditResponse
  >;
  readonly "repo.projectBranchPatternUpdate": MethodDescriptor<
    "repo.projectBranchPatternUpdate",
    ProjectBranchPatternUpdateRequest,
    ProjectEditResponse
  >;
  readonly "repo.clone": MethodDescriptor<"repo.clone", RepoCloneRequest, RepoCloneResponse>;
  readonly "repo.cloneSubscribe": SubscriptionMethodDescriptor<
    "repo.cloneSubscribe",
    RepoCloneProjectRequest,
    RepoCloneSubscribeResponse,
    RepoCloneStatus
  >;
  readonly "repo.cloneAnswer": MethodDescriptor<
    "repo.cloneAnswer",
    RepoCloneAnswerRequest,
    EmptyPayload
  >;
  readonly "repo.cloneCancel": MethodDescriptor<
    "repo.cloneCancel",
    RepoCloneProjectRequest,
    EmptyPayload
  >;
  readonly "repo.cloneFolderRead": MethodDescriptor<
    "repo.cloneFolderRead",
    RepoCloneFolderReadRequest,
    RepoCloneFolderReadResponse
  >;
  readonly "repo.largeFilesPull": MethodDescriptor<
    "repo.largeFilesPull",
    RepoCloneProjectRequest,
    EmptyPayload
  >;
  readonly "repo.branchList": MethodDescriptor<
    "repo.branchList",
    RepoBranchListRequest,
    RepoBranchListResponse
  >;
  readonly "repo.fileRead": MethodDescriptor<
    "repo.fileRead",
    RepoFileReadRequest,
    RepoFileReadResponse
  >;
  readonly "repo.workingTreeSubscribe": SubscriptionMethodDescriptor<
    "repo.workingTreeSubscribe",
    WorkingTreeSubscribeRequest,
    WorkingTreeSubscribeResponse,
    WorkingTreeChange
  >;
  readonly "repo.executionRootPrepare": MethodDescriptor<
    "repo.executionRootPrepare",
    ExecutionRootPrepareRequest,
    ExecutionRootPrepareResponse
  >;
  readonly "repo.worktreeRetire": MethodDescriptor<
    "repo.worktreeRetire",
    WorktreeRetireRequest,
    WorktreeRetireResponse
  >;
  readonly "repo.worktreeStatusRead": MethodDescriptor<
    "repo.worktreeStatusRead",
    WorktreeStatusReadRequest,
    WorktreeStatusReadResponse
  >;
  readonly "repo.worktreeSetupSubscribe": SubscriptionMethodDescriptor<
    "repo.worktreeSetupSubscribe",
    WorktreeSetupRequest,
    WorktreeSetupSubscribeResponse,
    WorktreeSetupStatus
  >;
  readonly "repo.worktreeSetupRetry": MethodDescriptor<
    "repo.worktreeSetupRetry",
    WorktreeSetupRequest,
    EmptyPayload
  >;
  readonly "repo.removedWorktreeList": MethodDescriptor<
    "repo.removedWorktreeList",
    RemovedWorktreeListRequest,
    RemovedWorktreeListResponse
  >;
  readonly "repo.worktreeRestore": MethodDescriptor<
    "repo.worktreeRestore",
    RemovedWorktreeRequest,
    WorktreeRestoreResponse
  >;
  readonly "repo.removedWorktreeDelete": MethodDescriptor<
    "repo.removedWorktreeDelete",
    RemovedWorktreeRequest,
    EmptyPayload
  >;
}

/**
 * Every `repo.*` method's contract.
 *
 * @consumedBy the daemon's `repo.*` handlers
 */
export const REPO_METHOD_DESCRIPTORS: RepoMethodDescriptors = defineMethodDescriptors({
  "repo.attach": {
    method: "repo.attach",
    procedureType: "mutation",
    mutating: true,
    requestSchema: RepoAttachRequestSchema,
    responseSchema: RepoAttachResponseSchema,
  },
  "repo.mountRead": {
    method: "repo.mountRead",
    procedureType: "query",
    mutating: false,
    requestSchema: RepoMountReadRequestSchema,
    responseSchema: RepoMountReadResponseSchema,
  },
  "repo.mountList": {
    method: "repo.mountList",
    procedureType: "query",
    mutating: false,
    requestSchema: RepoMountListRequestSchema,
    responseSchema: RepoMountListResponseSchema,
  },
  "repo.detach": {
    method: "repo.detach",
    procedureType: "mutation",
    mutating: true,
    requestSchema: RepoDetachRequestSchema,
    responseSchema: RepoDetachResponseSchema,
  },
  "repo.folderList": {
    method: "repo.folderList",
    procedureType: "query",
    mutating: false,
    requestSchema: RepoFolderListRequestSchema,
    responseSchema: RepoFolderListResponseSchema,
  },
  "repo.workspaceBind": {
    method: "repo.workspaceBind",
    procedureType: "mutation",
    mutating: true,
    requestSchema: WorkspaceBindRequestSchema,
    responseSchema: WorkspaceBindResponseSchema,
  },
  "repo.workspaceList": {
    method: "repo.workspaceList",
    procedureType: "query",
    mutating: false,
    requestSchema: WorkspaceListRequestSchema,
    responseSchema: WorkspaceListResponseSchema,
  },
  "repo.projectList": {
    method: "repo.projectList",
    procedureType: "subscription",
    mutating: false,
    requestSchema: ProjectListRequestSchema,
    responseSchema: ProjectListResponseSchema,
    emissionSchema: ProjectListSchema,
  },
  "repo.projectRename": {
    method: "repo.projectRename",
    procedureType: "mutation",
    mutating: true,
    requestSchema: ProjectRenameRequestSchema,
    responseSchema: ProjectEditResponseSchema,
  },
  "repo.projectArchive": {
    method: "repo.projectArchive",
    procedureType: "mutation",
    mutating: true,
    requestSchema: ProjectStateChangeRequestSchema,
    responseSchema: ProjectEditResponseSchema,
  },
  "repo.projectReactivate": {
    method: "repo.projectReactivate",
    procedureType: "mutation",
    mutating: true,
    requestSchema: ProjectStateChangeRequestSchema,
    responseSchema: ProjectEditResponseSchema,
  },
  "repo.projectSetupUpdate": {
    method: "repo.projectSetupUpdate",
    procedureType: "mutation",
    mutating: true,
    requestSchema: ProjectSetupUpdateRequestSchema,
    responseSchema: ProjectEditResponseSchema,
  },
  "repo.projectEnvironmentUpdate": {
    method: "repo.projectEnvironmentUpdate",
    procedureType: "mutation",
    mutating: true,
    requestSchema: ProjectEnvironmentUpdateRequestSchema,
    responseSchema: ProjectEditResponseSchema,
  },
  "repo.projectBranchPatternUpdate": {
    method: "repo.projectBranchPatternUpdate",
    procedureType: "mutation",
    mutating: true,
    requestSchema: ProjectBranchPatternUpdateRequestSchema,
    responseSchema: ProjectEditResponseSchema,
  },
  "repo.clone": {
    method: "repo.clone",
    procedureType: "mutation",
    mutating: true,
    requestSchema: RepoCloneRequestSchema,
    responseSchema: RepoCloneResponseSchema,
  },
  "repo.cloneSubscribe": {
    method: "repo.cloneSubscribe",
    procedureType: "subscription",
    mutating: false,
    requestSchema: RepoCloneProjectRequestSchema,
    responseSchema: RepoCloneSubscribeResponseSchema,
    emissionSchema: RepoCloneStatusSchema,
  },
  "repo.cloneAnswer": {
    method: "repo.cloneAnswer",
    procedureType: "mutation",
    mutating: true,
    requestSchema: RepoCloneAnswerRequestSchema,
    responseSchema: EmptyPayloadSchema,
  },
  "repo.cloneCancel": {
    method: "repo.cloneCancel",
    procedureType: "mutation",
    mutating: true,
    requestSchema: RepoCloneProjectRequestSchema,
    responseSchema: EmptyPayloadSchema,
  },
  "repo.cloneFolderRead": {
    method: "repo.cloneFolderRead",
    procedureType: "query",
    mutating: false,
    requestSchema: RepoCloneFolderReadRequestSchema,
    responseSchema: RepoCloneFolderReadResponseSchema,
  },
  "repo.largeFilesPull": {
    method: "repo.largeFilesPull",
    procedureType: "mutation",
    mutating: true,
    requestSchema: RepoCloneProjectRequestSchema,
    responseSchema: EmptyPayloadSchema,
  },
  "repo.branchList": {
    method: "repo.branchList",
    procedureType: "query",
    mutating: false,
    requestSchema: RepoBranchListRequestSchema,
    responseSchema: RepoBranchListResponseSchema,
  },
  "repo.fileRead": {
    method: "repo.fileRead",
    procedureType: "query",
    mutating: false,
    requestSchema: RepoFileReadRequestSchema,
    responseSchema: RepoFileReadResponseSchema,
  },
  "repo.workingTreeSubscribe": {
    method: "repo.workingTreeSubscribe",
    procedureType: "subscription",
    mutating: false,
    requestSchema: WorkingTreeSubscribeRequestSchema,
    responseSchema: WorkingTreeSubscribeResponseSchema,
    emissionSchema: WorkingTreeChangeSchema,
  },
  "repo.executionRootPrepare": {
    method: "repo.executionRootPrepare",
    procedureType: "mutation",
    mutating: true,
    requestSchema: ExecutionRootPrepareRequestSchema,
    responseSchema: ExecutionRootPrepareResponseSchema,
  },
  "repo.worktreeRetire": {
    method: "repo.worktreeRetire",
    procedureType: "mutation",
    mutating: true,
    requestSchema: WorktreeRetireRequestSchema,
    responseSchema: WorktreeRetireResponseSchema,
  },
  "repo.worktreeStatusRead": {
    method: "repo.worktreeStatusRead",
    procedureType: "query",
    mutating: false,
    requestSchema: WorktreeStatusReadRequestSchema,
    responseSchema: WorktreeStatusReadResponseSchema,
  },
  "repo.worktreeSetupSubscribe": {
    method: "repo.worktreeSetupSubscribe",
    procedureType: "subscription",
    mutating: false,
    requestSchema: WorktreeSetupRequestSchema,
    responseSchema: WorktreeSetupSubscribeResponseSchema,
    emissionSchema: WorktreeSetupStatusSchema,
  },
  "repo.worktreeSetupRetry": {
    method: "repo.worktreeSetupRetry",
    procedureType: "mutation",
    mutating: true,
    requestSchema: WorktreeSetupRequestSchema,
    responseSchema: EmptyPayloadSchema,
  },
  "repo.removedWorktreeList": {
    method: "repo.removedWorktreeList",
    procedureType: "query",
    mutating: false,
    requestSchema: RemovedWorktreeListRequestSchema,
    responseSchema: RemovedWorktreeListResponseSchema,
  },
  "repo.worktreeRestore": {
    method: "repo.worktreeRestore",
    procedureType: "mutation",
    mutating: true,
    requestSchema: RemovedWorktreeRequestSchema,
    responseSchema: WorktreeRestoreResponseSchema,
  },
  "repo.removedWorktreeDelete": {
    method: "repo.removedWorktreeDelete",
    procedureType: "mutation",
    mutating: true,
    requestSchema: RemovedWorktreeRequestSchema,
    responseSchema: EmptyPayloadSchema,
  },
});
