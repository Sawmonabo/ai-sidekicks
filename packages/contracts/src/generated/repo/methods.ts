// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Every repo mount, machine folder, workspace, project, clone, git read and worktree method.

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

/** The methods of {@link REPO_METHOD_DESCRIPTORS}, each with its kind. */
export interface RepoMethodDescriptors {
  readonly "repoMount.attach": {
    readonly method: "repoMount.attach";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "repoMount.read": {
    readonly method: "repoMount.read";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "repoMount.list": {
    readonly method: "repoMount.list";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "repoMount.detach": {
    readonly method: "repoMount.detach";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "repoMount.reattach": {
    readonly method: "repoMount.reattach";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "machine.folder.list": {
    readonly method: "machine.folder.list";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "workspace.bind": {
    readonly method: "workspace.bind";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "workspace.list": {
    readonly method: "workspace.list";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "project.subscribe": {
    readonly method: "project.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
  };
  readonly "project.rename": {
    readonly method: "project.rename";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "project.archive": {
    readonly method: "project.archive";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "project.reactivate": {
    readonly method: "project.reactivate";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "project.setup.update": {
    readonly method: "project.setup.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "project.environment.update": {
    readonly method: "project.environment.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "project.branchPattern.update": {
    readonly method: "project.branchPattern.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "project.clone.start": {
    readonly method: "project.clone.start";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "project.clone.subscribe": {
    readonly method: "project.clone.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
  };
  readonly "project.clone.answer": {
    readonly method: "project.clone.answer";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "project.clone.cancel": {
    readonly method: "project.clone.cancel";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "project.clone.folder.read": {
    readonly method: "project.clone.folder.read";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "project.largeFile.pull": {
    readonly method: "project.largeFile.pull";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "project.branch.list": {
    readonly method: "project.branch.list";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "project.file.read": {
    readonly method: "project.file.read";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "session.workingFolder.subscribe": {
    readonly method: "session.workingFolder.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
  };
  readonly "workspace.executionRoot.prepare": {
    readonly method: "workspace.executionRoot.prepare";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "worktree.retire": {
    readonly method: "worktree.retire";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "worktree.status.read": {
    readonly method: "worktree.status.read";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "worktree.setup.subscribe": {
    readonly method: "worktree.setup.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
  };
  readonly "worktree.setup.retry": {
    readonly method: "worktree.setup.retry";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "worktree.copy.subscribe": {
    readonly method: "worktree.copy.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
  };
  readonly "worktree.removed.list": {
    readonly method: "worktree.removed.list";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "worktree.restore": {
    readonly method: "worktree.restore";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "worktree.removed.delete": {
    readonly method: "worktree.removed.delete";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
}
/** The params, result and emission types of each method of {@link REPO_METHOD_DESCRIPTORS}. */
export interface RepoMethodTypes {
  readonly "repoMount.attach": {
    readonly params: RepoMountAttachRequest;
    readonly result: RepoMountAttachResponse;
  };
  readonly "repoMount.read": {
    readonly params: RepoMountRequest;
    readonly result: RepoMountReadResponse;
  };
  readonly "repoMount.list": {
    readonly params: EmptyPayload;
    readonly result: RepoMountListResponse;
  };
  readonly "repoMount.detach": {
    readonly params: RepoMountRequest;
    readonly result: RepoMountDetachResponse;
  };
  readonly "repoMount.reattach": {
    readonly params: RepoMountRequest;
    readonly result: RepoMountReattachResponse;
  };
  readonly "machine.folder.list": {
    readonly params: MachineFolderListRequest;
    readonly result: MachineFolderListResponse;
  };
  readonly "workspace.bind": {
    readonly params: WorkspaceBindRequest;
    readonly result: WorkspaceBindResponse;
  };
  readonly "workspace.list": {
    readonly params: WorkspaceListRequest;
    readonly result: WorkspaceListResponse;
  };
  readonly "project.subscribe": {
    readonly params: EmptyPayload;
    readonly result: SubscribeAcknowledgmentResponse;
    readonly emission: ProjectList;
  };
  readonly "project.rename": {
    readonly params: ProjectRenameRequest;
    readonly result: ProjectEditResponse;
  };
  readonly "project.archive": {
    readonly params: ProjectStateChangeRequest;
    readonly result: ProjectEditResponse;
  };
  readonly "project.reactivate": {
    readonly params: ProjectStateChangeRequest;
    readonly result: ProjectEditResponse;
  };
  readonly "project.setup.update": {
    readonly params: ProjectSetupUpdateRequest;
    readonly result: ProjectEditResponse;
  };
  readonly "project.environment.update": {
    readonly params: ProjectEnvironmentUpdateRequest;
    readonly result: ProjectEditResponse;
  };
  readonly "project.branchPattern.update": {
    readonly params: ProjectBranchPatternUpdateRequest;
    readonly result: ProjectEditResponse;
  };
  readonly "project.clone.start": {
    readonly params: ProjectCloneStartRequest;
    readonly result: ProjectCloneStartResponse;
  };
  readonly "project.clone.subscribe": {
    readonly params: ProjectCloneRequest;
    readonly result: SubscribeAcknowledgmentResponse;
    readonly emission: ProjectCloneStatus;
  };
  readonly "project.clone.answer": {
    readonly params: ProjectCloneAnswerRequest;
    readonly result: EmptyPayload;
  };
  readonly "project.clone.cancel": {
    readonly params: ProjectCloneRequest;
    readonly result: EmptyPayload;
  };
  readonly "project.clone.folder.read": {
    readonly params: EmptyPayload;
    readonly result: ProjectCloneFolderReadResponse;
  };
  readonly "project.largeFile.pull": {
    readonly params: ProjectCloneRequest;
    readonly result: EmptyPayload;
  };
  readonly "project.branch.list": {
    readonly params: ProjectBranchListRequest;
    readonly result: ProjectBranchListResponse;
  };
  readonly "project.file.read": {
    readonly params: ProjectFileReadRequest;
    readonly result: ProjectFileReadResponse;
  };
  readonly "session.workingFolder.subscribe": {
    readonly params: SessionWorkingFolderSubscribeRequest;
    readonly result: SubscribeAcknowledgmentResponse;
    readonly emission: WorkingTreeChange;
  };
  readonly "workspace.executionRoot.prepare": {
    readonly params: WorkspaceExecutionRootPrepareRequest;
    readonly result: WorkspaceExecutionRootPrepareResponse;
  };
  readonly "worktree.retire": {
    readonly params: WorktreeRetireRequest;
    readonly result: WorktreeRetireResponse;
  };
  readonly "worktree.status.read": {
    readonly params: WorktreeStatusReadRequest;
    readonly result: WorktreeStatusReadResponse;
  };
  readonly "worktree.setup.subscribe": {
    readonly params: WorktreeSetupRequest;
    readonly result: SubscribeAcknowledgmentResponse;
    readonly emission: WorktreeSetupStatus;
  };
  readonly "worktree.setup.retry": {
    readonly params: WorktreeSetupRequest;
    readonly result: EmptyPayload;
  };
  readonly "worktree.copy.subscribe": {
    readonly params: WorktreeCopySubscribeRequest;
    readonly result: SubscribeAcknowledgmentResponse;
    readonly emission: WorktreeCopyProgress;
  };
  readonly "worktree.removed.list": {
    readonly params: WorktreeRemovedListRequest;
    readonly result: WorktreeRemovedListResponse;
  };
  readonly "worktree.restore": {
    readonly params: RemovedWorktreeRequest;
    readonly result: WorktreeRestoreResponse;
  };
  readonly "worktree.removed.delete": {
    readonly params: RemovedWorktreeRequest;
    readonly result: EmptyPayload;
  };
}
/** Every repo mount, machine folder, workspace, project, clone, git read and worktree method. */
export const REPO_METHOD_DESCRIPTORS: RepoMethodDescriptors = /* @__PURE__ */ Object.freeze({
  "repoMount.attach": /* @__PURE__ */ Object.freeze({
    method: "repoMount.attach",
    procedureType: "mutation",
    mutating: true,
  }),
  "repoMount.read": /* @__PURE__ */ Object.freeze({
    method: "repoMount.read",
    procedureType: "query",
    mutating: false,
  }),
  "repoMount.list": /* @__PURE__ */ Object.freeze({
    method: "repoMount.list",
    procedureType: "query",
    mutating: false,
  }),
  "repoMount.detach": /* @__PURE__ */ Object.freeze({
    method: "repoMount.detach",
    procedureType: "mutation",
    mutating: true,
  }),
  "repoMount.reattach": /* @__PURE__ */ Object.freeze({
    method: "repoMount.reattach",
    procedureType: "mutation",
    mutating: true,
  }),
  "machine.folder.list": /* @__PURE__ */ Object.freeze({
    method: "machine.folder.list",
    procedureType: "query",
    mutating: false,
  }),
  "workspace.bind": /* @__PURE__ */ Object.freeze({
    method: "workspace.bind",
    procedureType: "mutation",
    mutating: true,
  }),
  "workspace.list": /* @__PURE__ */ Object.freeze({
    method: "workspace.list",
    procedureType: "query",
    mutating: false,
  }),
  "project.subscribe": /* @__PURE__ */ Object.freeze({
    method: "project.subscribe",
    procedureType: "subscription",
    mutating: false,
  }),
  "project.rename": /* @__PURE__ */ Object.freeze({
    method: "project.rename",
    procedureType: "mutation",
    mutating: true,
  }),
  "project.archive": /* @__PURE__ */ Object.freeze({
    method: "project.archive",
    procedureType: "mutation",
    mutating: true,
  }),
  "project.reactivate": /* @__PURE__ */ Object.freeze({
    method: "project.reactivate",
    procedureType: "mutation",
    mutating: true,
  }),
  "project.setup.update": /* @__PURE__ */ Object.freeze({
    method: "project.setup.update",
    procedureType: "mutation",
    mutating: true,
  }),
  "project.environment.update": /* @__PURE__ */ Object.freeze({
    method: "project.environment.update",
    procedureType: "mutation",
    mutating: true,
  }),
  "project.branchPattern.update": /* @__PURE__ */ Object.freeze({
    method: "project.branchPattern.update",
    procedureType: "mutation",
    mutating: true,
  }),
  "project.clone.start": /* @__PURE__ */ Object.freeze({
    method: "project.clone.start",
    procedureType: "mutation",
    mutating: true,
  }),
  "project.clone.subscribe": /* @__PURE__ */ Object.freeze({
    method: "project.clone.subscribe",
    procedureType: "subscription",
    mutating: false,
  }),
  "project.clone.answer": /* @__PURE__ */ Object.freeze({
    method: "project.clone.answer",
    procedureType: "mutation",
    mutating: true,
  }),
  "project.clone.cancel": /* @__PURE__ */ Object.freeze({
    method: "project.clone.cancel",
    procedureType: "mutation",
    mutating: true,
  }),
  "project.clone.folder.read": /* @__PURE__ */ Object.freeze({
    method: "project.clone.folder.read",
    procedureType: "query",
    mutating: false,
  }),
  "project.largeFile.pull": /* @__PURE__ */ Object.freeze({
    method: "project.largeFile.pull",
    procedureType: "mutation",
    mutating: true,
  }),
  "project.branch.list": /* @__PURE__ */ Object.freeze({
    method: "project.branch.list",
    procedureType: "query",
    mutating: false,
  }),
  "project.file.read": /* @__PURE__ */ Object.freeze({
    method: "project.file.read",
    procedureType: "query",
    mutating: false,
  }),
  "session.workingFolder.subscribe": /* @__PURE__ */ Object.freeze({
    method: "session.workingFolder.subscribe",
    procedureType: "subscription",
    mutating: false,
  }),
  "workspace.executionRoot.prepare": /* @__PURE__ */ Object.freeze({
    method: "workspace.executionRoot.prepare",
    procedureType: "mutation",
    mutating: true,
  }),
  "worktree.retire": /* @__PURE__ */ Object.freeze({
    method: "worktree.retire",
    procedureType: "mutation",
    mutating: true,
  }),
  "worktree.status.read": /* @__PURE__ */ Object.freeze({
    method: "worktree.status.read",
    procedureType: "query",
    mutating: false,
  }),
  "worktree.setup.subscribe": /* @__PURE__ */ Object.freeze({
    method: "worktree.setup.subscribe",
    procedureType: "subscription",
    mutating: false,
  }),
  "worktree.setup.retry": /* @__PURE__ */ Object.freeze({
    method: "worktree.setup.retry",
    procedureType: "mutation",
    mutating: true,
  }),
  "worktree.copy.subscribe": /* @__PURE__ */ Object.freeze({
    method: "worktree.copy.subscribe",
    procedureType: "subscription",
    mutating: false,
  }),
  "worktree.removed.list": /* @__PURE__ */ Object.freeze({
    method: "worktree.removed.list",
    procedureType: "query",
    mutating: false,
  }),
  "worktree.restore": /* @__PURE__ */ Object.freeze({
    method: "worktree.restore",
    procedureType: "mutation",
    mutating: true,
  }),
  "worktree.removed.delete": /* @__PURE__ */ Object.freeze({
    method: "worktree.removed.delete",
    procedureType: "mutation",
    mutating: true,
  }),
});
