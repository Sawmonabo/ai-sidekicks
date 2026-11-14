// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Binding a session's workspace to a mount, and listing a session's workspaces.

import { type CompiledSchemaCheck, ucs2length } from "../../schema-check.js";
import { type SessionId, validateSessionId } from "../session/id.js";
import {
  type ExecutionMode,
  type RepoMountId,
  type WorkspaceId,
  type WorkspaceState,
  validateExecutionMode,
  validateRepoMountId,
  validateWorkspaceId,
  validateWorkspaceState,
} from "./mount.js";

/**
 * The longest `lastError` a workspace carries: captured git or provisioning output, scrubbed
 * of credentials before it is cut, since a cut secret is a fragment the scrubber misses.
 */
export const WORKSPACE_LAST_ERROR_MAX_LEN = 8192 as const;

/**
 * `workspace.bind`: the session, the attached mount and the mode to bind in. `directory` is
 * relative to the mount root, or an absolute folder naming one of the mount's listed working
 * trees or a folder inside one, and the daemon keeps it inside those trees once symlinks resolve.
 */
export interface WorkspaceBindRequest {
  /**
   * The session; the mount belongs to the machine, so the caller names it.
   */
  sessionId: SessionId;
  /**
   * The mount.
   */
  repoMountId: RepoMountId;
  /**
   * The mode, required so an omitted one never reads as a chosen one.
   */
  executionMode: ExecutionMode;
  /**
   * The folder inside the mount.
   */
  directory?: string;
}
/**
 * The `workspace.bind` result: the new workspace, its bound mode and its state, which may be
 * other than `preparing`.
 */
export interface WorkspaceBindResponse {
  /**
   * The workspace.
   */
  workspaceId: WorkspaceId;
  /**
   * Its mode.
   */
  executionMode: ExecutionMode;
  /**
   * Its state.
   */
  state: WorkspaceState;
}
/**
 * `workspace.list`: a session's workspaces, narrowed to one mount when it is named.
 */
export interface WorkspaceListRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The mount to narrow to.
   */
  repoMountId?: RepoMountId;
}
/**
 * One workspace in a `workspace.list` result.
 */
export interface WorkspaceListEntry {
  /**
   * The workspace, by a bare `id` as a read names its own row.
   */
  id: WorkspaceId;
  /**
   * Its mount.
   */
  repoMountId: RepoMountId;
  /**
   * Its mode.
   */
  executionMode: ExecutionMode;
  /**
   * Its health, which is its lifecycle state.
   */
  state: WorkspaceState;
  /**
   * Its execution root, absent while it is `preparing`.
   */
  fsRoot?: string;
  /**
   * The failure that made it `rootLost`, when one did.
   */
  lastError?: string;
}
/**
 * The `workspace.list` result.
 */
export interface WorkspaceListResponse {
  /**
   * The workspaces.
   */
  workspaces: WorkspaceListEntry[];
}

// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern33 = new RegExp("^[^\\x00]*$", "u");
/** Checks that a value is a {@link WorkspaceBindRequest}. */
// prettier-ignore
export const validateWorkspaceBindRequest: CompiledSchemaCheck<WorkspaceBindRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkspaceBindRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkspaceBindRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.repoMountId === undefined) && (missing0 = "repoMountId"))) || ((data.executionMode === undefined) && (missing0 = "executionMode"))){validateWorkspaceBindRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "sessionId") || (key0 === "repoMountId")) || (key0 === "executionMode")) || (key0 === "directory"))){validateWorkspaceBindRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.repoMountId !== undefined){const _errs3: any = errors;if(!(validateRepoMountId.call(this, data.repoMountId, {instancePath:instancePath+"/repoMountId",parentData:data,parentDataProperty:"repoMountId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRepoMountId.errors : vErrors.concat(validateRepoMountId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.executionMode !== undefined){const _errs4: any = errors;if(!(validateExecutionMode.call(this, data.executionMode, {instancePath:instancePath+"/executionMode",parentData:data,parentDataProperty:"executionMode",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateExecutionMode.errors : vErrors.concat(validateExecutionMode.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.directory !== undefined){let data3: any = data.directory;const _errs5: any = errors;if(errors === _errs5){if(typeof data3 === "string"){if(func1(data3) > 4096){validateWorkspaceBindRequest.errors = [{instancePath:instancePath+"/directory",schemaPath:"#/properties/directory/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data3) < 1){validateWorkspaceBindRequest.errors = [{instancePath:instancePath+"/directory",schemaPath:"#/properties/directory/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern33.test(data3)){validateWorkspaceBindRequest.errors = [{instancePath:instancePath+"/directory",schemaPath:"#/properties/directory/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validateWorkspaceBindRequest.errors = [{instancePath:instancePath+"/directory",schemaPath:"#/properties/directory/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}}}else {validateWorkspaceBindRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkspaceBindRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkspaceBindRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkspaceBindResponse}. */
// prettier-ignore
export const validateWorkspaceBindResponse: CompiledSchemaCheck<WorkspaceBindResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkspaceBindResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkspaceBindResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.workspaceId === undefined) && (missing0 = "workspaceId")) || ((data.executionMode === undefined) && (missing0 = "executionMode"))) || ((data.state === undefined) && (missing0 = "state"))){validateWorkspaceBindResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "workspaceId") || (key0 === "executionMode")) || (key0 === "state"))){validateWorkspaceBindResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.workspaceId !== undefined){const _errs2: any = errors;if(!(validateWorkspaceId.call(this, data.workspaceId, {instancePath:instancePath+"/workspaceId",parentData:data,parentDataProperty:"workspaceId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkspaceId.errors : vErrors.concat(validateWorkspaceId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.executionMode !== undefined){const _errs3: any = errors;if(!(validateExecutionMode.call(this, data.executionMode, {instancePath:instancePath+"/executionMode",parentData:data,parentDataProperty:"executionMode",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateExecutionMode.errors : vErrors.concat(validateExecutionMode.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){const _errs4: any = errors;if(!(validateWorkspaceState.call(this, data.state, {instancePath:instancePath+"/state",parentData:data,parentDataProperty:"state",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkspaceState.errors : vErrors.concat(validateWorkspaceState.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}}else {validateWorkspaceBindResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkspaceBindResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkspaceBindResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkspaceListRequest}. */
// prettier-ignore
export const validateWorkspaceListRequest: CompiledSchemaCheck<WorkspaceListRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkspaceListRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkspaceListRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validateWorkspaceListRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "repoMountId"))){validateWorkspaceListRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.repoMountId !== undefined){const _errs3: any = errors;if(!(validateRepoMountId.call(this, data.repoMountId, {instancePath:instancePath+"/repoMountId",parentData:data,parentDataProperty:"repoMountId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRepoMountId.errors : vErrors.concat(validateRepoMountId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateWorkspaceListRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkspaceListRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkspaceListRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern5 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
/** Checks that a value is a {@link WorkspaceListEntry}. */
// prettier-ignore
export const validateWorkspaceListEntry: CompiledSchemaCheck<WorkspaceListEntry> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkspaceListEntry {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkspaceListEntry.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.id === undefined) && (missing0 = "id")) || ((data.repoMountId === undefined) && (missing0 = "repoMountId"))) || ((data.executionMode === undefined) && (missing0 = "executionMode"))) || ((data.state === undefined) && (missing0 = "state"))){validateWorkspaceListEntry.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((key0 === "id") || (key0 === "repoMountId")) || (key0 === "executionMode")) || (key0 === "state")) || (key0 === "fsRoot")) || (key0 === "lastError"))){validateWorkspaceListEntry.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.id !== undefined){const _errs2: any = errors;if(!(validateWorkspaceId.call(this, data.id, {instancePath:instancePath+"/id",parentData:data,parentDataProperty:"id",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkspaceId.errors : vErrors.concat(validateWorkspaceId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.repoMountId !== undefined){const _errs3: any = errors;if(!(validateRepoMountId.call(this, data.repoMountId, {instancePath:instancePath+"/repoMountId",parentData:data,parentDataProperty:"repoMountId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRepoMountId.errors : vErrors.concat(validateRepoMountId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.executionMode !== undefined){const _errs4: any = errors;if(!(validateExecutionMode.call(this, data.executionMode, {instancePath:instancePath+"/executionMode",parentData:data,parentDataProperty:"executionMode",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateExecutionMode.errors : vErrors.concat(validateExecutionMode.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){const _errs5: any = errors;if(!(validateWorkspaceState.call(this, data.state, {instancePath:instancePath+"/state",parentData:data,parentDataProperty:"state",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkspaceState.errors : vErrors.concat(validateWorkspaceState.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.fsRoot !== undefined){let data4: any = data.fsRoot;const _errs6: any = errors;if(errors === _errs6){if(typeof data4 === "string"){if(func1(data4) > 4096){validateWorkspaceListEntry.errors = [{instancePath:instancePath+"/fsRoot",schemaPath:"#/properties/fsRoot/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data4) < 1){validateWorkspaceListEntry.errors = [{instancePath:instancePath+"/fsRoot",schemaPath:"#/properties/fsRoot/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern33.test(data4)){validateWorkspaceListEntry.errors = [{instancePath:instancePath+"/fsRoot",schemaPath:"#/properties/fsRoot/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validateWorkspaceListEntry.errors = [{instancePath:instancePath+"/fsRoot",schemaPath:"#/properties/fsRoot/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.lastError !== undefined){let data5: any = data.lastError;const _errs8: any = errors;if(errors === _errs8){if(typeof data5 === "string"){if(func1(data5) > 8192){validateWorkspaceListEntry.errors = [{instancePath:instancePath+"/lastError",schemaPath:"#/properties/lastError/maxLength",keyword:"maxLength",params:{limit: 8192}}];return false;}else {if(func1(data5) < 1){validateWorkspaceListEntry.errors = [{instancePath:instancePath+"/lastError",schemaPath:"#/properties/lastError/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data5)){validateWorkspaceListEntry.errors = [{instancePath:instancePath+"/lastError",schemaPath:"#/properties/lastError/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateWorkspaceListEntry.errors = [{instancePath:instancePath+"/lastError",schemaPath:"#/properties/lastError/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}}}}}}}}}else {validateWorkspaceListEntry.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkspaceListEntry.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkspaceListEntry.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkspaceListResponse}. */
// prettier-ignore
export const validateWorkspaceListResponse: CompiledSchemaCheck<WorkspaceListResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkspaceListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkspaceListResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.workspaces === undefined) && (missing0 = "workspaces")){validateWorkspaceListResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "workspaces")){validateWorkspaceListResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.workspaces !== undefined){let data0: any = data.workspaces;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validateWorkspaceListEntry.call(this, data0[i0], {instancePath:instancePath+"/workspaces/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkspaceListEntry.errors : vErrors.concat(validateWorkspaceListEntry.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validateWorkspaceListResponse.errors = [{instancePath:instancePath+"/workspaces",schemaPath:"#/properties/workspaces/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validateWorkspaceListResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkspaceListResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkspaceListResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
