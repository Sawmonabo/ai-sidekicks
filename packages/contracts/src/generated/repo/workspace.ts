/* eslint-disable */
// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Binding a session's workspace to a mount, and listing a session's workspaces.

import { type SchemaCheck, ucs2length } from "../../schema-check.js";
import type { SessionId } from "../session/id.js";
import type { ExecutionMode, RepoMountId, WorkspaceId, WorkspaceState } from "./mount.js";

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
const schema1986: any = {"description":"How a workspace uses its mount: `boundRoot` works in the root already bound to it (the mount's\nown checkout), `provisionedWorktree` in a worktree the daemon provisions for it.","type":"string","enum":["boundRoot","provisionedWorktree"]};
// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
const pattern43 = new RegExp("^[^\\x00]*$", "u");
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
function validate1685(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkspaceBindRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1685.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.repoMountId === undefined) && (missing0 = "repoMountId"))) || ((data.executionMode === undefined) && (missing0 = "executionMode"))){validate1685.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "sessionId") || (key0 === "repoMountId")) || (key0 === "executionMode")) || (key0 === "directory"))){validate1685.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1685.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1685.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.repoMountId !== undefined){let data1: any = data.repoMountId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate1685.errors = [{instancePath:instancePath+"/repoMountId",schemaPath:"sidekicks-contracts:repo/mount#/$defs/RepoMountId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1685.errors = [{instancePath:instancePath+"/repoMountId",schemaPath:"sidekicks-contracts:repo/mount#/$defs/RepoMountId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.executionMode !== undefined){let data2: any = data.executionMode;const _errs10: any = errors;if(typeof data2 !== "string"){validate1685.errors = [{instancePath:instancePath+"/executionMode",schemaPath:"sidekicks-contracts:repo/mount#/$defs/ExecutionMode/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data2 === "boundRoot") || (data2 === "provisionedWorktree"))){validate1685.errors = [{instancePath:instancePath+"/executionMode",schemaPath:"sidekicks-contracts:repo/mount#/$defs/ExecutionMode/enum",keyword:"enum",params:{allowedValues: schema1986.enum}}];return false;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.directory !== undefined){let data3: any = data.directory;const _errs13: any = errors;if(errors === _errs13){if(typeof data3 === "string"){if(func1(data3) > 4096){validate1685.errors = [{instancePath:instancePath+"/directory",schemaPath:"#/properties/directory/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data3) < 1){validate1685.errors = [{instancePath:instancePath+"/directory",schemaPath:"#/properties/directory/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data3)){validate1685.errors = [{instancePath:instancePath+"/directory",schemaPath:"#/properties/directory/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate1685.errors = [{instancePath:instancePath+"/directory",schemaPath:"#/properties/directory/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}}}}}}}else {validate1685.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1685.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1685.errors = null as any[] | null;
// prettier-ignore
validate1685.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema922: any = {"description":"A workspace's lifecycle state. `rootLost` means its working root became unavailable and write\nruns are blocked until repair.","type":"string","enum":["preparing","ready","rootLost","archived"]};
// prettier-ignore
function validate1686(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkspaceBindResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1686.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.workspaceId === undefined) && (missing0 = "workspaceId")) || ((data.executionMode === undefined) && (missing0 = "executionMode"))) || ((data.state === undefined) && (missing0 = "state"))){validate1686.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "workspaceId") || (key0 === "executionMode")) || (key0 === "state"))){validate1686.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.workspaceId !== undefined){let data0: any = data.workspaceId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1686.errors = [{instancePath:instancePath+"/workspaceId",schemaPath:"sidekicks-contracts:repo/mount#/$defs/WorkspaceId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1686.errors = [{instancePath:instancePath+"/workspaceId",schemaPath:"sidekicks-contracts:repo/mount#/$defs/WorkspaceId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.executionMode !== undefined){let data1: any = data.executionMode;const _errs6: any = errors;if(typeof data1 !== "string"){validate1686.errors = [{instancePath:instancePath+"/executionMode",schemaPath:"sidekicks-contracts:repo/mount#/$defs/ExecutionMode/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data1 === "boundRoot") || (data1 === "provisionedWorktree"))){validate1686.errors = [{instancePath:instancePath+"/executionMode",schemaPath:"sidekicks-contracts:repo/mount#/$defs/ExecutionMode/enum",keyword:"enum",params:{allowedValues: schema1986.enum}}];return false;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){let data2: any = data.state;const _errs9: any = errors;if(typeof data2 !== "string"){validate1686.errors = [{instancePath:instancePath+"/state",schemaPath:"sidekicks-contracts:repo/mount#/$defs/WorkspaceState/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((data2 === "preparing") || (data2 === "ready")) || (data2 === "rootLost")) || (data2 === "archived"))){validate1686.errors = [{instancePath:instancePath+"/state",schemaPath:"sidekicks-contracts:repo/mount#/$defs/WorkspaceState/enum",keyword:"enum",params:{allowedValues: schema922.enum}}];return false;}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}}}}}}else {validate1686.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1686.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1686.errors = null as any[] | null;
// prettier-ignore
validate1686.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1687(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkspaceListRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1687.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validate1687.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "repoMountId"))){validate1687.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1687.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1687.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.repoMountId !== undefined){let data1: any = data.repoMountId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate1687.errors = [{instancePath:instancePath+"/repoMountId",schemaPath:"sidekicks-contracts:repo/mount#/$defs/RepoMountId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1687.errors = [{instancePath:instancePath+"/repoMountId",schemaPath:"sidekicks-contracts:repo/mount#/$defs/RepoMountId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1687.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1687.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1687.errors = null as any[] | null;
// prettier-ignore
validate1687.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
function validate1689(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1689.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.id === undefined) && (missing0 = "id")) || ((data.repoMountId === undefined) && (missing0 = "repoMountId"))) || ((data.executionMode === undefined) && (missing0 = "executionMode"))) || ((data.state === undefined) && (missing0 = "state"))){validate1689.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((key0 === "id") || (key0 === "repoMountId")) || (key0 === "executionMode")) || (key0 === "state")) || (key0 === "fsRoot")) || (key0 === "lastError"))){validate1689.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.id !== undefined){let data0: any = data.id;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1689.errors = [{instancePath:instancePath+"/id",schemaPath:"sidekicks-contracts:repo/mount#/$defs/WorkspaceId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1689.errors = [{instancePath:instancePath+"/id",schemaPath:"sidekicks-contracts:repo/mount#/$defs/WorkspaceId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.repoMountId !== undefined){let data1: any = data.repoMountId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate1689.errors = [{instancePath:instancePath+"/repoMountId",schemaPath:"sidekicks-contracts:repo/mount#/$defs/RepoMountId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1689.errors = [{instancePath:instancePath+"/repoMountId",schemaPath:"sidekicks-contracts:repo/mount#/$defs/RepoMountId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.executionMode !== undefined){let data2: any = data.executionMode;const _errs10: any = errors;if(typeof data2 !== "string"){validate1689.errors = [{instancePath:instancePath+"/executionMode",schemaPath:"sidekicks-contracts:repo/mount#/$defs/ExecutionMode/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data2 === "boundRoot") || (data2 === "provisionedWorktree"))){validate1689.errors = [{instancePath:instancePath+"/executionMode",schemaPath:"sidekicks-contracts:repo/mount#/$defs/ExecutionMode/enum",keyword:"enum",params:{allowedValues: schema1986.enum}}];return false;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){let data3: any = data.state;const _errs13: any = errors;if(typeof data3 !== "string"){validate1689.errors = [{instancePath:instancePath+"/state",schemaPath:"sidekicks-contracts:repo/mount#/$defs/WorkspaceState/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((data3 === "preparing") || (data3 === "ready")) || (data3 === "rootLost")) || (data3 === "archived"))){validate1689.errors = [{instancePath:instancePath+"/state",schemaPath:"sidekicks-contracts:repo/mount#/$defs/WorkspaceState/enum",keyword:"enum",params:{allowedValues: schema922.enum}}];return false;}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}if(valid0){if(data.fsRoot !== undefined){let data4: any = data.fsRoot;const _errs16: any = errors;if(errors === _errs16){if(typeof data4 === "string"){if(func1(data4) > 4096){validate1689.errors = [{instancePath:instancePath+"/fsRoot",schemaPath:"#/properties/fsRoot/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data4) < 1){validate1689.errors = [{instancePath:instancePath+"/fsRoot",schemaPath:"#/properties/fsRoot/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data4)){validate1689.errors = [{instancePath:instancePath+"/fsRoot",schemaPath:"#/properties/fsRoot/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate1689.errors = [{instancePath:instancePath+"/fsRoot",schemaPath:"#/properties/fsRoot/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs16 === errors;}else {var valid0: any = true;}if(valid0){if(data.lastError !== undefined){let data5: any = data.lastError;const _errs18: any = errors;if(errors === _errs18){if(typeof data5 === "string"){if(func1(data5) > 8192){validate1689.errors = [{instancePath:instancePath+"/lastError",schemaPath:"#/properties/lastError/maxLength",keyword:"maxLength",params:{limit: 8192}}];return false;}else {if(func1(data5) < 1){validate1689.errors = [{instancePath:instancePath+"/lastError",schemaPath:"#/properties/lastError/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data5)){validate1689.errors = [{instancePath:instancePath+"/lastError",schemaPath:"#/properties/lastError/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1689.errors = [{instancePath:instancePath+"/lastError",schemaPath:"#/properties/lastError/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs18 === errors;}else {var valid0: any = true;}}}}}}}}}else {validate1689.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1689.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1689.errors = null as any[] | null;
// prettier-ignore
validate1689.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1688(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkspaceListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1688.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.workspaces === undefined) && (missing0 = "workspaces")){validate1688.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "workspaces")){validate1688.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.workspaces !== undefined){let data0: any = data.workspaces;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validate1689.call(this, data0[i0], {instancePath:instancePath+"/workspaces/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1689.errors : vErrors.concat(validate1689.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validate1688.errors = [{instancePath:instancePath+"/workspaces",schemaPath:"#/properties/workspaces/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validate1688.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1688.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1688.errors = null as any[] | null;
// prettier-ignore
validate1688.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkspaceBindRequest}. */
export const validateWorkspaceBindRequest: SchemaCheck<WorkspaceBindRequest> = validate1685;
/** Checks that a value is a {@link WorkspaceBindResponse}. */
export const validateWorkspaceBindResponse: SchemaCheck<WorkspaceBindResponse> = validate1686;
/** Checks that a value is a {@link WorkspaceListRequest}. */
export const validateWorkspaceListRequest: SchemaCheck<WorkspaceListRequest> = validate1687;
/** Checks that a value is a {@link WorkspaceListResponse}. */
export const validateWorkspaceListResponse: SchemaCheck<WorkspaceListResponse> = validate1688;
