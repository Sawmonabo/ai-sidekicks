// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The git reads the panes make: the branch list, reading a file's lines by path or by blob, and the signal that a session's working folder changed.

import { type SchemaCheck, ucs2length } from "../../schema-check.js";
import type { WireInstant } from "../internal/wire-scalars.js";
import type { SessionId } from "../session/id.js";
import type { WorktreeId } from "../worktree/lifecycle.js";
import type { RepoMountId } from "./mount.js";

/**
 * A git object name as git prints it: 40 lower-case hex digits for SHA-1, 64 for SHA-256.
 * Commits and blobs are both named this way.
 */
export type GitObjectId = string & { readonly __brand: "GitObjectId" };
/**
 * Which side of a comparison a gap read is on: a `committed` side is read from git's object
 * store; a `workingTree` side from disk, and only while the file there still has the blob id the
 * diff was read at.
 */
export type ProjectFileSide = "committed" | "workingTree";
/**
 * `project.file.read`: a file in the session's working folder, or the lines inside a collapsed gap
 * of a diff, which names its blob and its side together.
 */
export type ProjectFileReadRequest =
  | {
      /**
       * The session whose working folder is read.
       */
      sessionId: SessionId;
      /**
       * The file, inside the working folder.
       */
      path: string;
      /**
       * The blob the diff gave that side.
       */
      blobId: GitObjectId;
      /**
       * The side.
       */
      side: ProjectFileSide;
      /**
       * The lines to read; absent reads the whole file.
       */
      lines?: ProjectFileLineRange;
    }
  | {
      /**
       * The session whose working folder is read.
       */
      sessionId: SessionId;
      /**
       * The file, inside the working folder.
       */
      path: string;
      /**
       * Only a gap read names a blob.
       */
      blobId?: never;
      /**
       * Only a gap read names a side.
       */
      side?: never;
      /**
       * The lines to read; absent reads the whole file.
       */
      lines?: ProjectFileLineRange;
    };
/**
 * The `project.file.read` result: the lines read; `stale` when the working-tree side no longer
 * holds the blob the diff was read at, so the pane shows its reload mark; `binary` when the file
 * is not text.
 */
export type ProjectFileReadResponse =
  | {
      outcome: "lines";
      /**
       * The file.
       */
      path: string;
      /**
       * The lines.
       */
      lines: string[];
      /**
       * The first line's number, from 1.
       */
      firstLine: number;
      /**
       * How many lines the file has.
       */
      totalLines: number;
    }
  | {
      outcome: "stale";
    }
  | {
      outcome: "binary";
    };
/**
 * How the daemon noticed a working folder change: a file watch, or a slow tick for a folder too
 * large for the machine's watch limit, so a late mark is never read as a tree that did not change.
 */
export type WorkingTreeChangeMode = "watch" | "slowTick";

/**
 * `project.branch.list`: the mount whose branches both base pickers list.
 */
export interface ProjectBranchListRequest {
  /**
   * The mount.
   */
  repoMountId: RepoMountId;
}
/**
 * The worktree that has a branch checked out, which the create form's list grays.
 */
export interface BranchHolder {
  /**
   * Present only for a tree the app made; the main checkout and a tree the person made carry a
   * name alone.
   */
  worktreeId?: WorktreeId;
  /**
   * The tree's name.
   */
  name: string;
}
/**
 * One branch in a base list. `ahead` and `behind` count commits against the branch's upstream and
 * are absent when it has none.
 */
export interface ProjectBranchListEntry {
  /**
   * The branch.
   */
  name: string;
  /**
   * Commits ahead of its upstream.
   */
  ahead?: number;
  /**
   * Commits behind its upstream.
   */
  behind?: number;
  /**
   * The worktree that has it checked out.
   */
  heldBy?: BranchHolder;
}
/**
 * The `project.branch.list` result, in the daemon's one order: the default branch, then the
 * branches this project's last picks came from, most recent first, then the rest by their newest
 * commit.
 */
export interface ProjectBranchListResponse {
  /**
   * The default branch.
   */
  defaultBranch: string;
  /**
   * The branches.
   */
  branches: ProjectBranchListEntry[];
  /**
   * Present when the last background fetch failed: when the figures were last true.
   */
  countsAsOf?: WireInstant;
}
/**
 * The lines a read narrows to: `count` lines from line `from`, counted from 1.
 */
