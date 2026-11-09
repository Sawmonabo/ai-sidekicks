// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A worktree's ids, state and lifecycle payload, and the requests and responses of the worktree methods: preparing an execution root, retiring a tree and the details of its refusals, and reading the project's trees.

import { type SchemaCheck, ucs2length } from "../../schema-check.js";
import type { AgentId } from "../agent/definition.js";
import type { WireInstant } from "../internal/wire-scalars.js";
import type { ProjectId } from "../project.js";
import type { RepoMountId, WorkspaceId, WorkspaceState } from "../repo/mount.js";
import type { RunId } from "../run/id.js";
import type { SessionId } from "../session/id.js";
import type { WorkflowRunId } from "../workflow/run/id.js";

/**
 * The daemon-minted id of a worktree row.
 */
export type WorktreeId = string & { readonly __brand: "WorktreeId" };
/**
 * The daemon-minted id of a branch context: the workspace-anchored branch record.
 */
export type BranchContextId = string & { readonly __brand: "BranchContextId" };
/**
 * The id of a worktree removed with `Discard and remove` and kept whole until the person
 * deletes the copy; a record apart from the retired worktree, since the copy outlives the tree
 * and a put-back makes a new worktree.
 */
export type RemovedWorktreeId = string & { readonly __brand: "RemovedWorktreeId" };
/**
 * A worktree's lifecycle state. `retired` and `failed` are not live; moving to `failed` emits no
 * `worktree.*` event (the failure is evented as `workspace.rootLost`), and failed rows stay
 * readable through `worktree.status.read`.
 */
export type WorktreeState = "creating" | "ready" | "dirty" | "merged" | "retired" | "failed";
/**
 * The state of a listed worktree: every state but `retired`, since a retired tree is never listed.
 * It is a wire enum of its own so a client's table keyed by it covers exactly the listed states;
 * the conversion from [`WorktreeState`] matches every state, so the two cannot drift apart.
 */
export type ListedWorktreeState = "creating" | "ready" | "dirty" | "merged" | "failed";
/**
 * The details of a `worktree.retireConflict` refusal, by why the removal was refused.
 */
export type WorktreeRetireConflictDetails =
  | {
      reason: "rootBusy";
      /**
       * The worktree.
       */
      worktreeId: WorktreeId;
      /**
       * The session the agent runs in.
       */
      runningSessionId: SessionId;
    }
  | {
      reason: "hasChanges";
      /**
       * The worktree.
       */
      worktreeId: WorktreeId;
      /**
       * What removing it would lose now.
       */
      risks: WorktreeRemovalRisks;
    };
/**
 * The run live in a folder another act would take from under it: an agent's run, named by its
 * agent, or a workflow run, by `kind`.
 */
export type RunningHolder =
  | {
      kind: "agent";
      /**
       * The agent the run is for.
       */
      agentId: AgentId;
    }
  | {
      kind: "workflowRun";
      /**
       * The run.
       */
      runId: WorkflowRunId;
    };
/**
 * One worktree git lists for the repository, with every figure its switcher row draws;
 * `path` is the folder `session.workingFolder.update` takes. A tree the app made carries
 * its record, and one the person made carries none and has no removal of its own.
 */
export type WorktreeStatusRecord =
  | {
      madeBy: "app";
      /**
       * The worktree.
       */
      worktreeId: WorktreeId;
      /**
       * Its mount.
       */
      repoMountId: RepoMountId;
      /**
       * The branch it was made from.
       */
      baseBranchName: string;
      /**
       * Its state.
       */
      state: ListedWorktreeState;
      /**
       * The session that made it.
       */
      createdBySessionId: SessionId;
      /**
       * The run that made it; absent for a tree prepared before any run.
       */
      createdByRunId?: RunId;
      /**
       * When it was made.
       */
      createdAt: WireInstant;
      /**
       * When it last changed.
       */
      updatedAt: WireInstant;
      /**
       * The tree's folder.
       */
      path: string;
      /**
       * Its name.
       */
      name: string;
      /**
       * Its branch.
       */
      branchName: string;
      /**
       * Commits ahead of the upstream as of the last fetch; absent with no upstream.
       */
      ahead?: number;
      /**
       * Commits behind the upstream as of the last fetch; absent with no upstream.
       */
      behind?: number;
      /**
       * Uncommitted files.
       */
      uncommittedFileCount: number;
      /**
       * Commits no remote-tracking branch reaches.
       */
      unpushedCommitCount: number;
      /**
       * The sessions standing in it.
       */
      occupyingSessionIds: SessionId[];
      /**
       * The session whose agent runs in it, which locks its removal, or `null`.
       */
      runningSessionId: SessionId | null;
    }
  | {
      madeBy: "person";
      /**
       * The tree's folder.
       */
      path: string;
      /**
       * Its name.
       */
      name: string;
      /**
       * Its branch.
       */
      branchName: string;
      /**
       * Commits ahead of the upstream as of the last fetch; absent with no upstream.
       */
      ahead?: number;
      /**
       * Commits behind the upstream as of the last fetch; absent with no upstream.
       */
      behind?: number;
      /**
       * Uncommitted files.
       */
      uncommittedFileCount: number;
      /**
       * Commits no remote-tracking branch reaches.
       */
      unpushedCommitCount: number;
      /**
       * The sessions standing in it.
       */
      occupyingSessionIds: SessionId[];
      /**
       * The session whose agent runs in it, which locks its removal, or `null`.
       */
      runningSessionId: SessionId | null;
    };

/**
 * The payload of a `worktree.*` lifecycle event; the emitter sets `worktreeId` on every one.
 */
export interface WorktreeLifecyclePayload {
  /**
   * The envelope's session, repeated so a projector can read the payload alone.
   */
  sessionId: SessionId;
  /**
   * The mount, when it is the subject or beside it.
   */
  repoMountId?: RepoMountId;
  /**
   * The workspace, when it is the subject or beside it.
   */
  workspaceId?: WorkspaceId;
  /**
   * The worktree, when it is the subject.
   */
  worktreeId?: string;
  /**
   * The subject's state after the transition.
   */
  state: WorktreeState;
  /**
   * The envelope's actor, repeated; a system event sends `null` or leaves it out.
   */
  actor?: string | null;
}
/**
 * `workspace.executionRoot.prepare`: the workspace and its branch, which makes the root for the
 * workspace's execution mode before a run starts. It carries no run id: the daemon supplies it, so
 * a caller cannot forge run provenance.
 */
export interface WorkspaceExecutionRootPrepareRequest {
  /**
   * The workspace.
   */
  workspaceId: WorkspaceId;
  /**
   * The branch. A `provisionedWorktree` workspace with none is refused
   * `workspace.branchNameRequired` before any git call; a `boundRoot` workspace binds its stored
   * folder and needs none.
   */
  branchName?: string;
  /**
   * The base; absent means the mount's current branch, and a detached HEAD with no base is
   * refused. The daemon refuses a leading dash before git reads it as an option.
   */
  baseRef?: string;
  /**
   * Carries the session's uncommitted work, untracked files included, onto the new tree; refused
   * unless the new base is the branch the work sits on.
   */
  carryUncommitted?: boolean;
}
/**
 * The `workspace.executionRoot.prepare` result: the prepared root and the rows it names. A prepare
 * resolves a root or refuses; there is no partial success.
 */
