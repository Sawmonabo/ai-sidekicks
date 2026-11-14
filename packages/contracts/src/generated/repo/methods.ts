// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Every repo mount, machine folder, workspace, project, clone, git read and worktree method.

import type { SchemaCheck } from "../../schema-check.js";
import { validateSubscribeAcknowledgmentResponse } from "../checks/jsonrpc/streaming.js";
import { validateEmptyPayload } from "../checks/method-descriptor.js";
import {
  validateProjectBranchPatternUpdateRequest,
  validateProjectEditResponse,
  validateProjectEnvironmentUpdateRequest,
  validateProjectList,
  validateProjectRenameRequest,
  validateProjectSetupUpdateRequest,
  validateProjectStateChangeRequest,
} from "../checks/project.js";
import {
  validateProjectCloneAnswerRequest,
  validateProjectCloneFolderReadResponse,
  validateProjectCloneRequest,
  validateProjectCloneStartRequest,
  validateProjectCloneStartResponse,
  validateProjectCloneStatus,
} from "../checks/repo/clone.js";
import {
  validateMachineFolderListRequest,
  validateMachineFolderListResponse,
  validateRepoMountAttachRequest,
  validateRepoMountAttachResponse,
  validateRepoMountDetachResponse,
  validateRepoMountListResponse,
  validateRepoMountReadResponse,
  validateRepoMountReattachResponse,
  validateRepoMountRequest,
} from "../checks/repo/folders.js";
import {
  validateProjectBranchListRequest,
  validateProjectBranchListResponse,
  validateProjectFileReadRequest,
  validateProjectFileReadResponse,
  validateSessionWorkingFolderSubscribeRequest,
  validateWorkingTreeChange,
} from "../checks/repo/git-reads.js";
import {
  validateWorkspaceBindRequest,
  validateWorkspaceBindResponse,
  validateWorkspaceListRequest,
  validateWorkspaceListResponse,
} from "../checks/repo/workspace.js";
import {
  validateWorktreeCopyProgress,
  validateWorktreeCopySubscribeRequest,
} from "../checks/worktree/copy-progress.js";
import {
  validateWorkspaceExecutionRootPrepareRequest,
  validateWorkspaceExecutionRootPrepareResponse,
  validateWorktreeRetireRequest,
  validateWorktreeRetireResponse,
  validateWorktreeStatusReadRequest,
  validateWorktreeStatusReadResponse,
} from "../checks/worktree/lifecycle.js";
import {
  validateRemovedWorktreeRequest,
  validateWorktreeRemovedListRequest,
  validateWorktreeRemovedListResponse,
  validateWorktreeRestoreResponse,
} from "../checks/worktree/removed.js";
import {
  validateWorktreeSetupRequest,
  validateWorktreeSetupStatus,
} from "../checks/worktree/setup.js";
import type { SubscribeAcknowledgmentResponse } from "../jsonrpc/streaming.js";
import type { EmptyPayload } from "../method-descriptor.js";
import type {
  ProjectBranchPatternUpdateRequest,
  ProjectEditResponse,
  ProjectEnvironmentUpdateRequest,
  ProjectList,
  ProjectRenameRequest,
  ProjectSetupUpdateRequest,
  ProjectStateChangeRequest,
} from "../project.js";
import type {
  WorktreeCopyProgress,
  WorktreeCopySubscribeRequest,
} from "../worktree/copy-progress.js";
import type {
  WorkspaceExecutionRootPrepareRequest,
  WorkspaceExecutionRootPrepareResponse,
  WorktreeRetireRequest,
  WorktreeRetireResponse,
  WorktreeStatusReadRequest,
  WorktreeStatusReadResponse,
} from "../worktree/lifecycle.js";
import type {
  RemovedWorktreeRequest,
  WorktreeRemovedListRequest,
  WorktreeRemovedListResponse,
  WorktreeRestoreResponse,
} from "../worktree/removed.js";
import type { WorktreeSetupRequest, WorktreeSetupStatus } from "../worktree/setup.js";
import type {
  ProjectCloneAnswerRequest,
  ProjectCloneFolderReadResponse,
  ProjectCloneRequest,
  ProjectCloneStartRequest,
  ProjectCloneStartResponse,
  ProjectCloneStatus,
} from "./clone.js";
import type {
  MachineFolderListRequest,
  MachineFolderListResponse,
  RepoMountAttachRequest,
  RepoMountAttachResponse,
  RepoMountDetachResponse,
  RepoMountListResponse,
  RepoMountReadResponse,
  RepoMountReattachResponse,
  RepoMountRequest,
} from "./folders.js";
import type {
  ProjectBranchListRequest,
  ProjectBranchListResponse,
  ProjectFileReadRequest,
  ProjectFileReadResponse,
  SessionWorkingFolderSubscribeRequest,
  WorkingTreeChange,
} from "./git-reads.js";
import type {
  WorkspaceBindRequest,
  WorkspaceBindResponse,
  WorkspaceListRequest,
  WorkspaceListResponse,
} from "./workspace.js";