export interface ProjectFileLineRange {
  /**
   * The first line, from 1.
   */
  from: number;
  /**
   * How many lines.
   */
  count: number;
}
/**
 * `session.workingFolder.subscribe`: the session whose working folder the daemon watches.
 */
export interface SessionWorkingFolderSubscribeRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
}
/**
 * One `session.workingFolder.subscribe` emission: the working folder changed at `changedAt`.
 */
export interface WorkingTreeChange {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * When it changed.
   */
  changedAt: WireInstant;
  /**
   * How the daemon noticed.
   */
  mode: WorkingTreeChangeMode;
}

// prettier-ignore
const pattern732 = new RegExp("^(?:[0-9a-f]{40}|[0-9a-f]{64})$", "u");
// prettier-ignore
function validate1663(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is GitObjectId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1663.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern732.test(data)){validate1663.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"}}];return false;}}else {validate1663.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validate1663.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1663.errors = null as any[] | null;
// prettier-ignore
validate1663.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
function validate1664(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProjectBranchListRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1664.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.repoMountId === undefined) && (missing0 = "repoMountId")){validate1664.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "repoMountId")){validate1664.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.repoMountId !== undefined){let data0: any = data.repoMountId;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1664.errors = [{instancePath:instancePath+"/repoMountId",schemaPath:"sidekicks-contracts:repo/mount#/$defs/RepoMountId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1664.errors = [{instancePath:instancePath+"/repoMountId",schemaPath:"sidekicks-contracts:repo/mount#/$defs/RepoMountId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate1664.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1664.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1664.errors = null as any[] | null;
// prettier-ignore
validate1664.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
const pattern5 = new RegExp("^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$", "u");
// prettier-ignore
function validate1667(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1667.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.name === undefined) && (missing0 = "name")){validate1667.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "worktreeId") || (key0 === "name"))){validate1667.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.worktreeId !== undefined){let data0: any = data.worktreeId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1667.errors = [{instancePath:instancePath+"/worktreeId",schemaPath:"sidekicks-contracts:worktree/lifecycle#/$defs/WorktreeId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1667.errors = [{instancePath:instancePath+"/worktreeId",schemaPath:"sidekicks-contracts:worktree/lifecycle#/$defs/WorktreeId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data1: any = data.name;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) > 4096){validate1667.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data1) < 1){validate1667.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data1)){validate1667.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1667.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1667.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1667.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1667.errors = null as any[] | null;
// prettier-ignore
validate1667.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1666(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1666.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.name === undefined) && (missing0 = "name")){validate1666.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "name") || (key0 === "ahead")) || (key0 === "behind")) || (key0 === "heldBy"))){validate1666.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.name !== undefined){let data0: any = data.name;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) < 1){validate1666.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data0)){validate1666.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate1666.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.ahead !== undefined){let data1: any = data.ahead;const _errs4: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validate1666.errors = [{instancePath:instancePath+"/ahead",schemaPath:"#/properties/ahead/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs4){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validate1666.errors = [{instancePath:instancePath+"/ahead",schemaPath:"#/properties/ahead/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 0 || isNaN(data1)){validate1666.errors = [{instancePath:instancePath+"/ahead",schemaPath:"#/properties/ahead/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.behind !== undefined){let data2: any = data.behind;const _errs6: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validate1666.errors = [{instancePath:instancePath+"/behind",schemaPath:"#/properties/behind/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs6){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validate1666.errors = [{instancePath:instancePath+"/behind",schemaPath:"#/properties/behind/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 0 || isNaN(data2)){validate1666.errors = [{instancePath:instancePath+"/behind",schemaPath:"#/properties/behind/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.heldBy !== undefined){const _errs8: any = errors;if(!(validate1667.call(this, data.heldBy, {instancePath:instancePath+"/heldBy",parentData:data,parentDataProperty:"heldBy",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1667.errors : vErrors.concat(validate1667.errors);errors = vErrors.length;}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}}}}}}}else {validate1666.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1666.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1666.errors = null as any[] | null;
// prettier-ignore
validate1666.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1665(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProjectBranchListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1665.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.defaultBranch === undefined) && (missing0 = "defaultBranch")) || ((data.branches === undefined) && (missing0 = "branches"))){validate1665.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "defaultBranch") || (key0 === "branches")) || (key0 === "countsAsOf"))){validate1665.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.defaultBranch !== undefined){let data0: any = data.defaultBranch;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) < 1){validate1665.errors = [{instancePath:instancePath+"/defaultBranch",schemaPath:"#/properties/defaultBranch/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data0)){validate1665.errors = [{instancePath:instancePath+"/defaultBranch",schemaPath:"#/properties/defaultBranch/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate1665.errors = [{instancePath:instancePath+"/defaultBranch",schemaPath:"#/properties/defaultBranch/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.branches !== undefined){let data1: any = data.branches;const _errs4: any = errors;if(errors === _errs4){if(Array.isArray(data1)){var valid1: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){const _errs6: any = errors;if(!(validate1666.call(this, data1[i0], {instancePath:instancePath+"/branches/" + i0,parentData:data1,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1666.errors : vErrors.concat(validate1666.errors);errors = vErrors.length;}var valid1: any = _errs6 === errors;if(!valid1){break;}}}else {validate1665.errors = [{instancePath:instancePath+"/branches",schemaPath:"#/properties/branches/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.countsAsOf !== undefined){let data3: any = data.countsAsOf;const _errs7: any = errors;const _errs8: any = errors;if(errors === _errs8){if(typeof data3 === "string"){if(!pattern5.test(data3)){validate1665.errors = [{instancePath:instancePath+"/countsAsOf",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate1665.errors = [{instancePath:instancePath+"/countsAsOf",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}}}}}}else {validate1665.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1665.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1665.errors = null as any[] | null;
// prettier-ignore
validate1665.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema3103: any = {"description":"Which side of a comparison a gap read is on: a `committed` side is read from git's object\nstore; a `workingTree` side from disk, and only while the file there still has the blob id the\ndiff was read at.","type":"string","enum":["committed","workingTree"]};
// prettier-ignore
const pattern43 = new RegExp("^[^\\x00]*$", "u");
// prettier-ignore
function validate1670(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProjectFileReadRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1670.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(errors === _errs1){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.path === undefined) && (missing0 = "path"))) || ((data.blobId === undefined) && (missing0 = "blobId"))) || ((data.side === undefined) && (missing0 = "side"))){const err0: any = {instancePath,schemaPath:"#/anyOf/0/required",keyword:"required",params:{missingProperty: missing0}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {const _errs3: any = errors;for(const key0 in data){if(!(((((key0 === "sessionId") || (key0 === "path")) || (key0 === "blobId")) || (key0 === "side")) || (key0 === "lines"))){const err1: any = {instancePath,schemaPath:"#/anyOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;break;}}if(_errs3 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs4: any = errors;const _errs5: any = errors;if(errors === _errs5){if(typeof data0 === "string"){if(!pattern4.test(data0)){const err2: any = {instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}}else {const err3: any = {instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}}var valid1: any = _errs4 === errors;}else {var valid1: any = true;}if(valid1){if(data.path !== undefined){let data1: any = data.path;const _errs8: any = errors;if(errors === _errs8){if(typeof data1 === "string"){if(func1(data1) > 4096){const err4: any = {instancePath:instancePath+"/path",schemaPath:"#/anyOf/0/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}else {if(func1(data1) < 1){const err5: any = {instancePath:instancePath+"/path",schemaPath:"#/anyOf/0/properties/path/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}else {if(!pattern43.test(data1)){const err6: any = {instancePath:instancePath+"/path",schemaPath:"#/anyOf/0/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;}}}}else {const err7: any = {instancePath:instancePath+"/path",schemaPath:"#/anyOf/0/properties/path/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;}}var valid1: any = _errs8 === errors;}else {var valid1: any = true;}if(valid1){if(data.blobId !== undefined){let data2: any = data.blobId;const _errs10: any = errors;const _errs11: any = errors;if(errors === _errs11){if(typeof data2 === "string"){if(!pattern732.test(data2)){const err8: any = {instancePath:instancePath+"/blobId",schemaPath:"#/$defs/GitObjectId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"}};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;}}else {const err9: any = {instancePath:instancePath+"/blobId",schemaPath:"#/$defs/GitObjectId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;}}var valid1: any = _errs10 === errors;}else {var valid1: any = true;}if(valid1){if(data.side !== undefined){let data3: any = data.side;const _errs14: any = errors;if(typeof data3 !== "string"){const err10: any = {instancePath:instancePath+"/side",schemaPath:"#/$defs/ProjectFileSide/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err10];}else {vErrors.push(err10);}errors++;}if(!((data3 === "committed") || (data3 === "workingTree"))){const err11: any = {instancePath:instancePath+"/side",schemaPath:"#/$defs/ProjectFileSide/enum",keyword:"enum",params:{allowedValues: schema3103.enum}};if(vErrors === null){vErrors = [err11];}else {vErrors.push(err11);}errors++;}var valid1: any = _errs14 === errors;}else {var valid1: any = true;}if(valid1){if(data.lines !== undefined){let data4: any = data.lines;const _errs17: any = errors;const _errs18: any = errors;if(errors === _errs18){if(data4 && typeof data4 == "object" && !Array.isArray(data4)){let missing1: any;if(((data4.from === undefined) && (missing1 = "from")) || ((data4.count === undefined) && (missing1 = "count"))){const err12: any = {instancePath:instancePath+"/lines",schemaPath:"#/$defs/ProjectFileLineRange/required",keyword:"required",params:{missingProperty: missing1}};if(vErrors === null){vErrors = [err12];}else {vErrors.push(err12);}errors++;}else {const _errs20: any = errors;for(const key1 in data4){if(!((key1 === "from") || (key1 === "count"))){const err13: any = {instancePath:instancePath+"/lines",schemaPath:"#/$defs/ProjectFileLineRange/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}};if(vErrors === null){vErrors = [err13];}else {vErrors.push(err13);}errors++;break;}}if(_errs20 === errors){if(data4.from !== undefined){let data5: any = data4.from;const _errs21: any = errors;if(!(((typeof data5 == "number") && (!(data5 % 1) && !isNaN(data5))) && (isFinite(data5)))){const err14: any = {instancePath:instancePath+"/lines/from",schemaPath:"#/$defs/ProjectFileLineRange/properties/from/type",keyword:"type",params:{type: "integer"}};if(vErrors === null){vErrors = [err14];}else {vErrors.push(err14);}errors++;}if(errors === _errs21){if((typeof data5 == "number") && (isFinite(data5))){if(data5 > 9007199254740991 || isNaN(data5)){const err15: any = {instancePath:instancePath+"/lines/from",schemaPath:"#/$defs/ProjectFileLineRange/properties/from/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}};if(vErrors === null){vErrors = [err15];}else {vErrors.push(err15);}errors++;}else {if(data5 < 1 || isNaN(data5)){const err16: any = {instancePath:instancePath+"/lines/from",schemaPath:"#/$defs/ProjectFileLineRange/properties/from/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}};if(vErrors === null){vErrors = [err16];}else {vErrors.push(err16);}errors++;}}}}var valid6: any = _errs21 === errors;}else {var valid6: any = true;}if(valid6){if(data4.count !== undefined){let data6: any = data4.count;const _errs23: any = errors;if(!(((typeof data6 == "number") && (!(data6 % 1) && !isNaN(data6))) && (isFinite(data6)))){const err17: any = {instancePath:instancePath+"/lines/count",schemaPath:"#/$defs/ProjectFileLineRange/properties/count/type",keyword:"type",params:{type: "integer"}};if(vErrors === null){vErrors = [err17];}else {vErrors.push(err17);}errors++;}if(errors === _errs23){if((typeof data6 == "number") && (isFinite(data6))){if(data6 > 9007199254740991 || isNaN(data6)){const err18: any = {instancePath:instancePath+"/lines/count",schemaPath:"#/$defs/ProjectFileLineRange/properties/count/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}};if(vErrors === null){vErrors = [err18];}else {vErrors.push(err18);}errors++;}else {if(data6 < 1 || isNaN(data6)){const err19: any = {instancePath:instancePath+"/lines/count",schemaPath:"#/$defs/ProjectFileLineRange/properties/count/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}};if(vErrors === null){vErrors = [err19];}else {vErrors.push(err19);}errors++;}}}}var valid6: any = _errs23 === errors;}else {var valid6: any = true;}}}}}else {const err20: any = {instancePath:instancePath+"/lines",schemaPath:"#/$defs/ProjectFileLineRange/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err20];}else {vErrors.push(err20);}errors++;}}var valid1: any = _errs17 === errors;}else {var valid1: any = true;}}}}}}}}else {const err21: any = {instancePath,schemaPath:"#/anyOf/0/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err21];}else {vErrors.push(err21);}errors++;}}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}const _errs25: any = errors;if(errors === _errs25){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if(((data.sessionId === undefined) && (missing2 = "sessionId")) || ((data.path === undefined) && (missing2 = "path"))){const err22: any = {instancePath,schemaPath:"#/anyOf/1/required",keyword:"required",params:{missingProperty: missing2}};if(vErrors === null){vErrors = [err22];}else {vErrors.push(err22);}errors++;}else {const _errs27: any = errors;for(const key2 in data){if(!(((((key2 === "sessionId") || (key2 === "path")) || (key2 === "blobId")) || (key2 === "side")) || (key2 === "lines"))){const err23: any = {instancePath,schemaPath:"#/anyOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}};if(vErrors === null){vErrors = [err23];}else {vErrors.push(err23);}errors++;break;}}if(_errs27 === errors){if(data.sessionId !== undefined){let data7: any = data.sessionId;const _errs28: any = errors;const _errs29: any = errors;if(errors === _errs29){if(typeof data7 === "string"){if(!pattern4.test(data7)){const err24: any = {instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}};if(vErrors === null){vErrors = [err24];}else {vErrors.push(err24);}errors++;}}else {const err25: any = {instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err25];}else {vErrors.push(err25);}errors++;}}var valid7: any = _errs28 === errors;}else {var valid7: any = true;}if(valid7){if(data.path !== undefined){let data8: any = data.path;const _errs32: any = errors;if(errors === _errs32){if(typeof data8 === "string"){if(func1(data8) > 4096){const err26: any = {instancePath:instancePath+"/path",schemaPath:"#/anyOf/1/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}};if(vErrors === null){vErrors = [err26];}else {vErrors.push(err26);}errors++;}else {if(func1(data8) < 1){const err27: any = {instancePath:instancePath+"/path",schemaPath:"#/anyOf/1/properties/path/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err27];}else {vErrors.push(err27);}errors++;}else {if(!pattern43.test(data8)){const err28: any = {instancePath:instancePath+"/path",schemaPath:"#/anyOf/1/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}};if(vErrors === null){vErrors = [err28];}else {vErrors.push(err28);}errors++;}}}}else {const err29: any = {instancePath:instancePath+"/path",schemaPath:"#/anyOf/1/properties/path/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err29];}else {vErrors.push(err29);}errors++;}}var valid7: any = _errs32 === errors;}else {var valid7: any = true;}if(valid7){if(data.blobId !== undefined){const _errs34: any = errors;const err30: any = {instancePath:instancePath+"/blobId",schemaPath:"#/anyOf/1/properties/blobId/not",keyword:"not",params:{}};if(vErrors === null){vErrors = [err30];}else {vErrors.push(err30);}errors++;var valid7: any = _errs34 === errors;}else {var valid7: any = true;}if(valid7){if(data.side !== undefined){const _errs37: any = errors;const err31: any = {instancePath:instancePath+"/side",schemaPath:"#/anyOf/1/properties/side/not",keyword:"not",params:{}};if(vErrors === null){vErrors = [err31];}else {vErrors.push(err31);}errors++;var valid7: any = _errs37 === errors;}else {var valid7: any = true;}if(valid7){if(data.lines !== undefined){let data11: any = data.lines;const _errs40: any = errors;const _errs41: any = errors;if(errors === _errs41){if(data11 && typeof data11 == "object" && !Array.isArray(data11)){let missing3: any;if(((data11.from === undefined) && (missing3 = "from")) || ((data11.count === undefined) && (missing3 = "count"))){const err32: any = {instancePath:instancePath+"/lines",schemaPath:"#/$defs/ProjectFileLineRange/required",keyword:"required",params:{missingProperty: missing3}};if(vErrors === null){vErrors = [err32];}else {vErrors.push(err32);}errors++;}else {const _errs43: any = errors;for(const key3 in data11){if(!((key3 === "from") || (key3 === "count"))){const err33: any = {instancePath:instancePath+"/lines",schemaPath:"#/$defs/ProjectFileLineRange/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}};if(vErrors === null){vErrors = [err33];}else {vErrors.push(err33);}errors++;break;}}if(_errs43 === errors){if(data11.from !== undefined){let data12: any = data11.from;const _errs44: any = errors;if(!(((typeof data12 == "number") && (!(data12 % 1) && !isNaN(data12))) && (isFinite(data12)))){const err34: any = {instancePath:instancePath+"/lines/from",schemaPath:"#/$defs/ProjectFileLineRange/properties/from/type",keyword:"type",params:{type: "integer"}};if(vErrors === null){vErrors = [err34];}else {vErrors.push(err34);}errors++;}if(errors === _errs44){if((typeof data12 == "number") && (isFinite(data12))){if(data12 > 9007199254740991 || isNaN(data12)){const err35: any = {instancePath:instancePath+"/lines/from",schemaPath:"#/$defs/ProjectFileLineRange/properties/from/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}};if(vErrors === null){vErrors = [err35];}else {vErrors.push(err35);}errors++;}else {if(data12 < 1 || isNaN(data12)){const err36: any = {instancePath:instancePath+"/lines/from",schemaPath:"#/$defs/ProjectFileLineRange/properties/from/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}};if(vErrors === null){vErrors = [err36];}else {vErrors.push(err36);}errors++;}}}}var valid10: any = _errs44 === errors;}else {var valid10: any = true;}if(valid10){if(data11.count !== undefined){let data13: any = data11.count;const _errs46: any = errors;if(!(((typeof data13 == "number") && (!(data13 % 1) && !isNaN(data13))) && (isFinite(data13)))){const err37: any = {instancePath:instancePath+"/lines/count",schemaPath:"#/$defs/ProjectFileLineRange/properties/count/type",keyword:"type",params:{type: "integer"}};if(vErrors === null){vErrors = [err37];}else {vErrors.push(err37);}errors++;}if(errors === _errs46){if((typeof data13 == "number") && (isFinite(data13))){if(data13 > 9007199254740991 || isNaN(data13)){const err38: any = {instancePath:instancePath+"/lines/count",schemaPath:"#/$defs/ProjectFileLineRange/properties/count/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}};if(vErrors === null){vErrors = [err38];}else {vErrors.push(err38);}errors++;}else {if(data13 < 1 || isNaN(data13)){const err39: any = {instancePath:instancePath+"/lines/count",schemaPath:"#/$defs/ProjectFileLineRange/properties/count/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}};if(vErrors === null){vErrors = [err39];}else {vErrors.push(err39);}errors++;}}}}var valid10: any = _errs46 === errors;}else {var valid10: any = true;}}}}}else {const err40: any = {instancePath:instancePath+"/lines",schemaPath:"#/$defs/ProjectFileLineRange/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err40];}else {vErrors.push(err40);}errors++;}}var valid7: any = _errs40 === errors;}else {var valid7: any = true;}}}}}}}}else {const err41: any = {instancePath,schemaPath:"#/anyOf/1/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err41];}else {vErrors.push(err41);}errors++;}}var _valid0: any = _errs25 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}if(!valid0){const err42: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err42];}else {vErrors.push(err42);}errors++;validate1670.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validate1670.errors = vErrors;evaluated0.props = props0;return errors === 0;}
// prettier-ignore
validate1670.errors = null as any[] | null;
// prettier-ignore
validate1670.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
// prettier-ignore
function validate1671(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProjectFileReadResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1671.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.outcome;if(typeof tag0 == "string"){if(tag0 === "lines"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((data.outcome === undefined) && (missing0 = "outcome")) || ((data.path === undefined) && (missing0 = "path"))) || ((data.lines === undefined) && (missing0 = "lines"))) || ((data.firstLine === undefined) && (missing0 = "firstLine"))) || ((data.totalLines === undefined) && (missing0 = "totalLines"))){validate1671.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!(((((key0 === "outcome") || (key0 === "path")) || (key0 === "lines")) || (key0 === "firstLine")) || (key0 === "totalLines"))){validate1671.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.outcome !== undefined){let data0: any = data.outcome;const _errs5: any = errors;if(typeof data0 !== "string"){validate1671.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/0/properties/outcome/type",keyword:"type",params:{type: "string"}}];return false;}if("lines" !== data0){validate1671.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/0/properties/outcome/const",keyword:"const",params:{allowedValue: "lines"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.path !== undefined){let data1: any = data.path;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) > 4096){validate1671.errors = [{instancePath:instancePath+"/path",schemaPath:"#/oneOf/0/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data1) < 1){validate1671.errors = [{instancePath:instancePath+"/path",schemaPath:"#/oneOf/0/properties/path/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data1)){validate1671.errors = [{instancePath:instancePath+"/path",schemaPath:"#/oneOf/0/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate1671.errors = [{instancePath:instancePath+"/path",schemaPath:"#/oneOf/0/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.lines !== undefined){let data2: any = data.lines;const _errs9: any = errors;if(errors === _errs9){if(Array.isArray(data2)){var valid3: any = true;const len0: any = data2.length;for(let i0=0; i0<len0; i0++){const _errs11: any = errors;if(typeof data2[i0] !== "string"){validate1671.errors = [{instancePath:instancePath+"/lines/" + i0,schemaPath:"#/oneOf/0/properties/lines/items/type",keyword:"type",params:{type: "string"}}];return false;}var valid3: any = _errs11 === errors;if(!valid3){break;}}}else {validate1671.errors = [{instancePath:instancePath+"/lines",schemaPath:"#/oneOf/0/properties/lines/type",keyword:"type",params:{type: "array"}}];return false;}}var valid2: any = _errs9 === errors;}else {var valid2: any = true;}if(valid2){if(data.firstLine !== undefined){let data4: any = data.firstLine;const _errs13: any = errors;if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){validate1671.errors = [{instancePath:instancePath+"/firstLine",schemaPath:"#/oneOf/0/properties/firstLine/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs13){if((typeof data4 == "number") && (isFinite(data4))){if(data4 > 9007199254740991 || isNaN(data4)){validate1671.errors = [{instancePath:instancePath+"/firstLine",schemaPath:"#/oneOf/0/properties/firstLine/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data4 < 1 || isNaN(data4)){validate1671.errors = [{instancePath:instancePath+"/firstLine",schemaPath:"#/oneOf/0/properties/firstLine/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid2: any = _errs13 === errors;}else {var valid2: any = true;}if(valid2){if(data.totalLines !== undefined){let data5: any = data.totalLines;const _errs15: any = errors;if(!(((typeof data5 == "number") && (!(data5 % 1) && !isNaN(data5))) && (isFinite(data5)))){validate1671.errors = [{instancePath:instancePath+"/totalLines",schemaPath:"#/oneOf/0/properties/totalLines/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs15){if((typeof data5 == "number") && (isFinite(data5))){if(data5 > 9007199254740991 || isNaN(data5)){validate1671.errors = [{instancePath:instancePath+"/totalLines",schemaPath:"#/oneOf/0/properties/totalLines/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data5 < 0 || isNaN(data5)){validate1671.errors = [{instancePath:instancePath+"/totalLines",schemaPath:"#/oneOf/0/properties/totalLines/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs15 === errors;}else {var valid2: any = true;}}}}}}}}else {validate1671.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "stale"){const _errs17: any = errors;if(errors === _errs17){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((data.outcome === undefined) && (missing1 = "outcome")){validate1671.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs19: any = errors;for(const key1 in data){if(!(key1 === "outcome")){validate1671.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs19 === errors){if(data.outcome !== undefined){let data6: any = data.outcome;if(typeof data6 !== "string"){validate1671.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/1/properties/outcome/type",keyword:"type",params:{type: "string"}}];return false;}if("stale" !== data6){validate1671.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/1/properties/outcome/const",keyword:"const",params:{allowedValue: "stale"}}];return false;}}}}}else {validate1671.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid4: any = _errs17 === errors;if(props0 !== true){props0 = true;}valid0 = valid4;}else if(tag0 === "binary"){const _errs22: any = errors;if(errors === _errs22){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((data.outcome === undefined) && (missing2 = "outcome")){validate1671.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs24: any = errors;for(const key2 in data){if(!(key2 === "outcome")){validate1671.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs24 === errors){if(data.outcome !== undefined){let data7: any = data.outcome;if(typeof data7 !== "string"){validate1671.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/2/properties/outcome/type",keyword:"type",params:{type: "string"}}];return false;}if("binary" !== data7){validate1671.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/oneOf/2/properties/outcome/const",keyword:"const",params:{allowedValue: "binary"}}];return false;}}}}}else {validate1671.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}var valid6: any = _errs22 === errors;if(props0 !== true){props0 = true;}valid0 = valid6;}else {validate1671.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "outcome", tagValue: tag0}}];return false;}}else {validate1671.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "outcome", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key3 in data){if(!props0 || !props0[key3]){validate1671.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key3}}];return false;break;}}}}}else {validate1671.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1671.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1671.errors = null as any[] | null;
// prettier-ignore
validate1671.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1672(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionWorkingFolderSubscribeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1672.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validate1672.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "sessionId")){validate1672.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1672.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1672.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate1672.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1672.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1672.errors = null as any[] | null;
// prettier-ignore
validate1672.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema3113: any = {"description":"How the daemon noticed a working folder change: a file watch, or a slow tick for a folder too\nlarge for the machine's watch limit, so a late mark is never read as a tree that did not change.","type":"string","enum":["watch","slowTick"]};
// prettier-ignore
function validate1673(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkingTreeChange {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1673.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.changedAt === undefined) && (missing0 = "changedAt"))) || ((data.mode === undefined) && (missing0 = "mode"))){validate1673.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "changedAt")) || (key0 === "mode"))){validate1673.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1673.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1673.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.changedAt !== undefined){let data1: any = data.changedAt;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern5.test(data1)){validate1673.errors = [{instancePath:instancePath+"/changedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate1673.errors = [{instancePath:instancePath+"/changedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.mode !== undefined){let data2: any = data.mode;const _errs9: any = errors;if(typeof data2 !== "string"){validate1673.errors = [{instancePath:instancePath+"/mode",schemaPath:"#/$defs/WorkingTreeChangeMode/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data2 === "watch") || (data2 === "slowTick"))){validate1673.errors = [{instancePath:instancePath+"/mode",schemaPath:"#/$defs/WorkingTreeChangeMode/enum",keyword:"enum",params:{allowedValues: schema3113.enum}}];return false;}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}}}}}}else {validate1673.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1673.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1673.errors = null as any[] | null;
// prettier-ignore
validate1673.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link GitObjectId}. */
export const validateGitObjectId: SchemaCheck<GitObjectId> = validate1663;
/** Checks that a value is a {@link ProjectBranchListRequest}. */
export const validateProjectBranchListRequest: SchemaCheck<ProjectBranchListRequest> = validate1664;
/** Checks that a value is a {@link ProjectBranchListResponse}. */
export const validateProjectBranchListResponse: SchemaCheck<ProjectBranchListResponse> =
  validate1665;
/** Checks that a value is a {@link ProjectFileReadRequest}. */
export const validateProjectFileReadRequest: SchemaCheck<ProjectFileReadRequest> = validate1670;
/** Checks that a value is a {@link ProjectFileReadResponse}. */
export const validateProjectFileReadResponse: SchemaCheck<ProjectFileReadResponse> = validate1671;
/** Checks that a value is a {@link SessionWorkingFolderSubscribeRequest}. */
export const validateSessionWorkingFolderSubscribeRequest: SchemaCheck<SessionWorkingFolderSubscribeRequest> =
  validate1672;
/** Checks that a value is a {@link WorkingTreeChange}. */
export const validateWorkingTreeChange: SchemaCheck<WorkingTreeChange> = validate1673;
