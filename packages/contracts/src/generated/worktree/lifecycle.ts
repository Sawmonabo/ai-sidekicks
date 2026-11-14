// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A worktree's ids, state and lifecycle payload, and the requests and responses of the worktree methods: preparing an execution root, retiring a tree and the details of its refusals, and reading the project's trees.

import { type CompiledSchemaCheck, ucs2length } from "../../schema-check.js";
import type { AgentId } from "../agent/definition.js";
import { type WireInstant, validateWireInstant } from "../internal/wire-scalars.js";
import { type ProjectId, validateProjectId } from "../project.js";
import {
  type RepoMountId,
  type WorkspaceId,
  type WorkspaceState,
  validateRepoMountId,
  validateWorkspaceId,
  validateWorkspaceState,
} from "../repo/mount.js";
import { type RunId, validateRunId } from "../run/id.js";
import { type SessionId, validateSessionId } from "../session/id.js";
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
const pattern3 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
/** Checks that a value is a {@link WorktreeId}. */
// prettier-ignore
export const validateWorktreeId: CompiledSchemaCheck<WorktreeId> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorktreeId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorktreeId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern3.test(data)){validateWorktreeId.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validateWorktreeId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateWorktreeId.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorktreeId.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link BranchContextId}. */
// prettier-ignore
export const validateBranchContextId: CompiledSchemaCheck<BranchContextId> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is BranchContextId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateBranchContextId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern3.test(data)){validateBranchContextId.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validateBranchContextId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateBranchContextId.errors = vErrors;return errors === 0;};
// prettier-ignore
validateBranchContextId.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link RemovedWorktreeId}. */
// prettier-ignore
export const validateRemovedWorktreeId: CompiledSchemaCheck<RemovedWorktreeId> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is RemovedWorktreeId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateRemovedWorktreeId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern3.test(data)){validateRemovedWorktreeId.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validateRemovedWorktreeId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateRemovedWorktreeId.errors = vErrors;return errors === 0;};
// prettier-ignore
validateRemovedWorktreeId.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema375: any = {"description":"A worktree's lifecycle state. `retired` and `failed` are not live; moving to `failed` emits no\n`worktree.*` event (the failure is evented as `workspace.rootLost`), and failed rows stay\nreadable through `worktree.status.read`.","type":"string","enum":["creating","ready","dirty","merged","retired","failed"]};
/** Checks that a value is a {@link WorktreeState}. */
// prettier-ignore
export const validateWorktreeState: CompiledSchemaCheck<WorktreeState> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorktreeState {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorktreeState.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateWorktreeState.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((((data === "creating") || (data === "ready")) || (data === "dirty")) || (data === "merged")) || (data === "retired")) || (data === "failed"))){validateWorktreeState.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema375.enum}}];return false;}validateWorktreeState.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorktreeState.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1619: any = {"description":"The state of a listed worktree: every state but `retired`, since a retired tree is never listed.\nIt is a wire enum of its own so a client's table keyed by it covers exactly the listed states;\nthe conversion from [`WorktreeState`] matches every state, so the two cannot drift apart.","type":"string","enum":["creating","ready","dirty","merged","failed"]};
/** Checks that a value is a {@link ListedWorktreeState}. */
// prettier-ignore
export const validateListedWorktreeState: CompiledSchemaCheck<ListedWorktreeState> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ListedWorktreeState {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateListedWorktreeState.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateListedWorktreeState.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((((data === "creating") || (data === "ready")) || (data === "dirty")) || (data === "merged")) || (data === "failed"))){validateListedWorktreeState.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1619.enum}}];return false;}validateListedWorktreeState.errors = vErrors;return errors === 0;};
// prettier-ignore
validateListedWorktreeState.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema377: any = {"type":"object","additionalProperties":false,"properties":{"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The envelope's session, repeated so a projector can read the payload alone."},"repoMountId":{"$ref":"sidekicks-contracts:repo/mount#/$defs/RepoMountId","description":"The mount, when it is the subject or beside it."},"workspaceId":{"$ref":"sidekicks-contracts:repo/mount#/$defs/WorkspaceId","description":"The workspace, when it is the subject or beside it."},"worktreeId":{"type":"string","pattern":"^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$","description":"The worktree, when it is the subject."},"state":{"$ref":"#/$defs/WorktreeState","description":"The subject's state after the transition."},"actor":{"type":["string","null"],"minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The envelope's actor, repeated; a system event sends `null` or leaves it out."}},"required":["sessionId","state"],"description":"The payload of a `worktree.*` lifecycle event; the emitter sets `worktreeId` on every one."};
// prettier-ignore
const pattern5 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
const func1 = ucs2length;
/** Checks that a value is a {@link WorktreeLifecyclePayload}. */
// prettier-ignore
export const validateWorktreeLifecyclePayload: CompiledSchemaCheck<WorktreeLifecyclePayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorktreeLifecyclePayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorktreeLifecyclePayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.state === undefined) && (missing0 = "state"))){validateWorktreeLifecyclePayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((key0 === "sessionId") || (key0 === "repoMountId")) || (key0 === "workspaceId")) || (key0 === "worktreeId")) || (key0 === "state")) || (key0 === "actor"))){validateWorktreeLifecyclePayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.repoMountId !== undefined){const _errs3: any = errors;if(!(validateRepoMountId.call(this, data.repoMountId, {instancePath:instancePath+"/repoMountId",parentData:data,parentDataProperty:"repoMountId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRepoMountId.errors : vErrors.concat(validateRepoMountId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.workspaceId !== undefined){const _errs4: any = errors;if(!(validateWorkspaceId.call(this, data.workspaceId, {instancePath:instancePath+"/workspaceId",parentData:data,parentDataProperty:"workspaceId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkspaceId.errors : vErrors.concat(validateWorkspaceId.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.worktreeId !== undefined){let data3: any = data.worktreeId;const _errs5: any = errors;if(errors === _errs5){if(typeof data3 === "string"){if(!pattern3.test(data3)){validateWorktreeLifecyclePayload.errors = [{instancePath:instancePath+"/worktreeId",schemaPath:"#/properties/worktreeId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validateWorktreeLifecyclePayload.errors = [{instancePath:instancePath+"/worktreeId",schemaPath:"#/properties/worktreeId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){const _errs7: any = errors;if(!(validateWorktreeState.call(this, data.state, {instancePath:instancePath+"/state",parentData:data,parentDataProperty:"state",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorktreeState.errors : vErrors.concat(validateWorktreeState.errors);errors = vErrors.length;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.actor !== undefined){let data5: any = data.actor;const _errs8: any = errors;if((typeof data5 !== "string") && (data5 !== null)){validateWorktreeLifecyclePayload.errors = [{instancePath:instancePath+"/actor",schemaPath:"#/properties/actor/type",keyword:"type",params:{type: schema377.properties.actor.type}}];return false;}if(errors === _errs8){if(typeof data5 === "string"){if(func1(data5) > 256){validateWorktreeLifecyclePayload.errors = [{instancePath:instancePath+"/actor",schemaPath:"#/properties/actor/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data5) < 1){validateWorktreeLifecyclePayload.errors = [{instancePath:instancePath+"/actor",schemaPath:"#/properties/actor/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data5)){validateWorktreeLifecyclePayload.errors = [{instancePath:instancePath+"/actor",schemaPath:"#/properties/actor/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}}}}}}}}}else {validateWorktreeLifecyclePayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorktreeLifecyclePayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorktreeLifecyclePayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkspaceExecutionRootPrepareRequest}. */
// prettier-ignore
export const validateWorkspaceExecutionRootPrepareRequest: CompiledSchemaCheck<WorkspaceExecutionRootPrepareRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkspaceExecutionRootPrepareRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkspaceExecutionRootPrepareRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.workspaceId === undefined) && (missing0 = "workspaceId")){validateWorkspaceExecutionRootPrepareRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "workspaceId") || (key0 === "branchName")) || (key0 === "baseRef")) || (key0 === "carryUncommitted"))){validateWorkspaceExecutionRootPrepareRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.workspaceId !== undefined){const _errs2: any = errors;if(!(validateWorkspaceId.call(this, data.workspaceId, {instancePath:instancePath+"/workspaceId",parentData:data,parentDataProperty:"workspaceId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkspaceId.errors : vErrors.concat(validateWorkspaceId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.branchName !== undefined){let data1: any = data.branchName;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) < 1){validateWorkspaceExecutionRootPrepareRequest.errors = [{instancePath:instancePath+"/branchName",schemaPath:"#/properties/branchName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data1)){validateWorkspaceExecutionRootPrepareRequest.errors = [{instancePath:instancePath+"/branchName",schemaPath:"#/properties/branchName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validateWorkspaceExecutionRootPrepareRequest.errors = [{instancePath:instancePath+"/branchName",schemaPath:"#/properties/branchName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.baseRef !== undefined){let data2: any = data.baseRef;const _errs5: any = errors;if(errors === _errs5){if(typeof data2 === "string"){if(func1(data2) < 1){validateWorkspaceExecutionRootPrepareRequest.errors = [{instancePath:instancePath+"/baseRef",schemaPath:"#/properties/baseRef/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data2)){validateWorkspaceExecutionRootPrepareRequest.errors = [{instancePath:instancePath+"/baseRef",schemaPath:"#/properties/baseRef/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validateWorkspaceExecutionRootPrepareRequest.errors = [{instancePath:instancePath+"/baseRef",schemaPath:"#/properties/baseRef/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.carryUncommitted !== undefined){const _errs7: any = errors;if(typeof data.carryUncommitted !== "boolean"){validateWorkspaceExecutionRootPrepareRequest.errors = [{instancePath:instancePath+"/carryUncommitted",schemaPath:"#/properties/carryUncommitted/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}}}}}}}else {validateWorkspaceExecutionRootPrepareRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkspaceExecutionRootPrepareRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkspaceExecutionRootPrepareRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern33 = new RegExp("^[^\\x00]*$", "u");
/** Checks that a value is a {@link WorkspaceExecutionRootPrepareResponse}. */
// prettier-ignore
export const validateWorkspaceExecutionRootPrepareResponse: CompiledSchemaCheck<WorkspaceExecutionRootPrepareResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkspaceExecutionRootPrepareResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkspaceExecutionRootPrepareResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.executionRoot === undefined) && (missing0 = "executionRoot")) || ((data.state === undefined) && (missing0 = "state"))) || ((data.branchContextId === undefined) && (missing0 = "branchContextId"))){validateWorkspaceExecutionRootPrepareResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "executionRoot") || (key0 === "state")) || (key0 === "worktreeId")) || (key0 === "branchContextId"))){validateWorkspaceExecutionRootPrepareResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.executionRoot !== undefined){let data0: any = data.executionRoot;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 4096){validateWorkspaceExecutionRootPrepareResponse.errors = [{instancePath:instancePath+"/executionRoot",schemaPath:"#/properties/executionRoot/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data0) < 1){validateWorkspaceExecutionRootPrepareResponse.errors = [{instancePath:instancePath+"/executionRoot",schemaPath:"#/properties/executionRoot/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern33.test(data0)){validateWorkspaceExecutionRootPrepareResponse.errors = [{instancePath:instancePath+"/executionRoot",schemaPath:"#/properties/executionRoot/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validateWorkspaceExecutionRootPrepareResponse.errors = [{instancePath:instancePath+"/executionRoot",schemaPath:"#/properties/executionRoot/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){const _errs4: any = errors;if(!(validateWorkspaceState.call(this, data.state, {instancePath:instancePath+"/state",parentData:data,parentDataProperty:"state",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkspaceState.errors : vErrors.concat(validateWorkspaceState.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.worktreeId !== undefined){const _errs5: any = errors;if(!(validateWorktreeId.call(this, data.worktreeId, {instancePath:instancePath+"/worktreeId",parentData:data,parentDataProperty:"worktreeId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorktreeId.errors : vErrors.concat(validateWorktreeId.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.branchContextId !== undefined){const _errs6: any = errors;if(!(validateBranchContextId.call(this, data.branchContextId, {instancePath:instancePath+"/branchContextId",parentData:data,parentDataProperty:"branchContextId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateBranchContextId.errors : vErrors.concat(validateBranchContextId.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}}else {validateWorkspaceExecutionRootPrepareResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkspaceExecutionRootPrepareResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkspaceExecutionRootPrepareResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorktreeRetireRequest}. */
// prettier-ignore
export const validateWorktreeRetireRequest: CompiledSchemaCheck<WorktreeRetireRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorktreeRetireRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorktreeRetireRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.worktreeId === undefined) && (missing0 = "worktreeId")) || ((data.discard === undefined) && (missing0 = "discard"))){validateWorktreeRetireRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "worktreeId") || (key0 === "discard"))){validateWorktreeRetireRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.worktreeId !== undefined){const _errs2: any = errors;if(!(validateWorktreeId.call(this, data.worktreeId, {instancePath:instancePath+"/worktreeId",parentData:data,parentDataProperty:"worktreeId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorktreeId.errors : vErrors.concat(validateWorktreeId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.discard !== undefined){const _errs3: any = errors;if(typeof data.discard !== "boolean"){validateWorktreeRetireRequest.errors = [{instancePath:instancePath+"/discard",schemaPath:"#/properties/discard/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateWorktreeRetireRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorktreeRetireRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorktreeRetireRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link KeptWorktree}. */
// prettier-ignore
export const validateKeptWorktree: CompiledSchemaCheck<KeptWorktree> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is KeptWorktree {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateKeptWorktree.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.removedWorktreeId === undefined) && (missing0 = "removedWorktreeId")){validateKeptWorktree.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "removedWorktreeId")){validateKeptWorktree.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.removedWorktreeId !== undefined){if(!(validateRemovedWorktreeId.call(this, data.removedWorktreeId, {instancePath:instancePath+"/removedWorktreeId",parentData:data,parentDataProperty:"removedWorktreeId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRemovedWorktreeId.errors : vErrors.concat(validateRemovedWorktreeId.errors);errors = vErrors.length;}}}}}else {validateKeptWorktree.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateKeptWorktree.errors = vErrors;return errors === 0;};
// prettier-ignore
validateKeptWorktree.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1613: any = {"type":"object","additionalProperties":false,"properties":{"worktreeId":{"$ref":"#/$defs/WorktreeId","description":"The worktree."},"state":{"description":"Its state.","type":"string","enum":["retired"]},"kept":{"$ref":"#/$defs/KeptWorktree","description":"The kept copy."}},"required":["worktreeId","state"],"description":"The `worktree.retire` result: the worktree, now `retired`, and the kept copy when a discard\nkept one. A refusal is an error, never a reply with the unchanged state."};
/** Checks that a value is a {@link WorktreeRetireResponse}. */
// prettier-ignore
export const validateWorktreeRetireResponse: CompiledSchemaCheck<WorktreeRetireResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorktreeRetireResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorktreeRetireResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.worktreeId === undefined) && (missing0 = "worktreeId")) || ((data.state === undefined) && (missing0 = "state"))){validateWorktreeRetireResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "worktreeId") || (key0 === "state")) || (key0 === "kept"))){validateWorktreeRetireResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.worktreeId !== undefined){const _errs2: any = errors;if(!(validateWorktreeId.call(this, data.worktreeId, {instancePath:instancePath+"/worktreeId",parentData:data,parentDataProperty:"worktreeId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorktreeId.errors : vErrors.concat(validateWorktreeId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){let data1: any = data.state;const _errs3: any = errors;if(typeof data1 !== "string"){validateWorktreeRetireResponse.errors = [{instancePath:instancePath+"/state",schemaPath:"#/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data1 === "retired")){validateWorktreeRetireResponse.errors = [{instancePath:instancePath+"/state",schemaPath:"#/properties/state/enum",keyword:"enum",params:{allowedValues: schema1613.properties.state.enum}}];return false;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.kept !== undefined){const _errs5: any = errors;if(!(validateKeptWorktree.call(this, data.kept, {instancePath:instancePath+"/kept",parentData:data,parentDataProperty:"kept",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateKeptWorktree.errors : vErrors.concat(validateKeptWorktree.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}}else {validateWorktreeRetireResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorktreeRetireResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorktreeRetireResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1618: any = {"oneOf":[{"type":"object","additionalProperties":false,"properties":{"madeBy":{"type":"string","const":"app"},"worktreeId":{"$ref":"#/$defs/WorktreeId","description":"The worktree."},"repoMountId":{"$ref":"sidekicks-contracts:repo/mount#/$defs/RepoMountId","description":"Its mount."},"baseBranchName":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","description":"The branch it was made from."},"state":{"$ref":"#/$defs/ListedWorktreeState","description":"Its state."},"createdBySessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session that made it."},"createdByRunId":{"$ref":"sidekicks-contracts:run/id#/$defs/RunId","description":"The run that made it; absent for a tree prepared before any run."},"createdAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When it was made."},"updatedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When it last changed."},"path":{"type":"string","maxLength":4096,"pattern":"^[^\\x00]*$","minLength":1,"description":"The tree's folder."},"name":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":4096,"description":"Its name."},"branchName":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","description":"Its branch."},"ahead":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"Commits ahead of the upstream as of the last fetch; absent with no upstream."},"behind":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"Commits behind the upstream as of the last fetch; absent with no upstream."},"uncommittedFileCount":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"Uncommitted files."},"unpushedCommitCount":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"Commits no remote-tracking branch reaches."},"occupyingSessionIds":{"type":"array","items":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId"},"description":"The sessions standing in it."},"runningSessionId":{"anyOf":[{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId"},{"type":"null"}],"description":"The session whose agent runs in it, which locks its removal, or `null`."}},"required":["madeBy","worktreeId","repoMountId","baseBranchName","state","createdBySessionId","createdAt","updatedAt","path","name","branchName","uncommittedFileCount","unpushedCommitCount","occupyingSessionIds","runningSessionId"],"description":"A tree the app made, with its record."},{"type":"object","additionalProperties":false,"properties":{"madeBy":{"type":"string","const":"person"},"path":{"type":"string","maxLength":4096,"pattern":"^[^\\x00]*$","minLength":1,"description":"The tree's folder."},"name":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":4096,"description":"Its name."},"branchName":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","description":"Its branch."},"ahead":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"Commits ahead of the upstream as of the last fetch; absent with no upstream."},"behind":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"Commits behind the upstream as of the last fetch; absent with no upstream."},"uncommittedFileCount":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"Uncommitted files."},"unpushedCommitCount":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"Commits no remote-tracking branch reaches."},"occupyingSessionIds":{"type":"array","items":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId"},"description":"The sessions standing in it."},"runningSessionId":{"anyOf":[{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId"},{"type":"null"}],"description":"The session whose agent runs in it, which locks its removal, or `null`."}},"required":["madeBy","path","name","branchName","uncommittedFileCount","unpushedCommitCount","occupyingSessionIds","runningSessionId"],"description":"A tree the person made."}],"description":"One worktree git lists for the repository, with every figure its switcher row draws;\n`path` is the folder `session.workingFolder.update` takes. A tree the app made carries\nits record, and one the person made carries none and has no removal of its own.","discriminator":{"propertyName":"madeBy"},"type":"object","unevaluatedProperties":false};
// prettier-ignore
const func2 = Object.prototype.hasOwnProperty;
/** Checks that a value is a {@link WorktreeStatusRecord}. */
// prettier-ignore
export const validateWorktreeStatusRecord: CompiledSchemaCheck<WorktreeStatusRecord> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorktreeStatusRecord {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorktreeStatusRecord.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.madeBy;if(typeof tag0 == "string"){if(tag0 === "app"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((((((((((((data.madeBy === undefined) && (missing0 = "madeBy")) || ((data.worktreeId === undefined) && (missing0 = "worktreeId"))) || ((data.repoMountId === undefined) && (missing0 = "repoMountId"))) || ((data.baseBranchName === undefined) && (missing0 = "baseBranchName"))) || ((data.state === undefined) && (missing0 = "state"))) || ((data.createdBySessionId === undefined) && (missing0 = "createdBySessionId"))) || ((data.createdAt === undefined) && (missing0 = "createdAt"))) || ((data.updatedAt === undefined) && (missing0 = "updatedAt"))) || ((data.path === undefined) && (missing0 = "path"))) || ((data.name === undefined) && (missing0 = "name"))) || ((data.branchName === undefined) && (missing0 = "branchName"))) || ((data.uncommittedFileCount === undefined) && (missing0 = "uncommittedFileCount"))) || ((data.unpushedCommitCount === undefined) && (missing0 = "unpushedCommitCount"))) || ((data.occupyingSessionIds === undefined) && (missing0 = "occupyingSessionIds"))) || ((data.runningSessionId === undefined) && (missing0 = "runningSessionId"))){validateWorktreeStatusRecord.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!(func2.call(schema1618.oneOf[0].properties, key0))){validateWorktreeStatusRecord.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.madeBy !== undefined){let data0: any = data.madeBy;const _errs5: any = errors;if(typeof data0 !== "string"){validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/madeBy",schemaPath:"#/oneOf/0/properties/madeBy/type",keyword:"type",params:{type: "string"}}];return false;}if("app" !== data0){validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/madeBy",schemaPath:"#/oneOf/0/properties/madeBy/const",keyword:"const",params:{allowedValue: "app"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.worktreeId !== undefined){const _errs7: any = errors;if(!(validateWorktreeId.call(this, data.worktreeId, {instancePath:instancePath+"/worktreeId",parentData:data,parentDataProperty:"worktreeId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorktreeId.errors : vErrors.concat(validateWorktreeId.errors);errors = vErrors.length;}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.repoMountId !== undefined){const _errs8: any = errors;if(!(validateRepoMountId.call(this, data.repoMountId, {instancePath:instancePath+"/repoMountId",parentData:data,parentDataProperty:"repoMountId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRepoMountId.errors : vErrors.concat(validateRepoMountId.errors);errors = vErrors.length;}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}if(valid2){if(data.baseBranchName !== undefined){let data3: any = data.baseBranchName;const _errs9: any = errors;if(errors === _errs9){if(typeof data3 === "string"){if(func1(data3) < 1){validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/baseBranchName",schemaPath:"#/oneOf/0/properties/baseBranchName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data3)){validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/baseBranchName",schemaPath:"#/oneOf/0/properties/baseBranchName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/baseBranchName",schemaPath:"#/oneOf/0/properties/baseBranchName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs9 === errors;}else {var valid2: any = true;}if(valid2){if(data.state !== undefined){const _errs11: any = errors;if(!(validateListedWorktreeState.call(this, data.state, {instancePath:instancePath+"/state",parentData:data,parentDataProperty:"state",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateListedWorktreeState.errors : vErrors.concat(validateListedWorktreeState.errors);errors = vErrors.length;}var valid2: any = _errs11 === errors;}else {var valid2: any = true;}if(valid2){if(data.createdBySessionId !== undefined){const _errs12: any = errors;if(!(validateSessionId.call(this, data.createdBySessionId, {instancePath:instancePath+"/createdBySessionId",parentData:data,parentDataProperty:"createdBySessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid2: any = _errs12 === errors;}else {var valid2: any = true;}if(valid2){if(data.createdByRunId !== undefined){const _errs13: any = errors;if(!(validateRunId.call(this, data.createdByRunId, {instancePath:instancePath+"/createdByRunId",parentData:data,parentDataProperty:"createdByRunId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunId.errors : vErrors.concat(validateRunId.errors);errors = vErrors.length;}var valid2: any = _errs13 === errors;}else {var valid2: any = true;}if(valid2){if(data.createdAt !== undefined){const _errs14: any = errors;if(!(validateWireInstant.call(this, data.createdAt, {instancePath:instancePath+"/createdAt",parentData:data,parentDataProperty:"createdAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid2: any = _errs14 === errors;}else {var valid2: any = true;}if(valid2){if(data.updatedAt !== undefined){const _errs15: any = errors;if(!(validateWireInstant.call(this, data.updatedAt, {instancePath:instancePath+"/updatedAt",parentData:data,parentDataProperty:"updatedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid2: any = _errs15 === errors;}else {var valid2: any = true;}if(valid2){if(data.path !== undefined){let data9: any = data.path;const _errs16: any = errors;if(errors === _errs16){if(typeof data9 === "string"){if(func1(data9) > 4096){validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/path",schemaPath:"#/oneOf/0/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data9) < 1){validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/path",schemaPath:"#/oneOf/0/properties/path/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern33.test(data9)){validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/path",schemaPath:"#/oneOf/0/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/path",schemaPath:"#/oneOf/0/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs16 === errors;}else {var valid2: any = true;}if(valid2){if(data.name !== undefined){let data10: any = data.name;const _errs18: any = errors;if(errors === _errs18){if(typeof data10 === "string"){if(func1(data10) > 4096){validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/0/properties/name/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data10) < 1){validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/0/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data10)){validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/0/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/0/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs18 === errors;}else {var valid2: any = true;}if(valid2){if(data.branchName !== undefined){let data11: any = data.branchName;const _errs20: any = errors;if(errors === _errs20){if(typeof data11 === "string"){if(func1(data11) < 1){validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/branchName",schemaPath:"#/oneOf/0/properties/branchName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data11)){validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/branchName",schemaPath:"#/oneOf/0/properties/branchName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/branchName",schemaPath:"#/oneOf/0/properties/branchName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs20 === errors;}else {var valid2: any = true;}if(valid2){if(data.ahead !== undefined){let data12: any = data.ahead;const _errs22: any = errors;if(!(((typeof data12 == "number") && (!(data12 % 1) && !isNaN(data12))) && (isFinite(data12)))){validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/ahead",schemaPath:"#/oneOf/0/properties/ahead/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs22){if((typeof data12 == "number") && (isFinite(data12))){if(data12 > 9007199254740991 || isNaN(data12)){validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/ahead",schemaPath:"#/oneOf/0/properties/ahead/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data12 < 0 || isNaN(data12)){validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/ahead",schemaPath:"#/oneOf/0/properties/ahead/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs22 === errors;}else {var valid2: any = true;}if(valid2){if(data.behind !== undefined){let data13: any = data.behind;const _errs24: any = errors;if(!(((typeof data13 == "number") && (!(data13 % 1) && !isNaN(data13))) && (isFinite(data13)))){validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/behind",schemaPath:"#/oneOf/0/properties/behind/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs24){if((typeof data13 == "number") && (isFinite(data13))){if(data13 > 9007199254740991 || isNaN(data13)){validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/behind",schemaPath:"#/oneOf/0/properties/behind/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data13 < 0 || isNaN(data13)){validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/behind",schemaPath:"#/oneOf/0/properties/behind/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs24 === errors;}else {var valid2: any = true;}if(valid2){if(data.uncommittedFileCount !== undefined){let data14: any = data.uncommittedFileCount;const _errs26: any = errors;if(!(((typeof data14 == "number") && (!(data14 % 1) && !isNaN(data14))) && (isFinite(data14)))){validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/uncommittedFileCount",schemaPath:"#/oneOf/0/properties/uncommittedFileCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs26){if((typeof data14 == "number") && (isFinite(data14))){if(data14 > 9007199254740991 || isNaN(data14)){validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/uncommittedFileCount",schemaPath:"#/oneOf/0/properties/uncommittedFileCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data14 < 0 || isNaN(data14)){validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/uncommittedFileCount",schemaPath:"#/oneOf/0/properties/uncommittedFileCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs26 === errors;}else {var valid2: any = true;}if(valid2){if(data.unpushedCommitCount !== undefined){let data15: any = data.unpushedCommitCount;const _errs28: any = errors;if(!(((typeof data15 == "number") && (!(data15 % 1) && !isNaN(data15))) && (isFinite(data15)))){validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/unpushedCommitCount",schemaPath:"#/oneOf/0/properties/unpushedCommitCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs28){if((typeof data15 == "number") && (isFinite(data15))){if(data15 > 9007199254740991 || isNaN(data15)){validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/unpushedCommitCount",schemaPath:"#/oneOf/0/properties/unpushedCommitCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data15 < 0 || isNaN(data15)){validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/unpushedCommitCount",schemaPath:"#/oneOf/0/properties/unpushedCommitCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs28 === errors;}else {var valid2: any = true;}if(valid2){if(data.occupyingSessionIds !== undefined){let data16: any = data.occupyingSessionIds;const _errs30: any = errors;if(errors === _errs30){if(Array.isArray(data16)){var valid3: any = true;const len0: any = data16.length;for(let i0=0; i0<len0; i0++){const _errs32: any = errors;if(!(validateSessionId.call(this, data16[i0], {instancePath:instancePath+"/occupyingSessionIds/" + i0,parentData:data16,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid3: any = _errs32 === errors;if(!valid3){break;}}}else {validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/occupyingSessionIds",schemaPath:"#/oneOf/0/properties/occupyingSessionIds/type",keyword:"type",params:{type: "array"}}];return false;}}var valid2: any = _errs30 === errors;}else {var valid2: any = true;}if(valid2){if(data.runningSessionId !== undefined){let data18: any = data.runningSessionId;const _errs33: any = errors;const _errs34: any = errors;let valid4: any = false;const _errs35: any = errors;if(!(validateSessionId.call(this, data18, {instancePath:instancePath+"/runningSessionId",parentData:data,parentDataProperty:"runningSessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var _valid0: any = _errs35 === errors;valid4 = valid4 || _valid0;const _errs36: any = errors;if(data18 !== null){const err0: any = {instancePath:instancePath+"/runningSessionId",schemaPath:"#/oneOf/0/properties/runningSessionId/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var _valid0: any = _errs36 === errors;valid4 = valid4 || _valid0;if(!valid4){const err1: any = {instancePath:instancePath+"/runningSessionId",schemaPath:"#/oneOf/0/properties/runningSessionId/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;validateWorktreeStatusRecord.errors = vErrors;return false;}else {errors = _errs34;if(vErrors !== null){if(_errs34){vErrors.length = _errs34;}else {vErrors = null;}}}var valid2: any = _errs33 === errors;}else {var valid2: any = true;}}}}}}}}}}}}}}}}}}}}}else {validateWorktreeStatusRecord.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "person"){const _errs38: any = errors;if(errors === _errs38){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((((((((data.madeBy === undefined) && (missing1 = "madeBy")) || ((data.path === undefined) && (missing1 = "path"))) || ((data.name === undefined) && (missing1 = "name"))) || ((data.branchName === undefined) && (missing1 = "branchName"))) || ((data.uncommittedFileCount === undefined) && (missing1 = "uncommittedFileCount"))) || ((data.unpushedCommitCount === undefined) && (missing1 = "unpushedCommitCount"))) || ((data.occupyingSessionIds === undefined) && (missing1 = "occupyingSessionIds"))) || ((data.runningSessionId === undefined) && (missing1 = "runningSessionId"))){validateWorktreeStatusRecord.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs40: any = errors;for(const key1 in data){if(!(func2.call(schema1618.oneOf[1].properties, key1))){validateWorktreeStatusRecord.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs40 === errors){if(data.madeBy !== undefined){let data19: any = data.madeBy;const _errs41: any = errors;if(typeof data19 !== "string"){validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/madeBy",schemaPath:"#/oneOf/1/properties/madeBy/type",keyword:"type",params:{type: "string"}}];return false;}if("person" !== data19){validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/madeBy",schemaPath:"#/oneOf/1/properties/madeBy/const",keyword:"const",params:{allowedValue: "person"}}];return false;}var valid6: any = _errs41 === errors;}else {var valid6: any = true;}if(valid6){if(data.path !== undefined){let data20: any = data.path;const _errs43: any = errors;if(errors === _errs43){if(typeof data20 === "string"){if(func1(data20) > 4096){validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/path",schemaPath:"#/oneOf/1/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data20) < 1){validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/path",schemaPath:"#/oneOf/1/properties/path/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern33.test(data20)){validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/path",schemaPath:"#/oneOf/1/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/path",schemaPath:"#/oneOf/1/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}var valid6: any = _errs43 === errors;}else {var valid6: any = true;}if(valid6){if(data.name !== undefined){let data21: any = data.name;const _errs45: any = errors;if(errors === _errs45){if(typeof data21 === "string"){if(func1(data21) > 4096){validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/1/properties/name/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data21) < 1){validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/1/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data21)){validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/1/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/1/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid6: any = _errs45 === errors;}else {var valid6: any = true;}if(valid6){if(data.branchName !== undefined){let data22: any = data.branchName;const _errs47: any = errors;if(errors === _errs47){if(typeof data22 === "string"){if(func1(data22) < 1){validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/branchName",schemaPath:"#/oneOf/1/properties/branchName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data22)){validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/branchName",schemaPath:"#/oneOf/1/properties/branchName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/branchName",schemaPath:"#/oneOf/1/properties/branchName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid6: any = _errs47 === errors;}else {var valid6: any = true;}if(valid6){if(data.ahead !== undefined){let data23: any = data.ahead;const _errs49: any = errors;if(!(((typeof data23 == "number") && (!(data23 % 1) && !isNaN(data23))) && (isFinite(data23)))){validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/ahead",schemaPath:"#/oneOf/1/properties/ahead/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs49){if((typeof data23 == "number") && (isFinite(data23))){if(data23 > 9007199254740991 || isNaN(data23)){validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/ahead",schemaPath:"#/oneOf/1/properties/ahead/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data23 < 0 || isNaN(data23)){validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/ahead",schemaPath:"#/oneOf/1/properties/ahead/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid6: any = _errs49 === errors;}else {var valid6: any = true;}if(valid6){if(data.behind !== undefined){let data24: any = data.behind;const _errs51: any = errors;if(!(((typeof data24 == "number") && (!(data24 % 1) && !isNaN(data24))) && (isFinite(data24)))){validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/behind",schemaPath:"#/oneOf/1/properties/behind/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs51){if((typeof data24 == "number") && (isFinite(data24))){if(data24 > 9007199254740991 || isNaN(data24)){validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/behind",schemaPath:"#/oneOf/1/properties/behind/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data24 < 0 || isNaN(data24)){validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/behind",schemaPath:"#/oneOf/1/properties/behind/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid6: any = _errs51 === errors;}else {var valid6: any = true;}if(valid6){if(data.uncommittedFileCount !== undefined){let data25: any = data.uncommittedFileCount;const _errs53: any = errors;if(!(((typeof data25 == "number") && (!(data25 % 1) && !isNaN(data25))) && (isFinite(data25)))){validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/uncommittedFileCount",schemaPath:"#/oneOf/1/properties/uncommittedFileCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs53){if((typeof data25 == "number") && (isFinite(data25))){if(data25 > 9007199254740991 || isNaN(data25)){validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/uncommittedFileCount",schemaPath:"#/oneOf/1/properties/uncommittedFileCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data25 < 0 || isNaN(data25)){validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/uncommittedFileCount",schemaPath:"#/oneOf/1/properties/uncommittedFileCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid6: any = _errs53 === errors;}else {var valid6: any = true;}if(valid6){if(data.unpushedCommitCount !== undefined){let data26: any = data.unpushedCommitCount;const _errs55: any = errors;if(!(((typeof data26 == "number") && (!(data26 % 1) && !isNaN(data26))) && (isFinite(data26)))){validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/unpushedCommitCount",schemaPath:"#/oneOf/1/properties/unpushedCommitCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs55){if((typeof data26 == "number") && (isFinite(data26))){if(data26 > 9007199254740991 || isNaN(data26)){validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/unpushedCommitCount",schemaPath:"#/oneOf/1/properties/unpushedCommitCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data26 < 0 || isNaN(data26)){validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/unpushedCommitCount",schemaPath:"#/oneOf/1/properties/unpushedCommitCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid6: any = _errs55 === errors;}else {var valid6: any = true;}if(valid6){if(data.occupyingSessionIds !== undefined){let data27: any = data.occupyingSessionIds;const _errs57: any = errors;if(errors === _errs57){if(Array.isArray(data27)){var valid7: any = true;const len1: any = data27.length;for(let i1=0; i1<len1; i1++){const _errs59: any = errors;if(!(validateSessionId.call(this, data27[i1], {instancePath:instancePath+"/occupyingSessionIds/" + i1,parentData:data27,parentDataProperty:i1,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid7: any = _errs59 === errors;if(!valid7){break;}}}else {validateWorktreeStatusRecord.errors = [{instancePath:instancePath+"/occupyingSessionIds",schemaPath:"#/oneOf/1/properties/occupyingSessionIds/type",keyword:"type",params:{type: "array"}}];return false;}}var valid6: any = _errs57 === errors;}else {var valid6: any = true;}if(valid6){if(data.runningSessionId !== undefined){let data29: any = data.runningSessionId;const _errs60: any = errors;const _errs61: any = errors;let valid8: any = false;const _errs62: any = errors;if(!(validateSessionId.call(this, data29, {instancePath:instancePath+"/runningSessionId",parentData:data,parentDataProperty:"runningSessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var _valid1: any = _errs62 === errors;valid8 = valid8 || _valid1;const _errs63: any = errors;if(data29 !== null){const err2: any = {instancePath:instancePath+"/runningSessionId",schemaPath:"#/oneOf/1/properties/runningSessionId/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}var _valid1: any = _errs63 === errors;valid8 = valid8 || _valid1;if(!valid8){const err3: any = {instancePath:instancePath+"/runningSessionId",schemaPath:"#/oneOf/1/properties/runningSessionId/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;validateWorktreeStatusRecord.errors = vErrors;return false;}else {errors = _errs61;if(vErrors !== null){if(_errs61){vErrors.length = _errs61;}else {vErrors = null;}}}var valid6: any = _errs60 === errors;}else {var valid6: any = true;}}}}}}}}}}}}}else {validateWorktreeStatusRecord.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid5: any = _errs38 === errors;if(props0 !== true){props0 = true;}valid0 = valid5;}else {validateWorktreeStatusRecord.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "madeBy", tagValue: tag0}}];return false;}}else {validateWorktreeStatusRecord.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "madeBy", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key2 in data){if(!props0 || !props0[key2]){validateWorktreeStatusRecord.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key2}}];return false;break;}}}}}else {validateWorktreeStatusRecord.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorktreeStatusRecord.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorktreeStatusRecord.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorktreeStatusReadRequest}. */
// prettier-ignore
export const validateWorktreeStatusReadRequest: CompiledSchemaCheck<WorktreeStatusReadRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorktreeStatusReadRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorktreeStatusReadRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.projectId === undefined) && (missing0 = "projectId")){validateWorktreeStatusReadRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "projectId") || (key0 === "sessionId"))){validateWorktreeStatusReadRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.projectId !== undefined){const _errs2: any = errors;if(!(validateProjectId.call(this, data.projectId, {instancePath:instancePath+"/projectId",parentData:data,parentDataProperty:"projectId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProjectId.errors : vErrors.concat(validateProjectId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.sessionId !== undefined){const _errs3: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateWorktreeStatusReadRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorktreeStatusReadRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorktreeStatusReadRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link NewWorktreeSuggestion}. */
// prettier-ignore
export const validateNewWorktreeSuggestion: CompiledSchemaCheck<NewWorktreeSuggestion> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is NewWorktreeSuggestion {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateNewWorktreeSuggestion.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.fixedPart === undefined) && (missing0 = "fixedPart")) || ((data.folderBefore === undefined) && (missing0 = "folderBefore"))){validateNewWorktreeSuggestion.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "fixedPart") || (key0 === "suggestedTail")) || (key0 === "folderBefore"))){validateNewWorktreeSuggestion.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.fixedPart !== undefined){const _errs2: any = errors;if(typeof data.fixedPart !== "string"){validateNewWorktreeSuggestion.errors = [{instancePath:instancePath+"/fixedPart",schemaPath:"#/properties/fixedPart/type",keyword:"type",params:{type: "string"}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.suggestedTail !== undefined){let data1: any = data.suggestedTail;const _errs4: any = errors;if(errors === _errs4){if(typeof data1 === "string"){if(func1(data1) < 1){validateNewWorktreeSuggestion.errors = [{instancePath:instancePath+"/suggestedTail",schemaPath:"#/properties/suggestedTail/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data1)){validateNewWorktreeSuggestion.errors = [{instancePath:instancePath+"/suggestedTail",schemaPath:"#/properties/suggestedTail/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validateNewWorktreeSuggestion.errors = [{instancePath:instancePath+"/suggestedTail",schemaPath:"#/properties/suggestedTail/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.folderBefore !== undefined){let data2: any = data.folderBefore;const _errs6: any = errors;if(errors === _errs6){if(typeof data2 === "string"){if(func1(data2) > 4096){validateNewWorktreeSuggestion.errors = [{instancePath:instancePath+"/folderBefore",schemaPath:"#/properties/folderBefore/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data2) < 1){validateNewWorktreeSuggestion.errors = [{instancePath:instancePath+"/folderBefore",schemaPath:"#/properties/folderBefore/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern33.test(data2)){validateNewWorktreeSuggestion.errors = [{instancePath:instancePath+"/folderBefore",schemaPath:"#/properties/folderBefore/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validateNewWorktreeSuggestion.errors = [{instancePath:instancePath+"/folderBefore",schemaPath:"#/properties/folderBefore/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}else {validateNewWorktreeSuggestion.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateNewWorktreeSuggestion.errors = vErrors;return errors === 0;};
// prettier-ignore
validateNewWorktreeSuggestion.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link RepoRootStatus}. */
// prettier-ignore
export const validateRepoRootStatus: CompiledSchemaCheck<RepoRootStatus> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is RepoRootStatus {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateRepoRootStatus.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.path === undefined) && (missing0 = "path")) || ((data.branchName === undefined) && (missing0 = "branchName"))){validateRepoRootStatus.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "path") || (key0 === "branchName"))){validateRepoRootStatus.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.path !== undefined){let data0: any = data.path;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 4096){validateRepoRootStatus.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data0) < 1){validateRepoRootStatus.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern33.test(data0)){validateRepoRootStatus.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validateRepoRootStatus.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.branchName !== undefined){let data1: any = data.branchName;const _errs4: any = errors;if(errors === _errs4){if(typeof data1 === "string"){if(func1(data1) < 1){validateRepoRootStatus.errors = [{instancePath:instancePath+"/branchName",schemaPath:"#/properties/branchName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data1)){validateRepoRootStatus.errors = [{instancePath:instancePath+"/branchName",schemaPath:"#/properties/branchName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validateRepoRootStatus.errors = [{instancePath:instancePath+"/branchName",schemaPath:"#/properties/branchName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validateRepoRootStatus.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateRepoRootStatus.errors = vErrors;return errors === 0;};
// prettier-ignore
validateRepoRootStatus.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorktreeStatusReadResponse}. */
// prettier-ignore
export const validateWorktreeStatusReadResponse: CompiledSchemaCheck<WorktreeStatusReadResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorktreeStatusReadResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorktreeStatusReadResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.repoRoot === undefined) && (missing0 = "repoRoot")) || ((data.worktrees === undefined) && (missing0 = "worktrees"))){validateWorktreeStatusReadResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "repoRoot") || (key0 === "worktrees")) || (key0 === "countsAsOf")) || (key0 === "newWorktree"))){validateWorktreeStatusReadResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.repoRoot !== undefined){const _errs2: any = errors;if(!(validateRepoRootStatus.call(this, data.repoRoot, {instancePath:instancePath+"/repoRoot",parentData:data,parentDataProperty:"repoRoot",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRepoRootStatus.errors : vErrors.concat(validateRepoRootStatus.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.worktrees !== undefined){let data1: any = data.worktrees;const _errs3: any = errors;if(errors === _errs3){if(Array.isArray(data1)){var valid1: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){const _errs5: any = errors;if(!(validateWorktreeStatusRecord.call(this, data1[i0], {instancePath:instancePath+"/worktrees/" + i0,parentData:data1,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorktreeStatusRecord.errors : vErrors.concat(validateWorktreeStatusRecord.errors);errors = vErrors.length;}var valid1: any = _errs5 === errors;if(!valid1){break;}}}else {validateWorktreeStatusReadResponse.errors = [{instancePath:instancePath+"/worktrees",schemaPath:"#/properties/worktrees/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.countsAsOf !== undefined){const _errs6: any = errors;if(!(validateWireInstant.call(this, data.countsAsOf, {instancePath:instancePath+"/countsAsOf",parentData:data,parentDataProperty:"countsAsOf",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.newWorktree !== undefined){const _errs7: any = errors;if(!(validateNewWorktreeSuggestion.call(this, data.newWorktree, {instancePath:instancePath+"/newWorktree",parentData:data,parentDataProperty:"newWorktree",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateNewWorktreeSuggestion.errors : vErrors.concat(validateNewWorktreeSuggestion.errors);errors = vErrors.length;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}}}}}}}else {validateWorktreeStatusReadResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorktreeStatusReadResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorktreeStatusReadResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