/** The methods of {@link REPO_METHOD_DESCRIPTORS}, each with its checks. */
export interface RepoMethodDescriptors {
  readonly "repoMount.attach": {
    readonly method: "repoMount.attach";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<RepoMountAttachRequest>;
    readonly responseCheck: SchemaCheck<RepoMountAttachResponse>;
  };
  readonly "repoMount.read": {
    readonly method: "repoMount.read";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<RepoMountRequest>;
    readonly responseCheck: SchemaCheck<RepoMountReadResponse>;
  };
  readonly "repoMount.list": {
    readonly method: "repoMount.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<RepoMountListResponse>;
  };
  readonly "repoMount.detach": {
    readonly method: "repoMount.detach";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<RepoMountRequest>;
    readonly responseCheck: SchemaCheck<RepoMountDetachResponse>;
  };
  readonly "repoMount.reattach": {
    readonly method: "repoMount.reattach";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<RepoMountRequest>;
    readonly responseCheck: SchemaCheck<RepoMountReattachResponse>;
  };
  readonly "machine.folder.list": {
    readonly method: "machine.folder.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<MachineFolderListRequest>;
    readonly responseCheck: SchemaCheck<MachineFolderListResponse>;
  };
  readonly "workspace.bind": {
    readonly method: "workspace.bind";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WorkspaceBindRequest>;
    readonly responseCheck: SchemaCheck<WorkspaceBindResponse>;
  };
  readonly "workspace.list": {
    readonly method: "workspace.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<WorkspaceListRequest>;
    readonly responseCheck: SchemaCheck<WorkspaceListResponse>;
  };
  readonly "project.subscribe": {
    readonly method: "project.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<ProjectList>;
  };
  readonly "project.rename": {
    readonly method: "project.rename";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<ProjectRenameRequest>;
    readonly responseCheck: SchemaCheck<ProjectEditResponse>;
  };
  readonly "project.archive": {
    readonly method: "project.archive";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<ProjectStateChangeRequest>;
    readonly responseCheck: SchemaCheck<ProjectEditResponse>;
  };
  readonly "project.reactivate": {
    readonly method: "project.reactivate";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<ProjectStateChangeRequest>;
    readonly responseCheck: SchemaCheck<ProjectEditResponse>;
  };
  readonly "project.setup.update": {
    readonly method: "project.setup.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<ProjectSetupUpdateRequest>;
    readonly responseCheck: SchemaCheck<ProjectEditResponse>;
  };
  readonly "project.environment.update": {
    readonly method: "project.environment.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<ProjectEnvironmentUpdateRequest>;
    readonly responseCheck: SchemaCheck<ProjectEditResponse>;
  };
  readonly "project.branchPattern.update": {
    readonly method: "project.branchPattern.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<ProjectBranchPatternUpdateRequest>;
    readonly responseCheck: SchemaCheck<ProjectEditResponse>;
  };
  readonly "project.clone.start": {
    readonly method: "project.clone.start";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<ProjectCloneStartRequest>;
    readonly responseCheck: SchemaCheck<ProjectCloneStartResponse>;
  };
  readonly "project.clone.subscribe": {
    readonly method: "project.clone.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<ProjectCloneRequest>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<ProjectCloneStatus>;
  };
  readonly "project.clone.answer": {
    readonly method: "project.clone.answer";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<ProjectCloneAnswerRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
  readonly "project.clone.cancel": {
    readonly method: "project.clone.cancel";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<ProjectCloneRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
  readonly "project.clone.folder.read": {
    readonly method: "project.clone.folder.read";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<ProjectCloneFolderReadResponse>;
  };
  readonly "project.largeFile.pull": {
    readonly method: "project.largeFile.pull";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<ProjectCloneRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
  readonly "project.branch.list": {
    readonly method: "project.branch.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<ProjectBranchListRequest>;
    readonly responseCheck: SchemaCheck<ProjectBranchListResponse>;
  };
  readonly "project.file.read": {
    readonly method: "project.file.read";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<ProjectFileReadRequest>;
    readonly responseCheck: SchemaCheck<ProjectFileReadResponse>;
  };
  readonly "session.workingFolder.subscribe": {
    readonly method: "session.workingFolder.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<SessionWorkingFolderSubscribeRequest>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<WorkingTreeChange>;
  };
  readonly "workspace.executionRoot.prepare": {
    readonly method: "workspace.executionRoot.prepare";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WorkspaceExecutionRootPrepareRequest>;
    readonly responseCheck: SchemaCheck<WorkspaceExecutionRootPrepareResponse>;
  };
  readonly "worktree.retire": {
    readonly method: "worktree.retire";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WorktreeRetireRequest>;
    readonly responseCheck: SchemaCheck<WorktreeRetireResponse>;
  };
  readonly "worktree.status.read": {
    readonly method: "worktree.status.read";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<WorktreeStatusReadRequest>;
    readonly responseCheck: SchemaCheck<WorktreeStatusReadResponse>;
  };
  readonly "worktree.setup.subscribe": {
    readonly method: "worktree.setup.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<WorktreeSetupRequest>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<WorktreeSetupStatus>;
  };
  readonly "worktree.setup.retry": {
    readonly method: "worktree.setup.retry";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WorktreeSetupRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
  readonly "worktree.copy.subscribe": {
    readonly method: "worktree.copy.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<WorktreeCopySubscribeRequest>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<WorktreeCopyProgress>;
  };
  readonly "worktree.removed.list": {
    readonly method: "worktree.removed.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<WorktreeRemovedListRequest>;
    readonly responseCheck: SchemaCheck<WorktreeRemovedListResponse>;
  };
  readonly "worktree.restore": {
    readonly method: "worktree.restore";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<RemovedWorktreeRequest>;
    readonly responseCheck: SchemaCheck<WorktreeRestoreResponse>;
  };
  readonly "worktree.removed.delete": {
    readonly method: "worktree.removed.delete";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<RemovedWorktreeRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
}
/** Every repo mount, machine folder, workspace, project, clone, git read and worktree method. */
export const REPO_METHOD_DESCRIPTORS: RepoMethodDescriptors = /* @__PURE__ */ Object.freeze({
  "repoMount.attach": /* @__PURE__ */ Object.freeze({
    method: "repoMount.attach",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateRepoMountAttachRequest,
    responseCheck: validateRepoMountAttachResponse,
  }),
  "repoMount.read": /* @__PURE__ */ Object.freeze({
    method: "repoMount.read",
    procedureType: "query",
    mutating: false,
    requestCheck: validateRepoMountRequest,
    responseCheck: validateRepoMountReadResponse,
  }),
  "repoMount.list": /* @__PURE__ */ Object.freeze({
    method: "repoMount.list",
    procedureType: "query",
    mutating: false,
    requestCheck: validateEmptyPayload,
    responseCheck: validateRepoMountListResponse,
  }),
  "repoMount.detach": /* @__PURE__ */ Object.freeze({
    method: "repoMount.detach",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateRepoMountRequest,
    responseCheck: validateRepoMountDetachResponse,
  }),
  "repoMount.reattach": /* @__PURE__ */ Object.freeze({
    method: "repoMount.reattach",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateRepoMountRequest,
    responseCheck: validateRepoMountReattachResponse,
  }),
  "machine.folder.list": /* @__PURE__ */ Object.freeze({
    method: "machine.folder.list",
    procedureType: "query",
    mutating: false,
    requestCheck: validateMachineFolderListRequest,
    responseCheck: validateMachineFolderListResponse,
  }),
  "workspace.bind": /* @__PURE__ */ Object.freeze({
    method: "workspace.bind",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateWorkspaceBindRequest,
    responseCheck: validateWorkspaceBindResponse,
  }),
  "workspace.list": /* @__PURE__ */ Object.freeze({
    method: "workspace.list",
    procedureType: "query",
    mutating: false,
    requestCheck: validateWorkspaceListRequest,
    responseCheck: validateWorkspaceListResponse,
  }),
  "project.subscribe": /* @__PURE__ */ Object.freeze({
    method: "project.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestCheck: validateEmptyPayload,
    responseCheck: validateSubscribeAcknowledgmentResponse,
    emissionCheck: validateProjectList,
  }),
  "project.rename": /* @__PURE__ */ Object.freeze({
    method: "project.rename",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateProjectRenameRequest,
    responseCheck: validateProjectEditResponse,
  }),
  "project.archive": /* @__PURE__ */ Object.freeze({
    method: "project.archive",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateProjectStateChangeRequest,
    responseCheck: validateProjectEditResponse,
  }),
  "project.reactivate": /* @__PURE__ */ Object.freeze({
    method: "project.reactivate",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateProjectStateChangeRequest,
    responseCheck: validateProjectEditResponse,
  }),
  "project.setup.update": /* @__PURE__ */ Object.freeze({
    method: "project.setup.update",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateProjectSetupUpdateRequest,
    responseCheck: validateProjectEditResponse,
  }),
  "project.environment.update": /* @__PURE__ */ Object.freeze({
    method: "project.environment.update",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateProjectEnvironmentUpdateRequest,
    responseCheck: validateProjectEditResponse,
  }),
  "project.branchPattern.update": /* @__PURE__ */ Object.freeze({
    method: "project.branchPattern.update",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateProjectBranchPatternUpdateRequest,
    responseCheck: validateProjectEditResponse,
  }),
  "project.clone.start": /* @__PURE__ */ Object.freeze({
    method: "project.clone.start",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateProjectCloneStartRequest,
    responseCheck: validateProjectCloneStartResponse,
  }),
  "project.clone.subscribe": /* @__PURE__ */ Object.freeze({
    method: "project.clone.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestCheck: validateProjectCloneRequest,
    responseCheck: validateSubscribeAcknowledgmentResponse,
    emissionCheck: validateProjectCloneStatus,
  }),
  "project.clone.answer": /* @__PURE__ */ Object.freeze({
    method: "project.clone.answer",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateProjectCloneAnswerRequest,
    responseCheck: validateEmptyPayload,
  }),
  "project.clone.cancel": /* @__PURE__ */ Object.freeze({
    method: "project.clone.cancel",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateProjectCloneRequest,
    responseCheck: validateEmptyPayload,
  }),
  "project.clone.folder.read": /* @__PURE__ */ Object.freeze({
    method: "project.clone.folder.read",
    procedureType: "query",
    mutating: false,
    requestCheck: validateEmptyPayload,
    responseCheck: validateProjectCloneFolderReadResponse,
  }),
  "project.largeFile.pull": /* @__PURE__ */ Object.freeze({
    method: "project.largeFile.pull",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateProjectCloneRequest,
    responseCheck: validateEmptyPayload,
  }),
  "project.branch.list": /* @__PURE__ */ Object.freeze({
    method: "project.branch.list",
    procedureType: "query",
    mutating: false,
    requestCheck: validateProjectBranchListRequest,
    responseCheck: validateProjectBranchListResponse,
  }),
  "project.file.read": /* @__PURE__ */ Object.freeze({
    method: "project.file.read",
    procedureType: "query",
    mutating: false,
    requestCheck: validateProjectFileReadRequest,
    responseCheck: validateProjectFileReadResponse,
  }),
  "session.workingFolder.subscribe": /* @__PURE__ */ Object.freeze({
    method: "session.workingFolder.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestCheck: validateSessionWorkingFolderSubscribeRequest,
    responseCheck: validateSubscribeAcknowledgmentResponse,
    emissionCheck: validateWorkingTreeChange,
  }),
  "workspace.executionRoot.prepare": /* @__PURE__ */ Object.freeze({
    method: "workspace.executionRoot.prepare",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateWorkspaceExecutionRootPrepareRequest,
    responseCheck: validateWorkspaceExecutionRootPrepareResponse,
  }),
  "worktree.retire": /* @__PURE__ */ Object.freeze({
    method: "worktree.retire",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateWorktreeRetireRequest,
    responseCheck: validateWorktreeRetireResponse,
  }),
  "worktree.status.read": /* @__PURE__ */ Object.freeze({
    method: "worktree.status.read",
    procedureType: "query",
    mutating: false,
    requestCheck: validateWorktreeStatusReadRequest,
    responseCheck: validateWorktreeStatusReadResponse,
  }),
  "worktree.setup.subscribe": /* @__PURE__ */ Object.freeze({
    method: "worktree.setup.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestCheck: validateWorktreeSetupRequest,
    responseCheck: validateSubscribeAcknowledgmentResponse,
    emissionCheck: validateWorktreeSetupStatus,
  }),
  "worktree.setup.retry": /* @__PURE__ */ Object.freeze({
    method: "worktree.setup.retry",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateWorktreeSetupRequest,
    responseCheck: validateEmptyPayload,
  }),
  "worktree.copy.subscribe": /* @__PURE__ */ Object.freeze({
    method: "worktree.copy.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestCheck: validateWorktreeCopySubscribeRequest,
    responseCheck: validateSubscribeAcknowledgmentResponse,
    emissionCheck: validateWorktreeCopyProgress,
  }),
  "worktree.removed.list": /* @__PURE__ */ Object.freeze({
    method: "worktree.removed.list",
    procedureType: "query",
    mutating: false,
    requestCheck: validateWorktreeRemovedListRequest,
    responseCheck: validateWorktreeRemovedListResponse,
  }),
  "worktree.restore": /* @__PURE__ */ Object.freeze({
    method: "worktree.restore",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateRemovedWorktreeRequest,
    responseCheck: validateWorktreeRestoreResponse,
  }),
  "worktree.removed.delete": /* @__PURE__ */ Object.freeze({
    method: "worktree.removed.delete",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateRemovedWorktreeRequest,
    responseCheck: validateEmptyPayload,
  }),
});
