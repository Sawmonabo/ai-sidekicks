/* eslint-disable */
// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The copies across volumes a removal or a put-back makes, while they run.

import { type SchemaCheck, ucs2length } from "../../schema-check.js";
import type { ProjectId } from "../project.js";
import type { RemovedWorktreeId, WorktreeId } from "./lifecycle.js";

/**
 * One copy under way, by the row it draws on: a worktree being removed, by its `repoMount.list`
 * and `worktree.status.read` id, or a kept worktree being put back, by its
 * `worktree.removed.list` id. The bytes written count the file being copied.
 */
export type WorktreeCopy =
  | {
      kind: "removing";
      /**
       * The worktree.
       */
      worktreeId: WorktreeId;
      /**
       * Its project.
       */
      projectId: ProjectId;
      /**
       * The name its row shows.
       */
      name: string;
      /**
       * Bytes written so far.
       */
      copiedBytes: number;
      /**
       * Bytes of every file it makes.
       */
      totalBytes: number;
    }
  | {
      kind: "puttingBack";
      /**
       * The kept worktree.
       */
      removedWorktreeId: RemovedWorktreeId;
      /**
       * Its project.
       */
      projectId: ProjectId;
      /**
       * The name its row shows.
       */
      name: string;
      /**
       * Bytes written so far.
       */
      copiedBytes: number;
      /**
       * Bytes of every file it makes.
       */
      totalBytes: number;
    };

/**
 * `worktree.copy.subscribe`: one project's copies under way, or every project's.
 */
export interface WorktreeCopySubscribeRequest {
  /**
   * The project; absent follows every project.
   */
  projectId?: ProjectId;
}
/**
 * One `worktree.copy.subscribe` emission: every copy under way, sent whole on each change.
 */
export interface WorktreeCopyProgress {
  /**
   * The copies.
   */
  copies: WorktreeCopy[];
}

// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
function validate2959(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2959.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs2: any = errors;for(const key0 in data){validate2959.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key0}}];return false;break;}if(_errs2 === errors){const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "removing"){const _errs3: any = errors;if(errors === _errs3){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((((data.kind === undefined) && (missing0 = "kind")) || ((data.worktreeId === undefined) && (missing0 = "worktreeId"))) || ((data.projectId === undefined) && (missing0 = "projectId"))) || ((data.name === undefined) && (missing0 = "name"))) || ((data.copiedBytes === undefined) && (missing0 = "copiedBytes"))) || ((data.totalBytes === undefined) && (missing0 = "totalBytes"))){validate2959.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs5: any = errors;for(const key1 in data){if(!((((((key1 === "kind") || (key1 === "worktreeId")) || (key1 === "projectId")) || (key1 === "name")) || (key1 === "copiedBytes")) || (key1 === "totalBytes"))){validate2959.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs5 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs6: any = errors;if(typeof data0 !== "string"){validate2959.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("removing" !== data0){validate2959.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "removing"}}];return false;}var valid2: any = _errs6 === errors;}else {var valid2: any = true;}if(valid2){if(data.worktreeId !== undefined){let data1: any = data.worktreeId;const _errs8: any = errors;const _errs9: any = errors;if(errors === _errs9){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate2959.errors = [{instancePath:instancePath+"/worktreeId",schemaPath:"sidekicks-contracts:worktree/lifecycle#/$defs/WorktreeId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2959.errors = [{instancePath:instancePath+"/worktreeId",schemaPath:"sidekicks-contracts:worktree/lifecycle#/$defs/WorktreeId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}if(valid2){if(data.projectId !== undefined){let data2: any = data.projectId;const _errs12: any = errors;const _errs13: any = errors;if(errors === _errs13){if(typeof data2 === "string"){if(!pattern4.test(data2)){validate2959.errors = [{instancePath:instancePath+"/projectId",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2959.errors = [{instancePath:instancePath+"/projectId",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs12 === errors;}else {var valid2: any = true;}if(valid2){if(data.name !== undefined){let data3: any = data.name;const _errs16: any = errors;if(errors === _errs16){if(typeof data3 === "string"){if(func1(data3) > 4096){validate2959.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/0/properties/name/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data3) < 1){validate2959.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/0/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data3)){validate2959.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/0/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate2959.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/0/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs16 === errors;}else {var valid2: any = true;}if(valid2){if(data.copiedBytes !== undefined){let data4: any = data.copiedBytes;const _errs18: any = errors;if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){validate2959.errors = [{instancePath:instancePath+"/copiedBytes",schemaPath:"#/oneOf/0/properties/copiedBytes/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs18){if((typeof data4 == "number") && (isFinite(data4))){if(data4 > 9007199254740991 || isNaN(data4)){validate2959.errors = [{instancePath:instancePath+"/copiedBytes",schemaPath:"#/oneOf/0/properties/copiedBytes/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data4 < 0 || isNaN(data4)){validate2959.errors = [{instancePath:instancePath+"/copiedBytes",schemaPath:"#/oneOf/0/properties/copiedBytes/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs18 === errors;}else {var valid2: any = true;}if(valid2){if(data.totalBytes !== undefined){let data5: any = data.totalBytes;const _errs20: any = errors;if(!(((typeof data5 == "number") && (!(data5 % 1) && !isNaN(data5))) && (isFinite(data5)))){validate2959.errors = [{instancePath:instancePath+"/totalBytes",schemaPath:"#/oneOf/0/properties/totalBytes/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs20){if((typeof data5 == "number") && (isFinite(data5))){if(data5 > 9007199254740991 || isNaN(data5)){validate2959.errors = [{instancePath:instancePath+"/totalBytes",schemaPath:"#/oneOf/0/properties/totalBytes/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data5 < 0 || isNaN(data5)){validate2959.errors = [{instancePath:instancePath+"/totalBytes",schemaPath:"#/oneOf/0/properties/totalBytes/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs20 === errors;}else {var valid2: any = true;}}}}}}}}}else {validate2959.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "puttingBack"){const _errs22: any = errors;if(errors === _errs22){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((((((data.kind === undefined) && (missing1 = "kind")) || ((data.removedWorktreeId === undefined) && (missing1 = "removedWorktreeId"))) || ((data.projectId === undefined) && (missing1 = "projectId"))) || ((data.name === undefined) && (missing1 = "name"))) || ((data.copiedBytes === undefined) && (missing1 = "copiedBytes"))) || ((data.totalBytes === undefined) && (missing1 = "totalBytes"))){validate2959.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs24: any = errors;for(const key2 in data){if(!((((((key2 === "kind") || (key2 === "removedWorktreeId")) || (key2 === "projectId")) || (key2 === "name")) || (key2 === "copiedBytes")) || (key2 === "totalBytes"))){validate2959.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs24 === errors){if(data.kind !== undefined){let data6: any = data.kind;const _errs25: any = errors;if(typeof data6 !== "string"){validate2959.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("puttingBack" !== data6){validate2959.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "puttingBack"}}];return false;}var valid6: any = _errs25 === errors;}else {var valid6: any = true;}if(valid6){if(data.removedWorktreeId !== undefined){let data7: any = data.removedWorktreeId;const _errs27: any = errors;const _errs28: any = errors;if(errors === _errs28){if(typeof data7 === "string"){if(!pattern4.test(data7)){validate2959.errors = [{instancePath:instancePath+"/removedWorktreeId",schemaPath:"sidekicks-contracts:worktree/lifecycle#/$defs/RemovedWorktreeId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2959.errors = [{instancePath:instancePath+"/removedWorktreeId",schemaPath:"sidekicks-contracts:worktree/lifecycle#/$defs/RemovedWorktreeId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid6: any = _errs27 === errors;}else {var valid6: any = true;}if(valid6){if(data.projectId !== undefined){let data8: any = data.projectId;const _errs31: any = errors;const _errs32: any = errors;if(errors === _errs32){if(typeof data8 === "string"){if(!pattern4.test(data8)){validate2959.errors = [{instancePath:instancePath+"/projectId",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2959.errors = [{instancePath:instancePath+"/projectId",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid6: any = _errs31 === errors;}else {var valid6: any = true;}if(valid6){if(data.name !== undefined){let data9: any = data.name;const _errs35: any = errors;if(errors === _errs35){if(typeof data9 === "string"){if(func1(data9) > 4096){validate2959.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/1/properties/name/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data9) < 1){validate2959.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/1/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data9)){validate2959.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/1/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate2959.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/1/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid6: any = _errs35 === errors;}else {var valid6: any = true;}if(valid6){if(data.copiedBytes !== undefined){let data10: any = data.copiedBytes;const _errs37: any = errors;if(!(((typeof data10 == "number") && (!(data10 % 1) && !isNaN(data10))) && (isFinite(data10)))){validate2959.errors = [{instancePath:instancePath+"/copiedBytes",schemaPath:"#/oneOf/1/properties/copiedBytes/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs37){if((typeof data10 == "number") && (isFinite(data10))){if(data10 > 9007199254740991 || isNaN(data10)){validate2959.errors = [{instancePath:instancePath+"/copiedBytes",schemaPath:"#/oneOf/1/properties/copiedBytes/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data10 < 0 || isNaN(data10)){validate2959.errors = [{instancePath:instancePath+"/copiedBytes",schemaPath:"#/oneOf/1/properties/copiedBytes/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid6: any = _errs37 === errors;}else {var valid6: any = true;}if(valid6){if(data.totalBytes !== undefined){let data11: any = data.totalBytes;const _errs39: any = errors;if(!(((typeof data11 == "number") && (!(data11 % 1) && !isNaN(data11))) && (isFinite(data11)))){validate2959.errors = [{instancePath:instancePath+"/totalBytes",schemaPath:"#/oneOf/1/properties/totalBytes/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs39){if((typeof data11 == "number") && (isFinite(data11))){if(data11 > 9007199254740991 || isNaN(data11)){validate2959.errors = [{instancePath:instancePath+"/totalBytes",schemaPath:"#/oneOf/1/properties/totalBytes/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data11 < 0 || isNaN(data11)){validate2959.errors = [{instancePath:instancePath+"/totalBytes",schemaPath:"#/oneOf/1/properties/totalBytes/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid6: any = _errs39 === errors;}else {var valid6: any = true;}}}}}}}}}else {validate2959.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}}else {validate2959.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validate2959.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}}}else {validate2959.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2959.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2959.errors = null as any[] | null;
// prettier-ignore
validate2959.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2958(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorktreeCopyProgress {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2958.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.copies === undefined) && (missing0 = "copies")){validate2958.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "copies")){validate2958.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.copies !== undefined){let data0: any = data.copies;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validate2959.call(this, data0[i0], {instancePath:instancePath+"/copies/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2959.errors : vErrors.concat(validate2959.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validate2958.errors = [{instancePath:instancePath+"/copies",schemaPath:"#/properties/copies/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validate2958.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2958.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2958.errors = null as any[] | null;
// prettier-ignore
validate2958.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2961(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorktreeCopySubscribeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2961.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs1: any = errors;for(const key0 in data){if(!(key0 === "projectId")){validate2961.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.projectId !== undefined){let data0: any = data.projectId;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2961.errors = [{instancePath:instancePath+"/projectId",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2961.errors = [{instancePath:instancePath+"/projectId",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}else {validate2961.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2961.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2961.errors = null as any[] | null;
// prettier-ignore
validate2961.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorktreeCopyProgress}. */
export const validateWorktreeCopyProgress: SchemaCheck<WorktreeCopyProgress> = validate2958;
/** Checks that a value is a {@link WorktreeCopySubscribeRequest}. */
export const validateWorktreeCopySubscribeRequest: SchemaCheck<WorktreeCopySubscribeRequest> =
  validate2961;