export interface WorkspaceExecutionRootPrepareResponse {
  /**
   * The root.
   */
  executionRoot: string;
  /**
   * The workspace's state.
   */
  state: WorkspaceState;
  /**
   * The worktree, for a `provisionedWorktree` prepare only.
   */
  worktreeId?: WorktreeId;
  /**
   * The branch context every prepare writes or refreshes.
   */
  branchContextId: BranchContextId;
}
/**
 * `worktree.retire`. `discard: false` is the ordinary removal: it removes nothing the confirm
 * did not show, and is refused with the current risks when the tree changed since they were
 * read. `discard: true` comes only from the discard confirm, and the daemon keeps the tree whole
 * instead of deleting it.
 */
export interface WorktreeRetireRequest {
  /**
   * The worktree.
   */
  worktreeId: WorktreeId;
  /**
   * Whether to keep the tree whole instead of deleting it.
   */
  discard: boolean;
}
/**
 * The kept copy a discard made.
 */
export interface KeptWorktree {
  /**
   * The kept copy.
   */
  removedWorktreeId: RemovedWorktreeId;
}
/**
 * The `worktree.retire` result: the worktree, now `retired`, and the kept copy when a discard
 * kept one. A refusal is an error, never a reply with the unchanged state.
 */
export interface WorktreeRetireResponse {
  /**
   * The worktree.
   */
  worktreeId: WorktreeId;
  /**
   * Its state.
   */
  state: "retired";
  /**
   * The kept copy.
   */
  kept?: KeptWorktree;
}
/**
 * What removing a tree would lose, each named in the confirm: uncommitted files, ignored files (an
 * `.env`, say), commits no remote-tracking branch of the folder reaches, and the sessions standing
 * in it.
 */
export interface WorktreeRemovalRisks {
  /**
   * Uncommitted files.
   */
  uncommittedFileCount: number;
  /**
   * Ignored files that would be destroyed.
   */
  ignoredFileCount: number;
  /**
   * Commits no remote-tracking branch reaches.
   */
  unpushedCommitCount: number;
  /**
   * The sessions standing in it.
   */
  occupyingSessionIds: SessionId[];
}
/**
 * The details of a `worktree.retireIncomplete` refusal: the tree, still live, and the kept copy
 * listed for it. No folder is named; the screen finds both from the lists.
 */
export interface WorktreeRetireIncompleteDetails {
  /**
   * The worktree.
   */
  worktreeId: WorktreeId;
  /**
   * The kept copy.
   */
  removedWorktreeId: RemovedWorktreeId;
}
/**
 * The details of a `worktree.createFailed` refusal with reason `carryCheckoutRunning`: the
 * session whose run is live in the checkout the work would be carried from, and that run.
 */
export interface WorktreeCarryCheckoutRunningDetails {
  /**
   * Why.
   */
  reason: "carryCheckoutRunning";
  /**
   * The session running there.
   */
  runningSessionId: SessionId;
  /**
   * Its run.
   */
  runningHolder: RunningHolder;
}
/**
 * `worktree.status.read`: the project whose worktrees are listed, and the session asking, when
 * one is, so the read also answers the new-worktree form's suggestion for it.
 */
export interface WorktreeStatusReadRequest {
  /**
   * The project.
   */
  projectId: ProjectId;
  /**
   * The session asking.
   */
  sessionId?: SessionId;
}
/**
 * What the new-worktree form opens with, from the daemon function that names and creates the
 * tree, so the form copies none of the daemon's naming.
 */
export interface NewWorktreeSuggestion {
  /**
   * The name's fixed part, from the branch pattern.
   */
  fixedPart: string;
  /**
   * A tail suggested from the session title; absent when the name has none, as for a branch
   * name the person typed that the pattern did not make or a session with no title words.
   */
  suggestedTail?: string;
  /**
   * The folder up to that tail.
   */
  folderBefore: string;
}
/**
 * The project's own checkout.
 */
export interface RepoRootStatus {
  /**
   * Its folder.
   */
  path: string;
  /**
   * Its branch.
   */
  branchName: string;
}
/**
 * The `worktree.status.read` result: the project's own checkout and its standing trees from one
 * read, so no row shows a tree free that another read calls occupied. `countsAsOf` says when the
 * ahead and behind figures were last true if the last fetch failed.
 */
export interface WorktreeStatusReadResponse {
  /**
   * The project's own checkout.
   */
  repoRoot: RepoRootStatus;
  /**
   * Its standing trees.
   */
  worktrees: WorktreeStatusRecord[];
  /**
   * When the figures were last true.
   */
  countsAsOf?: WireInstant;
  /**
   * The new-worktree form's suggestion for the session asking.
   */
  newWorktree?: NewWorktreeSuggestion;
}

// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
function validate2966(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is BranchContextId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2966.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern4.test(data)){validate2966.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2966.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validate2966.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2966.errors = null as any[] | null;
// prettier-ignore
validate2966.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
function validate2967(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkspaceExecutionRootPrepareRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2967.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.workspaceId === undefined) && (missing0 = "workspaceId")){validate2967.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "workspaceId") || (key0 === "branchName")) || (key0 === "baseRef")) || (key0 === "carryUncommitted"))){validate2967.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.workspaceId !== undefined){let data0: any = data.workspaceId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2967.errors = [{instancePath:instancePath+"/workspaceId",schemaPath:"sidekicks-contracts:repo/mount#/$defs/WorkspaceId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2967.errors = [{instancePath:instancePath+"/workspaceId",schemaPath:"sidekicks-contracts:repo/mount#/$defs/WorkspaceId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.branchName !== undefined){let data1: any = data.branchName;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) < 1){validate2967.errors = [{instancePath:instancePath+"/branchName",schemaPath:"#/properties/branchName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data1)){validate2967.errors = [{instancePath:instancePath+"/branchName",schemaPath:"#/properties/branchName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate2967.errors = [{instancePath:instancePath+"/branchName",schemaPath:"#/properties/branchName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.baseRef !== undefined){let data2: any = data.baseRef;const _errs8: any = errors;if(errors === _errs8){if(typeof data2 === "string"){if(func1(data2) < 1){validate2967.errors = [{instancePath:instancePath+"/baseRef",schemaPath:"#/properties/baseRef/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data2)){validate2967.errors = [{instancePath:instancePath+"/baseRef",schemaPath:"#/properties/baseRef/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate2967.errors = [{instancePath:instancePath+"/baseRef",schemaPath:"#/properties/baseRef/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.carryUncommitted !== undefined){const _errs10: any = errors;if(typeof data.carryUncommitted !== "boolean"){validate2967.errors = [{instancePath:instancePath+"/carryUncommitted",schemaPath:"#/properties/carryUncommitted/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}}else {validate2967.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2967.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2967.errors = null as any[] | null;
// prettier-ignore
validate2967.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema922: any = {"description":"A workspace's lifecycle state. `rootLost` means its working root became unavailable and write\nruns are blocked until repair.","type":"string","enum":["preparing","ready","rootLost","archived"]};
// prettier-ignore
const pattern43 = new RegExp("^[^\\x00]*$", "u");
// prettier-ignore
function validate2968(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkspaceExecutionRootPrepareResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2968.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.executionRoot === undefined) && (missing0 = "executionRoot")) || ((data.state === undefined) && (missing0 = "state"))) || ((data.branchContextId === undefined) && (missing0 = "branchContextId"))){validate2968.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "executionRoot") || (key0 === "state")) || (key0 === "worktreeId")) || (key0 === "branchContextId"))){validate2968.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.executionRoot !== undefined){let data0: any = data.executionRoot;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 4096){validate2968.errors = [{instancePath:instancePath+"/executionRoot",schemaPath:"#/properties/executionRoot/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data0) < 1){validate2968.errors = [{instancePath:instancePath+"/executionRoot",schemaPath:"#/properties/executionRoot/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data0)){validate2968.errors = [{instancePath:instancePath+"/executionRoot",schemaPath:"#/properties/executionRoot/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate2968.errors = [{instancePath:instancePath+"/executionRoot",schemaPath:"#/properties/executionRoot/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){let data1: any = data.state;const _errs4: any = errors;if(typeof data1 !== "string"){validate2968.errors = [{instancePath:instancePath+"/state",schemaPath:"sidekicks-contracts:repo/mount#/$defs/WorkspaceState/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((data1 === "preparing") || (data1 === "ready")) || (data1 === "rootLost")) || (data1 === "archived"))){validate2968.errors = [{instancePath:instancePath+"/state",schemaPath:"sidekicks-contracts:repo/mount#/$defs/WorkspaceState/enum",keyword:"enum",params:{allowedValues: schema922.enum}}];return false;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.worktreeId !== undefined){let data2: any = data.worktreeId;const _errs7: any = errors;const _errs8: any = errors;if(errors === _errs8){if(typeof data2 === "string"){if(!pattern4.test(data2)){validate2968.errors = [{instancePath:instancePath+"/worktreeId",schemaPath:"#/$defs/WorktreeId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2968.errors = [{instancePath:instancePath+"/worktreeId",schemaPath:"#/$defs/WorktreeId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.branchContextId !== undefined){let data3: any = data.branchContextId;const _errs11: any = errors;const _errs12: any = errors;if(errors === _errs12){if(typeof data3 === "string"){if(!pattern4.test(data3)){validate2968.errors = [{instancePath:instancePath+"/branchContextId",schemaPath:"#/$defs/BranchContextId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2968.errors = [{instancePath:instancePath+"/branchContextId",schemaPath:"#/$defs/BranchContextId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs11 === errors;}else {var valid0: any = true;}}}}}}}else {validate2968.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2968.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2968.errors = null as any[] | null;
// prettier-ignore
validate2968.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2969(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorktreeId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2969.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern4.test(data)){validate2969.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2969.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validate2969.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2969.errors = null as any[] | null;
// prettier-ignore
validate2969.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema931: any = {"type":"object","additionalProperties":false,"properties":{"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The envelope's session, repeated so a projector can read the payload alone."},"repoMountId":{"$ref":"sidekicks-contracts:repo/mount#/$defs/RepoMountId","description":"The mount, when it is the subject or beside it."},"workspaceId":{"$ref":"sidekicks-contracts:repo/mount#/$defs/WorkspaceId","description":"The workspace, when it is the subject or beside it."},"worktreeId":{"type":"string","pattern":"^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$","description":"The worktree, when it is the subject."},"state":{"$ref":"#/$defs/WorktreeState","description":"The subject's state after the transition."},"actor":{"type":["string","null"],"minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The envelope's actor, repeated; a system event sends `null` or leaves it out."}},"required":["sessionId","state"],"description":"The payload of a `worktree.*` lifecycle event; the emitter sets `worktreeId` on every one."};
// prettier-ignore
const schema929: any = {"description":"A worktree's lifecycle state. `retired` and `failed` are not live; moving to `failed` emits no\n`worktree.*` event (the failure is evented as `workspace.rootLost`), and failed rows stay\nreadable through `worktree.status.read`.","type":"string","enum":["creating","ready","dirty","merged","retired","failed"]};
// prettier-ignore
function validate2970(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorktreeLifecyclePayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2970.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.state === undefined) && (missing0 = "state"))){validate2970.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((key0 === "sessionId") || (key0 === "repoMountId")) || (key0 === "workspaceId")) || (key0 === "worktreeId")) || (key0 === "state")) || (key0 === "actor"))){validate2970.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2970.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2970.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.repoMountId !== undefined){let data1: any = data.repoMountId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate2970.errors = [{instancePath:instancePath+"/repoMountId",schemaPath:"sidekicks-contracts:repo/mount#/$defs/RepoMountId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2970.errors = [{instancePath:instancePath+"/repoMountId",schemaPath:"sidekicks-contracts:repo/mount#/$defs/RepoMountId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.workspaceId !== undefined){let data2: any = data.workspaceId;const _errs10: any = errors;const _errs11: any = errors;if(errors === _errs11){if(typeof data2 === "string"){if(!pattern4.test(data2)){validate2970.errors = [{instancePath:instancePath+"/workspaceId",schemaPath:"sidekicks-contracts:repo/mount#/$defs/WorkspaceId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2970.errors = [{instancePath:instancePath+"/workspaceId",schemaPath:"sidekicks-contracts:repo/mount#/$defs/WorkspaceId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.worktreeId !== undefined){let data3: any = data.worktreeId;const _errs14: any = errors;if(errors === _errs14){if(typeof data3 === "string"){if(!pattern4.test(data3)){validate2970.errors = [{instancePath:instancePath+"/worktreeId",schemaPath:"#/properties/worktreeId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2970.errors = [{instancePath:instancePath+"/worktreeId",schemaPath:"#/properties/worktreeId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){let data4: any = data.state;const _errs16: any = errors;if(typeof data4 !== "string"){validate2970.errors = [{instancePath:instancePath+"/state",schemaPath:"#/$defs/WorktreeState/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((((data4 === "creating") || (data4 === "ready")) || (data4 === "dirty")) || (data4 === "merged")) || (data4 === "retired")) || (data4 === "failed"))){validate2970.errors = [{instancePath:instancePath+"/state",schemaPath:"#/$defs/WorktreeState/enum",keyword:"enum",params:{allowedValues: schema929.enum}}];return false;}var valid0: any = _errs16 === errors;}else {var valid0: any = true;}if(valid0){if(data.actor !== undefined){let data5: any = data.actor;const _errs19: any = errors;if((typeof data5 !== "string") && (data5 !== null)){validate2970.errors = [{instancePath:instancePath+"/actor",schemaPath:"#/properties/actor/type",keyword:"type",params:{type: schema931.properties.actor.type}}];return false;}if(errors === _errs19){if(typeof data5 === "string"){if(func1(data5) > 256){validate2970.errors = [{instancePath:instancePath+"/actor",schemaPath:"#/properties/actor/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data5) < 1){validate2970.errors = [{instancePath:instancePath+"/actor",schemaPath:"#/properties/actor/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data5)){validate2970.errors = [{instancePath:instancePath+"/actor",schemaPath:"#/properties/actor/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}}var valid0: any = _errs19 === errors;}else {var valid0: any = true;}}}}}}}}}else {validate2970.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2970.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2970.errors = null as any[] | null;
// prettier-ignore
validate2970.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2971(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorktreeRetireRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2971.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.worktreeId === undefined) && (missing0 = "worktreeId")) || ((data.discard === undefined) && (missing0 = "discard"))){validate2971.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "worktreeId") || (key0 === "discard"))){validate2971.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.worktreeId !== undefined){let data0: any = data.worktreeId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2971.errors = [{instancePath:instancePath+"/worktreeId",schemaPath:"#/$defs/WorktreeId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2971.errors = [{instancePath:instancePath+"/worktreeId",schemaPath:"#/$defs/WorktreeId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.discard !== undefined){const _errs6: any = errors;if(typeof data.discard !== "boolean"){validate2971.errors = [{instancePath:instancePath+"/discard",schemaPath:"#/properties/discard/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate2971.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2971.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2971.errors = null as any[] | null;
// prettier-ignore
validate2971.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema5624: any = {"type":"object","additionalProperties":false,"properties":{"worktreeId":{"$ref":"#/$defs/WorktreeId","description":"The worktree."},"state":{"description":"Its state.","type":"string","enum":["retired"]},"kept":{"$ref":"#/$defs/KeptWorktree","description":"The kept copy."}},"required":["worktreeId","state"],"description":"The `worktree.retire` result: the worktree, now `retired`, and the kept copy when a discard\nkept one. A refusal is an error, never a reply with the unchanged state."};
// prettier-ignore
function validate2973(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2973.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.removedWorktreeId === undefined) && (missing0 = "removedWorktreeId")){validate2973.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "removedWorktreeId")){validate2973.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.removedWorktreeId !== undefined){let data0: any = data.removedWorktreeId;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2973.errors = [{instancePath:instancePath+"/removedWorktreeId",schemaPath:"#/$defs/RemovedWorktreeId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2973.errors = [{instancePath:instancePath+"/removedWorktreeId",schemaPath:"#/$defs/RemovedWorktreeId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate2973.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2973.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2973.errors = null as any[] | null;
// prettier-ignore
validate2973.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2972(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorktreeRetireResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2972.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.worktreeId === undefined) && (missing0 = "worktreeId")) || ((data.state === undefined) && (missing0 = "state"))){validate2972.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "worktreeId") || (key0 === "state")) || (key0 === "kept"))){validate2972.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.worktreeId !== undefined){let data0: any = data.worktreeId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2972.errors = [{instancePath:instancePath+"/worktreeId",schemaPath:"#/$defs/WorktreeId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2972.errors = [{instancePath:instancePath+"/worktreeId",schemaPath:"#/$defs/WorktreeId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){let data1: any = data.state;const _errs6: any = errors;if(typeof data1 !== "string"){validate2972.errors = [{instancePath:instancePath+"/state",schemaPath:"#/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data1 === "retired")){validate2972.errors = [{instancePath:instancePath+"/state",schemaPath:"#/properties/state/enum",keyword:"enum",params:{allowedValues: schema5624.properties.state.enum}}];return false;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.kept !== undefined){const _errs8: any = errors;if(!(validate2973.call(this, data.kept, {instancePath:instancePath+"/kept",parentData:data,parentDataProperty:"kept",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2973.errors : vErrors.concat(validate2973.errors);errors = vErrors.length;}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}}}}}}else {validate2972.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2972.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2972.errors = null as any[] | null;
// prettier-ignore
validate2972.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2975(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorktreeState {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2975.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validate2975.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((((data === "creating") || (data === "ready")) || (data === "dirty")) || (data === "merged")) || (data === "retired")) || (data === "failed"))){validate2975.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema929.enum}}];return false;}validate2975.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2975.errors = null as any[] | null;
// prettier-ignore
validate2975.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2976(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorktreeStatusReadRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2976.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.projectId === undefined) && (missing0 = "projectId")){validate2976.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "projectId") || (key0 === "sessionId"))){validate2976.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.projectId !== undefined){let data0: any = data.projectId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2976.errors = [{instancePath:instancePath+"/projectId",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2976.errors = [{instancePath:instancePath+"/projectId",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.sessionId !== undefined){let data1: any = data.sessionId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate2976.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2976.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate2976.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2976.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2976.errors = null as any[] | null;
// prettier-ignore
validate2976.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern5 = new RegExp("^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$", "u");
// prettier-ignore
const schema5634: any = {"oneOf":[{"type":"object","additionalProperties":false,"properties":{"madeBy":{"type":"string","const":"app"},"worktreeId":{"$ref":"#/$defs/WorktreeId","description":"The worktree."},"repoMountId":{"$ref":"sidekicks-contracts:repo/mount#/$defs/RepoMountId","description":"Its mount."},"baseBranchName":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","description":"The branch it was made from."},"state":{"$ref":"#/$defs/ListedWorktreeState","description":"Its state."},"createdBySessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session that made it."},"createdByRunId":{"$ref":"sidekicks-contracts:run/id#/$defs/RunId","description":"The run that made it; absent for a tree prepared before any run."},"createdAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When it was made."},"updatedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When it last changed."},"path":{"type":"string","maxLength":4096,"pattern":"^[^\\x00]*$","minLength":1,"description":"The tree's folder."},"name":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":4096,"description":"Its name."},"branchName":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","description":"Its branch."},"ahead":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"Commits ahead of the upstream as of the last fetch; absent with no upstream."},"behind":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"Commits behind the upstream as of the last fetch; absent with no upstream."},"uncommittedFileCount":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"Uncommitted files."},"unpushedCommitCount":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"Commits no remote-tracking branch reaches."},"occupyingSessionIds":{"type":"array","items":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId"},"description":"The sessions standing in it."},"runningSessionId":{"anyOf":[{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId"},{"type":"null"}],"description":"The session whose agent runs in it, which locks its removal, or `null`."}},"required":["madeBy","worktreeId","repoMountId","baseBranchName","state","createdBySessionId","createdAt","updatedAt","path","name","branchName","uncommittedFileCount","unpushedCommitCount","occupyingSessionIds","runningSessionId"],"description":"A tree the app made, with its record."},{"type":"object","additionalProperties":false,"properties":{"madeBy":{"type":"string","const":"person"},"path":{"type":"string","maxLength":4096,"pattern":"^[^\\x00]*$","minLength":1,"description":"The tree's folder."},"name":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":4096,"description":"Its name."},"branchName":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","description":"Its branch."},"ahead":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"Commits ahead of the upstream as of the last fetch; absent with no upstream."},"behind":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"Commits behind the upstream as of the last fetch; absent with no upstream."},"uncommittedFileCount":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"Uncommitted files."},"unpushedCommitCount":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"Commits no remote-tracking branch reaches."},"occupyingSessionIds":{"type":"array","items":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId"},"description":"The sessions standing in it."},"runningSessionId":{"anyOf":[{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId"},{"type":"null"}],"description":"The session whose agent runs in it, which locks its removal, or `null`."}},"required":["madeBy","path","name","branchName","uncommittedFileCount","unpushedCommitCount","occupyingSessionIds","runningSessionId"],"description":"A tree the person made."}],"description":"One worktree git lists for the repository, with every figure its switcher row draws;\n`path` is the folder `session.workingFolder.update` takes. A tree the app made carries\nits record, and one the person made carries none and has no removal of its own.","discriminator":{"propertyName":"madeBy"},"type":"object","unevaluatedProperties":false};
// prettier-ignore
const schema5637: any = {"description":"The state of a listed worktree: every state but `retired`, since a retired tree is never listed.\nIt is a wire enum of its own so a client's table keyed by it covers exactly the listed states;\nthe conversion from [`WorktreeState`] matches every state, so the two cannot drift apart.","type":"string","enum":["creating","ready","dirty","merged","failed"]};
// prettier-ignore
const func2 = Object.prototype.hasOwnProperty;
// prettier-ignore
function validate2978(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2978.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.madeBy;if(typeof tag0 == "string"){if(tag0 === "app"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((((((((((((data.madeBy === undefined) && (missing0 = "madeBy")) || ((data.worktreeId === undefined) && (missing0 = "worktreeId"))) || ((data.repoMountId === undefined) && (missing0 = "repoMountId"))) || ((data.baseBranchName === undefined) && (missing0 = "baseBranchName"))) || ((data.state === undefined) && (missing0 = "state"))) || ((data.createdBySessionId === undefined) && (missing0 = "createdBySessionId"))) || ((data.createdAt === undefined) && (missing0 = "createdAt"))) || ((data.updatedAt === undefined) && (missing0 = "updatedAt"))) || ((data.path === undefined) && (missing0 = "path"))) || ((data.name === undefined) && (missing0 = "name"))) || ((data.branchName === undefined) && (missing0 = "branchName"))) || ((data.uncommittedFileCount === undefined) && (missing0 = "uncommittedFileCount"))) || ((data.unpushedCommitCount === undefined) && (missing0 = "unpushedCommitCount"))) || ((data.occupyingSessionIds === undefined) && (missing0 = "occupyingSessionIds"))) || ((data.runningSessionId === undefined) && (missing0 = "runningSessionId"))){validate2978.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!(func2.call(schema5634.oneOf[0].properties, key0))){validate2978.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.madeBy !== undefined){let data0: any = data.madeBy;const _errs5: any = errors;if(typeof data0 !== "string"){validate2978.errors = [{instancePath:instancePath+"/madeBy",schemaPath:"#/oneOf/0/properties/madeBy/type",keyword:"type",params:{type: "string"}}];return false;}if("app" !== data0){validate2978.errors = [{instancePath:instancePath+"/madeBy",schemaPath:"#/oneOf/0/properties/madeBy/const",keyword:"const",params:{allowedValue: "app"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.worktreeId !== undefined){let data1: any = data.worktreeId;const _errs7: any = errors;const _errs8: any = errors;if(errors === _errs8){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate2978.errors = [{instancePath:instancePath+"/worktreeId",schemaPath:"#/$defs/WorktreeId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2978.errors = [{instancePath:instancePath+"/worktreeId",schemaPath:"#/$defs/WorktreeId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.repoMountId !== undefined){let data2: any = data.repoMountId;const _errs11: any = errors;const _errs12: any = errors;if(errors === _errs12){if(typeof data2 === "string"){if(!pattern4.test(data2)){validate2978.errors = [{instancePath:instancePath+"/repoMountId",schemaPath:"sidekicks-contracts:repo/mount#/$defs/RepoMountId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2978.errors = [{instancePath:instancePath+"/repoMountId",schemaPath:"sidekicks-contracts:repo/mount#/$defs/RepoMountId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs11 === errors;}else {var valid2: any = true;}if(valid2){if(data.baseBranchName !== undefined){let data3: any = data.baseBranchName;const _errs15: any = errors;if(errors === _errs15){if(typeof data3 === "string"){if(func1(data3) < 1){validate2978.errors = [{instancePath:instancePath+"/baseBranchName",schemaPath:"#/oneOf/0/properties/baseBranchName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data3)){validate2978.errors = [{instancePath:instancePath+"/baseBranchName",schemaPath:"#/oneOf/0/properties/baseBranchName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate2978.errors = [{instancePath:instancePath+"/baseBranchName",schemaPath:"#/oneOf/0/properties/baseBranchName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs15 === errors;}else {var valid2: any = true;}if(valid2){if(data.state !== undefined){let data4: any = data.state;const _errs17: any = errors;if(typeof data4 !== "string"){validate2978.errors = [{instancePath:instancePath+"/state",schemaPath:"#/$defs/ListedWorktreeState/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((((data4 === "creating") || (data4 === "ready")) || (data4 === "dirty")) || (data4 === "merged")) || (data4 === "failed"))){validate2978.errors = [{instancePath:instancePath+"/state",schemaPath:"#/$defs/ListedWorktreeState/enum",keyword:"enum",params:{allowedValues: schema5637.enum}}];return false;}var valid2: any = _errs17 === errors;}else {var valid2: any = true;}if(valid2){if(data.createdBySessionId !== undefined){let data5: any = data.createdBySessionId;const _errs20: any = errors;const _errs21: any = errors;if(errors === _errs21){if(typeof data5 === "string"){if(!pattern4.test(data5)){validate2978.errors = [{instancePath:instancePath+"/createdBySessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2978.errors = [{instancePath:instancePath+"/createdBySessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs20 === errors;}else {var valid2: any = true;}if(valid2){if(data.createdByRunId !== undefined){let data6: any = data.createdByRunId;const _errs24: any = errors;const _errs25: any = errors;if(errors === _errs25){if(typeof data6 === "string"){if(!pattern4.test(data6)){validate2978.errors = [{instancePath:instancePath+"/createdByRunId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2978.errors = [{instancePath:instancePath+"/createdByRunId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs24 === errors;}else {var valid2: any = true;}if(valid2){if(data.createdAt !== undefined){let data7: any = data.createdAt;const _errs28: any = errors;const _errs29: any = errors;if(errors === _errs29){if(typeof data7 === "string"){if(!pattern5.test(data7)){validate2978.errors = [{instancePath:instancePath+"/createdAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate2978.errors = [{instancePath:instancePath+"/createdAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs28 === errors;}else {var valid2: any = true;}if(valid2){if(data.updatedAt !== undefined){let data8: any = data.updatedAt;const _errs31: any = errors;const _errs32: any = errors;if(errors === _errs32){if(typeof data8 === "string"){if(!pattern5.test(data8)){validate2978.errors = [{instancePath:instancePath+"/updatedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate2978.errors = [{instancePath:instancePath+"/updatedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs31 === errors;}else {var valid2: any = true;}if(valid2){if(data.path !== undefined){let data9: any = data.path;const _errs34: any = errors;if(errors === _errs34){if(typeof data9 === "string"){if(func1(data9) > 4096){validate2978.errors = [{instancePath:instancePath+"/path",schemaPath:"#/oneOf/0/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data9) < 1){validate2978.errors = [{instancePath:instancePath+"/path",schemaPath:"#/oneOf/0/properties/path/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data9)){validate2978.errors = [{instancePath:instancePath+"/path",schemaPath:"#/oneOf/0/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate2978.errors = [{instancePath:instancePath+"/path",schemaPath:"#/oneOf/0/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs34 === errors;}else {var valid2: any = true;}if(valid2){if(data.name !== undefined){let data10: any = data.name;const _errs36: any = errors;if(errors === _errs36){if(typeof data10 === "string"){if(func1(data10) > 4096){validate2978.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/0/properties/name/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data10) < 1){validate2978.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/0/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data10)){validate2978.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/0/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate2978.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/0/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs36 === errors;}else {var valid2: any = true;}if(valid2){if(data.branchName !== undefined){let data11: any = data.branchName;const _errs38: any = errors;if(errors === _errs38){if(typeof data11 === "string"){if(func1(data11) < 1){validate2978.errors = [{instancePath:instancePath+"/branchName",schemaPath:"#/oneOf/0/properties/branchName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data11)){validate2978.errors = [{instancePath:instancePath+"/branchName",schemaPath:"#/oneOf/0/properties/branchName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate2978.errors = [{instancePath:instancePath+"/branchName",schemaPath:"#/oneOf/0/properties/branchName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs38 === errors;}else {var valid2: any = true;}if(valid2){if(data.ahead !== undefined){let data12: any = data.ahead;const _errs40: any = errors;if(!(((typeof data12 == "number") && (!(data12 % 1) && !isNaN(data12))) && (isFinite(data12)))){validate2978.errors = [{instancePath:instancePath+"/ahead",schemaPath:"#/oneOf/0/properties/ahead/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs40){if((typeof data12 == "number") && (isFinite(data12))){if(data12 > 9007199254740991 || isNaN(data12)){validate2978.errors = [{instancePath:instancePath+"/ahead",schemaPath:"#/oneOf/0/properties/ahead/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data12 < 0 || isNaN(data12)){validate2978.errors = [{instancePath:instancePath+"/ahead",schemaPath:"#/oneOf/0/properties/ahead/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs40 === errors;}else {var valid2: any = true;}if(valid2){if(data.behind !== undefined){let data13: any = data.behind;const _errs42: any = errors;if(!(((typeof data13 == "number") && (!(data13 % 1) && !isNaN(data13))) && (isFinite(data13)))){validate2978.errors = [{instancePath:instancePath+"/behind",schemaPath:"#/oneOf/0/properties/behind/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs42){if((typeof data13 == "number") && (isFinite(data13))){if(data13 > 9007199254740991 || isNaN(data13)){validate2978.errors = [{instancePath:instancePath+"/behind",schemaPath:"#/oneOf/0/properties/behind/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data13 < 0 || isNaN(data13)){validate2978.errors = [{instancePath:instancePath+"/behind",schemaPath:"#/oneOf/0/properties/behind/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs42 === errors;}else {var valid2: any = true;}if(valid2){if(data.uncommittedFileCount !== undefined){let data14: any = data.uncommittedFileCount;const _errs44: any = errors;if(!(((typeof data14 == "number") && (!(data14 % 1) && !isNaN(data14))) && (isFinite(data14)))){validate2978.errors = [{instancePath:instancePath+"/uncommittedFileCount",schemaPath:"#/oneOf/0/properties/uncommittedFileCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs44){if((typeof data14 == "number") && (isFinite(data14))){if(data14 > 9007199254740991 || isNaN(data14)){validate2978.errors = [{instancePath:instancePath+"/uncommittedFileCount",schemaPath:"#/oneOf/0/properties/uncommittedFileCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data14 < 0 || isNaN(data14)){validate2978.errors = [{instancePath:instancePath+"/uncommittedFileCount",schemaPath:"#/oneOf/0/properties/uncommittedFileCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs44 === errors;}else {var valid2: any = true;}if(valid2){if(data.unpushedCommitCount !== undefined){let data15: any = data.unpushedCommitCount;const _errs46: any = errors;if(!(((typeof data15 == "number") && (!(data15 % 1) && !isNaN(data15))) && (isFinite(data15)))){validate2978.errors = [{instancePath:instancePath+"/unpushedCommitCount",schemaPath:"#/oneOf/0/properties/unpushedCommitCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs46){if((typeof data15 == "number") && (isFinite(data15))){if(data15 > 9007199254740991 || isNaN(data15)){validate2978.errors = [{instancePath:instancePath+"/unpushedCommitCount",schemaPath:"#/oneOf/0/properties/unpushedCommitCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data15 < 0 || isNaN(data15)){validate2978.errors = [{instancePath:instancePath+"/unpushedCommitCount",schemaPath:"#/oneOf/0/properties/unpushedCommitCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs46 === errors;}else {var valid2: any = true;}if(valid2){if(data.occupyingSessionIds !== undefined){let data16: any = data.occupyingSessionIds;const _errs48: any = errors;if(errors === _errs48){if(Array.isArray(data16)){var valid10: any = true;const len0: any = data16.length;for(let i0=0; i0<len0; i0++){let data17: any = data16[i0];const _errs50: any = errors;const _errs51: any = errors;if(errors === _errs51){if(typeof data17 === "string"){if(!pattern4.test(data17)){validate2978.errors = [{instancePath:instancePath+"/occupyingSessionIds/" + i0,schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2978.errors = [{instancePath:instancePath+"/occupyingSessionIds/" + i0,schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid10: any = _errs50 === errors;if(!valid10){break;}}}else {validate2978.errors = [{instancePath:instancePath+"/occupyingSessionIds",schemaPath:"#/oneOf/0/properties/occupyingSessionIds/type",keyword:"type",params:{type: "array"}}];return false;}}var valid2: any = _errs48 === errors;}else {var valid2: any = true;}if(valid2){if(data.runningSessionId !== undefined){let data18: any = data.runningSessionId;const _errs54: any = errors;const _errs55: any = errors;let valid12: any = false;const _errs56: any = errors;const _errs57: any = errors;if(errors === _errs57){if(typeof data18 === "string"){if(!pattern4.test(data18)){const err0: any = {instancePath:instancePath+"/runningSessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}}else {const err1: any = {instancePath:instancePath+"/runningSessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}}var _valid0: any = _errs56 === errors;valid12 = valid12 || _valid0;const _errs60: any = errors;if(data18 !== null){const err2: any = {instancePath:instancePath+"/runningSessionId",schemaPath:"#/oneOf/0/properties/runningSessionId/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}var _valid0: any = _errs60 === errors;valid12 = valid12 || _valid0;if(!valid12){const err3: any = {instancePath:instancePath+"/runningSessionId",schemaPath:"#/oneOf/0/properties/runningSessionId/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;validate2978.errors = vErrors;return false;}else {errors = _errs55;if(vErrors !== null){if(_errs55){vErrors.length = _errs55;}else {vErrors = null;}}}var valid2: any = _errs54 === errors;}else {var valid2: any = true;}}}}}}}}}}}}}}}}}}}}}else {validate2978.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "person"){const _errs62: any = errors;if(errors === _errs62){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((((((((data.madeBy === undefined) && (missing1 = "madeBy")) || ((data.path === undefined) && (missing1 = "path"))) || ((data.name === undefined) && (missing1 = "name"))) || ((data.branchName === undefined) && (missing1 = "branchName"))) || ((data.uncommittedFileCount === undefined) && (missing1 = "uncommittedFileCount"))) || ((data.unpushedCommitCount === undefined) && (missing1 = "unpushedCommitCount"))) || ((data.occupyingSessionIds === undefined) && (missing1 = "occupyingSessionIds"))) || ((data.runningSessionId === undefined) && (missing1 = "runningSessionId"))){validate2978.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs64: any = errors;for(const key1 in data){if(!(func2.call(schema5634.oneOf[1].properties, key1))){validate2978.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs64 === errors){if(data.madeBy !== undefined){let data19: any = data.madeBy;const _errs65: any = errors;if(typeof data19 !== "string"){validate2978.errors = [{instancePath:instancePath+"/madeBy",schemaPath:"#/oneOf/1/properties/madeBy/type",keyword:"type",params:{type: "string"}}];return false;}if("person" !== data19){validate2978.errors = [{instancePath:instancePath+"/madeBy",schemaPath:"#/oneOf/1/properties/madeBy/const",keyword:"const",params:{allowedValue: "person"}}];return false;}var valid15: any = _errs65 === errors;}else {var valid15: any = true;}if(valid15){if(data.path !== undefined){let data20: any = data.path;const _errs67: any = errors;if(errors === _errs67){if(typeof data20 === "string"){if(func1(data20) > 4096){validate2978.errors = [{instancePath:instancePath+"/path",schemaPath:"#/oneOf/1/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data20) < 1){validate2978.errors = [{instancePath:instancePath+"/path",schemaPath:"#/oneOf/1/properties/path/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data20)){validate2978.errors = [{instancePath:instancePath+"/path",schemaPath:"#/oneOf/1/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate2978.errors = [{instancePath:instancePath+"/path",schemaPath:"#/oneOf/1/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}var valid15: any = _errs67 === errors;}else {var valid15: any = true;}if(valid15){if(data.name !== undefined){let data21: any = data.name;const _errs69: any = errors;if(errors === _errs69){if(typeof data21 === "string"){if(func1(data21) > 4096){validate2978.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/1/properties/name/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data21) < 1){validate2978.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/1/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data21)){validate2978.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/1/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate2978.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/1/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid15: any = _errs69 === errors;}else {var valid15: any = true;}if(valid15){if(data.branchName !== undefined){let data22: any = data.branchName;const _errs71: any = errors;if(errors === _errs71){if(typeof data22 === "string"){if(func1(data22) < 1){validate2978.errors = [{instancePath:instancePath+"/branchName",schemaPath:"#/oneOf/1/properties/branchName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data22)){validate2978.errors = [{instancePath:instancePath+"/branchName",schemaPath:"#/oneOf/1/properties/branchName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate2978.errors = [{instancePath:instancePath+"/branchName",schemaPath:"#/oneOf/1/properties/branchName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid15: any = _errs71 === errors;}else {var valid15: any = true;}if(valid15){if(data.ahead !== undefined){let data23: any = data.ahead;const _errs73: any = errors;if(!(((typeof data23 == "number") && (!(data23 % 1) && !isNaN(data23))) && (isFinite(data23)))){validate2978.errors = [{instancePath:instancePath+"/ahead",schemaPath:"#/oneOf/1/properties/ahead/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs73){if((typeof data23 == "number") && (isFinite(data23))){if(data23 > 9007199254740991 || isNaN(data23)){validate2978.errors = [{instancePath:instancePath+"/ahead",schemaPath:"#/oneOf/1/properties/ahead/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data23 < 0 || isNaN(data23)){validate2978.errors = [{instancePath:instancePath+"/ahead",schemaPath:"#/oneOf/1/properties/ahead/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid15: any = _errs73 === errors;}else {var valid15: any = true;}if(valid15){if(data.behind !== undefined){let data24: any = data.behind;const _errs75: any = errors;if(!(((typeof data24 == "number") && (!(data24 % 1) && !isNaN(data24))) && (isFinite(data24)))){validate2978.errors = [{instancePath:instancePath+"/behind",schemaPath:"#/oneOf/1/properties/behind/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs75){if((typeof data24 == "number") && (isFinite(data24))){if(data24 > 9007199254740991 || isNaN(data24)){validate2978.errors = [{instancePath:instancePath+"/behind",schemaPath:"#/oneOf/1/properties/behind/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data24 < 0 || isNaN(data24)){validate2978.errors = [{instancePath:instancePath+"/behind",schemaPath:"#/oneOf/1/properties/behind/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid15: any = _errs75 === errors;}else {var valid15: any = true;}if(valid15){if(data.uncommittedFileCount !== undefined){let data25: any = data.uncommittedFileCount;const _errs77: any = errors;if(!(((typeof data25 == "number") && (!(data25 % 1) && !isNaN(data25))) && (isFinite(data25)))){validate2978.errors = [{instancePath:instancePath+"/uncommittedFileCount",schemaPath:"#/oneOf/1/properties/uncommittedFileCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs77){if((typeof data25 == "number") && (isFinite(data25))){if(data25 > 9007199254740991 || isNaN(data25)){validate2978.errors = [{instancePath:instancePath+"/uncommittedFileCount",schemaPath:"#/oneOf/1/properties/uncommittedFileCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data25 < 0 || isNaN(data25)){validate2978.errors = [{instancePath:instancePath+"/uncommittedFileCount",schemaPath:"#/oneOf/1/properties/uncommittedFileCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid15: any = _errs77 === errors;}else {var valid15: any = true;}if(valid15){if(data.unpushedCommitCount !== undefined){let data26: any = data.unpushedCommitCount;const _errs79: any = errors;if(!(((typeof data26 == "number") && (!(data26 % 1) && !isNaN(data26))) && (isFinite(data26)))){validate2978.errors = [{instancePath:instancePath+"/unpushedCommitCount",schemaPath:"#/oneOf/1/properties/unpushedCommitCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs79){if((typeof data26 == "number") && (isFinite(data26))){if(data26 > 9007199254740991 || isNaN(data26)){validate2978.errors = [{instancePath:instancePath+"/unpushedCommitCount",schemaPath:"#/oneOf/1/properties/unpushedCommitCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data26 < 0 || isNaN(data26)){validate2978.errors = [{instancePath:instancePath+"/unpushedCommitCount",schemaPath:"#/oneOf/1/properties/unpushedCommitCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid15: any = _errs79 === errors;}else {var valid15: any = true;}if(valid15){if(data.occupyingSessionIds !== undefined){let data27: any = data.occupyingSessionIds;const _errs81: any = errors;if(errors === _errs81){if(Array.isArray(data27)){var valid16: any = true;const len1: any = data27.length;for(let i1=0; i1<len1; i1++){let data28: any = data27[i1];const _errs83: any = errors;const _errs84: any = errors;if(errors === _errs84){if(typeof data28 === "string"){if(!pattern4.test(data28)){validate2978.errors = [{instancePath:instancePath+"/occupyingSessionIds/" + i1,schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2978.errors = [{instancePath:instancePath+"/occupyingSessionIds/" + i1,schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid16: any = _errs83 === errors;if(!valid16){break;}}}else {validate2978.errors = [{instancePath:instancePath+"/occupyingSessionIds",schemaPath:"#/oneOf/1/properties/occupyingSessionIds/type",keyword:"type",params:{type: "array"}}];return false;}}var valid15: any = _errs81 === errors;}else {var valid15: any = true;}if(valid15){if(data.runningSessionId !== undefined){let data29: any = data.runningSessionId;const _errs87: any = errors;const _errs88: any = errors;let valid18: any = false;const _errs89: any = errors;const _errs90: any = errors;if(errors === _errs90){if(typeof data29 === "string"){if(!pattern4.test(data29)){const err4: any = {instancePath:instancePath+"/runningSessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}}else {const err5: any = {instancePath:instancePath+"/runningSessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}}var _valid1: any = _errs89 === errors;valid18 = valid18 || _valid1;const _errs93: any = errors;if(data29 !== null){const err6: any = {instancePath:instancePath+"/runningSessionId",schemaPath:"#/oneOf/1/properties/runningSessionId/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;}var _valid1: any = _errs93 === errors;valid18 = valid18 || _valid1;if(!valid18){const err7: any = {instancePath:instancePath+"/runningSessionId",schemaPath:"#/oneOf/1/properties/runningSessionId/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;validate2978.errors = vErrors;return false;}else {errors = _errs88;if(vErrors !== null){if(_errs88){vErrors.length = _errs88;}else {vErrors = null;}}}var valid15: any = _errs87 === errors;}else {var valid15: any = true;}}}}}}}}}}}}}else {validate2978.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid14: any = _errs62 === errors;if(props0 !== true){props0 = true;}valid0 = valid14;}else {validate2978.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "madeBy", tagValue: tag0}}];return false;}}else {validate2978.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "madeBy", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key2 in data){if(!props0 || !props0[key2]){validate2978.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key2}}];return false;break;}}}}}else {validate2978.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2978.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2978.errors = null as any[] | null;
// prettier-ignore
validate2978.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2977(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorktreeStatusReadResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2977.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.repoRoot === undefined) && (missing0 = "repoRoot")) || ((data.worktrees === undefined) && (missing0 = "worktrees"))){validate2977.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "repoRoot") || (key0 === "worktrees")) || (key0 === "countsAsOf")) || (key0 === "newWorktree"))){validate2977.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.repoRoot !== undefined){let data0: any = data.repoRoot;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(data0 && typeof data0 == "object" && !Array.isArray(data0)){let missing1: any;if(((data0.path === undefined) && (missing1 = "path")) || ((data0.branchName === undefined) && (missing1 = "branchName"))){validate2977.errors = [{instancePath:instancePath+"/repoRoot",schemaPath:"#/$defs/RepoRootStatus/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs5: any = errors;for(const key1 in data0){if(!((key1 === "path") || (key1 === "branchName"))){validate2977.errors = [{instancePath:instancePath+"/repoRoot",schemaPath:"#/$defs/RepoRootStatus/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs5 === errors){if(data0.path !== undefined){let data1: any = data0.path;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) > 4096){validate2977.errors = [{instancePath:instancePath+"/repoRoot/path",schemaPath:"#/$defs/RepoRootStatus/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data1) < 1){validate2977.errors = [{instancePath:instancePath+"/repoRoot/path",schemaPath:"#/$defs/RepoRootStatus/properties/path/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data1)){validate2977.errors = [{instancePath:instancePath+"/repoRoot/path",schemaPath:"#/$defs/RepoRootStatus/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate2977.errors = [{instancePath:instancePath+"/repoRoot/path",schemaPath:"#/$defs/RepoRootStatus/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs6 === errors;}else {var valid2: any = true;}if(valid2){if(data0.branchName !== undefined){let data2: any = data0.branchName;const _errs8: any = errors;if(errors === _errs8){if(typeof data2 === "string"){if(func1(data2) < 1){validate2977.errors = [{instancePath:instancePath+"/repoRoot/branchName",schemaPath:"#/$defs/RepoRootStatus/properties/branchName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data2)){validate2977.errors = [{instancePath:instancePath+"/repoRoot/branchName",schemaPath:"#/$defs/RepoRootStatus/properties/branchName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate2977.errors = [{instancePath:instancePath+"/repoRoot/branchName",schemaPath:"#/$defs/RepoRootStatus/properties/branchName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}}}}}else {validate2977.errors = [{instancePath:instancePath+"/repoRoot",schemaPath:"#/$defs/RepoRootStatus/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.worktrees !== undefined){let data3: any = data.worktrees;const _errs10: any = errors;if(errors === _errs10){if(Array.isArray(data3)){var valid3: any = true;const len0: any = data3.length;for(let i0=0; i0<len0; i0++){const _errs12: any = errors;if(!(validate2978.call(this, data3[i0], {instancePath:instancePath+"/worktrees/" + i0,parentData:data3,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2978.errors : vErrors.concat(validate2978.errors);errors = vErrors.length;}var valid3: any = _errs12 === errors;if(!valid3){break;}}}else {validate2977.errors = [{instancePath:instancePath+"/worktrees",schemaPath:"#/properties/worktrees/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.countsAsOf !== undefined){let data5: any = data.countsAsOf;const _errs13: any = errors;const _errs14: any = errors;if(errors === _errs14){if(typeof data5 === "string"){if(!pattern5.test(data5)){validate2977.errors = [{instancePath:instancePath+"/countsAsOf",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate2977.errors = [{instancePath:instancePath+"/countsAsOf",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}if(valid0){if(data.newWorktree !== undefined){let data6: any = data.newWorktree;const _errs16: any = errors;const _errs17: any = errors;if(errors === _errs17){if(data6 && typeof data6 == "object" && !Array.isArray(data6)){let missing2: any;if(((data6.fixedPart === undefined) && (missing2 = "fixedPart")) || ((data6.folderBefore === undefined) && (missing2 = "folderBefore"))){validate2977.errors = [{instancePath:instancePath+"/newWorktree",schemaPath:"#/$defs/NewWorktreeSuggestion/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs19: any = errors;for(const key2 in data6){if(!(((key2 === "fixedPart") || (key2 === "suggestedTail")) || (key2 === "folderBefore"))){validate2977.errors = [{instancePath:instancePath+"/newWorktree",schemaPath:"#/$defs/NewWorktreeSuggestion/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs19 === errors){if(data6.fixedPart !== undefined){const _errs20: any = errors;if(typeof data6.fixedPart !== "string"){validate2977.errors = [{instancePath:instancePath+"/newWorktree/fixedPart",schemaPath:"#/$defs/NewWorktreeSuggestion/properties/fixedPart/type",keyword:"type",params:{type: "string"}}];return false;}var valid6: any = _errs20 === errors;}else {var valid6: any = true;}if(valid6){if(data6.suggestedTail !== undefined){let data8: any = data6.suggestedTail;const _errs22: any = errors;if(errors === _errs22){if(typeof data8 === "string"){if(func1(data8) < 1){validate2977.errors = [{instancePath:instancePath+"/newWorktree/suggestedTail",schemaPath:"#/$defs/NewWorktreeSuggestion/properties/suggestedTail/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data8)){validate2977.errors = [{instancePath:instancePath+"/newWorktree/suggestedTail",schemaPath:"#/$defs/NewWorktreeSuggestion/properties/suggestedTail/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate2977.errors = [{instancePath:instancePath+"/newWorktree/suggestedTail",schemaPath:"#/$defs/NewWorktreeSuggestion/properties/suggestedTail/type",keyword:"type",params:{type: "string"}}];return false;}}var valid6: any = _errs22 === errors;}else {var valid6: any = true;}if(valid6){if(data6.folderBefore !== undefined){let data9: any = data6.folderBefore;const _errs24: any = errors;if(errors === _errs24){if(typeof data9 === "string"){if(func1(data9) > 4096){validate2977.errors = [{instancePath:instancePath+"/newWorktree/folderBefore",schemaPath:"#/$defs/NewWorktreeSuggestion/properties/folderBefore/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data9) < 1){validate2977.errors = [{instancePath:instancePath+"/newWorktree/folderBefore",schemaPath:"#/$defs/NewWorktreeSuggestion/properties/folderBefore/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data9)){validate2977.errors = [{instancePath:instancePath+"/newWorktree/folderBefore",schemaPath:"#/$defs/NewWorktreeSuggestion/properties/folderBefore/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate2977.errors = [{instancePath:instancePath+"/newWorktree/folderBefore",schemaPath:"#/$defs/NewWorktreeSuggestion/properties/folderBefore/type",keyword:"type",params:{type: "string"}}];return false;}}var valid6: any = _errs24 === errors;}else {var valid6: any = true;}}}}}}else {validate2977.errors = [{instancePath:instancePath+"/newWorktree",schemaPath:"#/$defs/NewWorktreeSuggestion/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs16 === errors;}else {var valid0: any = true;}}}}}}}else {validate2977.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2977.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2977.errors = null as any[] | null;
// prettier-ignore
validate2977.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link BranchContextId}. */
export const validateBranchContextId: SchemaCheck<BranchContextId> = validate2966;
/** Checks that a value is a {@link WorkspaceExecutionRootPrepareRequest}. */
export const validateWorkspaceExecutionRootPrepareRequest: SchemaCheck<WorkspaceExecutionRootPrepareRequest> =
  validate2967;
/** Checks that a value is a {@link WorkspaceExecutionRootPrepareResponse}. */
export const validateWorkspaceExecutionRootPrepareResponse: SchemaCheck<WorkspaceExecutionRootPrepareResponse> =
  validate2968;
/** Checks that a value is a {@link WorktreeId}. */
export const validateWorktreeId: SchemaCheck<WorktreeId> = validate2969;
/** Checks that a value is a {@link WorktreeLifecyclePayload}. */
export const validateWorktreeLifecyclePayload: SchemaCheck<WorktreeLifecyclePayload> = validate2970;
/** Checks that a value is a {@link WorktreeRetireRequest}. */
export const validateWorktreeRetireRequest: SchemaCheck<WorktreeRetireRequest> = validate2971;
/** Checks that a value is a {@link WorktreeRetireResponse}. */
export const validateWorktreeRetireResponse: SchemaCheck<WorktreeRetireResponse> = validate2972;
/** Checks that a value is a {@link WorktreeState}. */
export const validateWorktreeState: SchemaCheck<WorktreeState> = validate2975;
/** Checks that a value is a {@link WorktreeStatusReadRequest}. */
export const validateWorktreeStatusReadRequest: SchemaCheck<WorktreeStatusReadRequest> =
  validate2976;
/** Checks that a value is a {@link WorktreeStatusReadResponse}. */
export const validateWorktreeStatusReadResponse: SchemaCheck<WorktreeStatusReadResponse> =
  validate2977;
