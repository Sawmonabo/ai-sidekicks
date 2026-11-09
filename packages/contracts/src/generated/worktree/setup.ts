/* eslint-disable */
// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Setting a new tree up, as the composer's setup card follows it, and its retry.

import { type SchemaCheck, ucs2length } from "../../schema-check.js";
import type { WorktreeId } from "./lifecycle.js";

/**
 * The longest captured output a setup step carries; the daemon keeps the tail of a longer
 * output, cut to this many code points.
 */
export const WORKTREE_SETUP_OUTPUT_MAX_LEN = 32768 as const;

/**
 * The stages of setting a tree up, in the order they run.
 */
export type WorktreeSetupStage = "makeTree" | "projectSteps" | "warmCaches";
/**
 * Where one setup step stands.
 */
export type WorktreeSetupStepState = "pending" | "running" | "succeeded" | "failed";
/**
 * Where a tree's setup card stands; `notRun`, with no steps, is a tree with no card to show: its
 * setup did not run since the daemon started, or it has none.
 */
export type WorktreeSetupState = "running" | "succeeded" | "failed" | "notRun";

/**
 * One step of the setup card, in run order. `error` and `output` are present on a failed step,
 * `output` also on a made tree's step whose checkout hook failed, and `elapsedMs` once the step
 * has run.
 */
export interface WorktreeSetupStep {
  /**
   * Its stage.
   */
  stage: WorktreeSetupStage;
  /**
   * What it is: the command, for a project step.
   */
  label: string;
  /**
   * Where it stands.
   */
  state: WorktreeSetupStepState;
  /**
   * How long it ran, in milliseconds.
   */
  elapsedMs?: number;
  /**
   * Why it failed.
   */
  error?: string;
  /**
   * Its captured output.
   */
  output?: string;
}
/**
 * One `worktree.setup.subscribe` emission: the whole card for one tree.
 */
export interface WorktreeSetupStatus {
  /**
   * The tree.
   */
  worktreeId: WorktreeId;
  /**
   * Where the card stands.
   */
  state: WorktreeSetupState;
  /**
   * Its steps.
   */
  steps: WorktreeSetupStep[];
}
/**
 * `worktree.setup.subscribe` and `worktree.setup.retry`: the tree whose setup a card follows
 * or retries. A retry runs the failed step and the ones after it.
 */
export interface WorktreeSetupRequest {
  /**
   * The tree.
   */
  worktreeId: WorktreeId;
}

// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
function validate2988(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorktreeSetupRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2988.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.worktreeId === undefined) && (missing0 = "worktreeId")){validate2988.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "worktreeId")){validate2988.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.worktreeId !== undefined){let data0: any = data.worktreeId;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2988.errors = [{instancePath:instancePath+"/worktreeId",schemaPath:"sidekicks-contracts:worktree/lifecycle#/$defs/WorktreeId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2988.errors = [{instancePath:instancePath+"/worktreeId",schemaPath:"sidekicks-contracts:worktree/lifecycle#/$defs/WorktreeId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate2988.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2988.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2988.errors = null as any[] | null;
// prettier-ignore
validate2988.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema5668: any = {"description":"Where a tree's setup card stands; `notRun`, with no steps, is a tree with no card to show: its\nsetup did not run since the daemon started, or it has none.","type":"string","enum":["running","succeeded","failed","notRun"]};
// prettier-ignore
const schema5670: any = {"description":"The stages of setting a tree up, in the order they run.","type":"string","enum":["makeTree","projectSteps","warmCaches"]};
// prettier-ignore
const schema5671: any = {"description":"Where one setup step stands.","type":"string","enum":["pending","running","succeeded","failed"]};
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
function validate2990(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2990.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.stage === undefined) && (missing0 = "stage")) || ((data.label === undefined) && (missing0 = "label"))) || ((data.state === undefined) && (missing0 = "state"))){validate2990.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((key0 === "stage") || (key0 === "label")) || (key0 === "state")) || (key0 === "elapsedMs")) || (key0 === "error")) || (key0 === "output"))){validate2990.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.stage !== undefined){let data0: any = data.stage;const _errs2: any = errors;if(typeof data0 !== "string"){validate2990.errors = [{instancePath:instancePath+"/stage",schemaPath:"#/$defs/WorktreeSetupStage/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data0 === "makeTree") || (data0 === "projectSteps")) || (data0 === "warmCaches"))){validate2990.errors = [{instancePath:instancePath+"/stage",schemaPath:"#/$defs/WorktreeSetupStage/enum",keyword:"enum",params:{allowedValues: schema5670.enum}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.label !== undefined){let data1: any = data.label;const _errs5: any = errors;if(errors === _errs5){if(typeof data1 === "string"){if(func1(data1) > 8192){validate2990.errors = [{instancePath:instancePath+"/label",schemaPath:"#/properties/label/maxLength",keyword:"maxLength",params:{limit: 8192}}];return false;}else {if(func1(data1) < 1){validate2990.errors = [{instancePath:instancePath+"/label",schemaPath:"#/properties/label/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data1)){validate2990.errors = [{instancePath:instancePath+"/label",schemaPath:"#/properties/label/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate2990.errors = [{instancePath:instancePath+"/label",schemaPath:"#/properties/label/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){let data2: any = data.state;const _errs7: any = errors;if(typeof data2 !== "string"){validate2990.errors = [{instancePath:instancePath+"/state",schemaPath:"#/$defs/WorktreeSetupStepState/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((data2 === "pending") || (data2 === "running")) || (data2 === "succeeded")) || (data2 === "failed"))){validate2990.errors = [{instancePath:instancePath+"/state",schemaPath:"#/$defs/WorktreeSetupStepState/enum",keyword:"enum",params:{allowedValues: schema5671.enum}}];return false;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.elapsedMs !== undefined){let data3: any = data.elapsedMs;const _errs10: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validate2990.errors = [{instancePath:instancePath+"/elapsedMs",schemaPath:"#/properties/elapsedMs/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs10){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validate2990.errors = [{instancePath:instancePath+"/elapsedMs",schemaPath:"#/properties/elapsedMs/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 0 || isNaN(data3)){validate2990.errors = [{instancePath:instancePath+"/elapsedMs",schemaPath:"#/properties/elapsedMs/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.error !== undefined){let data4: any = data.error;const _errs12: any = errors;if(errors === _errs12){if(typeof data4 === "string"){if(func1(data4) > 8192){validate2990.errors = [{instancePath:instancePath+"/error",schemaPath:"#/properties/error/maxLength",keyword:"maxLength",params:{limit: 8192}}];return false;}else {if(func1(data4) < 1){validate2990.errors = [{instancePath:instancePath+"/error",schemaPath:"#/properties/error/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data4)){validate2990.errors = [{instancePath:instancePath+"/error",schemaPath:"#/properties/error/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate2990.errors = [{instancePath:instancePath+"/error",schemaPath:"#/properties/error/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.output !== undefined){let data5: any = data.output;const _errs14: any = errors;if(errors === _errs14){if(typeof data5 === "string"){if(func1(data5) > 32768){validate2990.errors = [{instancePath:instancePath+"/output",schemaPath:"#/properties/output/maxLength",keyword:"maxLength",params:{limit: 32768}}];return false;}else {if(func1(data5) < 1){validate2990.errors = [{instancePath:instancePath+"/output",schemaPath:"#/properties/output/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data5)){validate2990.errors = [{instancePath:instancePath+"/output",schemaPath:"#/properties/output/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate2990.errors = [{instancePath:instancePath+"/output",schemaPath:"#/properties/output/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}}}}}}}}}else {validate2990.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2990.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2990.errors = null as any[] | null;
// prettier-ignore
validate2990.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2989(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorktreeSetupStatus {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2989.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.worktreeId === undefined) && (missing0 = "worktreeId")) || ((data.state === undefined) && (missing0 = "state"))) || ((data.steps === undefined) && (missing0 = "steps"))){validate2989.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "worktreeId") || (key0 === "state")) || (key0 === "steps"))){validate2989.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.worktreeId !== undefined){let data0: any = data.worktreeId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2989.errors = [{instancePath:instancePath+"/worktreeId",schemaPath:"sidekicks-contracts:worktree/lifecycle#/$defs/WorktreeId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2989.errors = [{instancePath:instancePath+"/worktreeId",schemaPath:"sidekicks-contracts:worktree/lifecycle#/$defs/WorktreeId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){let data1: any = data.state;const _errs6: any = errors;if(typeof data1 !== "string"){validate2989.errors = [{instancePath:instancePath+"/state",schemaPath:"#/$defs/WorktreeSetupState/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((data1 === "running") || (data1 === "succeeded")) || (data1 === "failed")) || (data1 === "notRun"))){validate2989.errors = [{instancePath:instancePath+"/state",schemaPath:"#/$defs/WorktreeSetupState/enum",keyword:"enum",params:{allowedValues: schema5668.enum}}];return false;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.steps !== undefined){let data2: any = data.steps;const _errs9: any = errors;if(errors === _errs9){if(Array.isArray(data2)){var valid3: any = true;const len0: any = data2.length;for(let i0=0; i0<len0; i0++){const _errs11: any = errors;if(!(validate2990.call(this, data2[i0], {instancePath:instancePath+"/steps/" + i0,parentData:data2,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2990.errors : vErrors.concat(validate2990.errors);errors = vErrors.length;}var valid3: any = _errs11 === errors;if(!valid3){break;}}}else {validate2989.errors = [{instancePath:instancePath+"/steps",schemaPath:"#/properties/steps/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}}}}}}else {validate2989.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2989.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2989.errors = null as any[] | null;
// prettier-ignore
validate2989.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorktreeSetupRequest}. */
export const validateWorktreeSetupRequest: SchemaCheck<WorktreeSetupRequest> = validate2988;
/** Checks that a value is a {@link WorktreeSetupStatus}. */
export const validateWorktreeSetupStatus: SchemaCheck<WorktreeSetupStatus> = validate2989;
