// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Setting a new tree up, as the composer's setup card follows it, and its retry.

import { type CompiledSchemaCheck, ucs2length } from "../../schema-check.js";
import { type WorktreeId, validateWorktreeId } from "./lifecycle.js";

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
const schema1631: any = {"description":"The stages of setting a tree up, in the order they run.","type":"string","enum":["makeTree","projectSteps","warmCaches"]};
/** Checks that a value is a {@link WorktreeSetupStage}. */
// prettier-ignore
export const validateWorktreeSetupStage: CompiledSchemaCheck<WorktreeSetupStage> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorktreeSetupStage {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorktreeSetupStage.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateWorktreeSetupStage.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data === "makeTree") || (data === "projectSteps")) || (data === "warmCaches"))){validateWorktreeSetupStage.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1631.enum}}];return false;}validateWorktreeSetupStage.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorktreeSetupStage.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1632: any = {"description":"Where one setup step stands.","type":"string","enum":["pending","running","succeeded","failed"]};
/** Checks that a value is a {@link WorktreeSetupStepState}. */
// prettier-ignore
export const validateWorktreeSetupStepState: CompiledSchemaCheck<WorktreeSetupStepState> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorktreeSetupStepState {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorktreeSetupStepState.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateWorktreeSetupStepState.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((data === "pending") || (data === "running")) || (data === "succeeded")) || (data === "failed"))){validateWorktreeSetupStepState.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1632.enum}}];return false;}validateWorktreeSetupStepState.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorktreeSetupStepState.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1629: any = {"description":"Where a tree's setup card stands; `notRun`, with no steps, is a tree with no card to show: its\nsetup did not run since the daemon started, or it has none.","type":"string","enum":["running","succeeded","failed","notRun"]};
/** Checks that a value is a {@link WorktreeSetupState}. */
// prettier-ignore
export const validateWorktreeSetupState: CompiledSchemaCheck<WorktreeSetupState> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorktreeSetupState {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorktreeSetupState.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateWorktreeSetupState.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((data === "running") || (data === "succeeded")) || (data === "failed")) || (data === "notRun"))){validateWorktreeSetupState.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1629.enum}}];return false;}validateWorktreeSetupState.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorktreeSetupState.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern5 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
/** Checks that a value is a {@link WorktreeSetupStep}. */
// prettier-ignore
export const validateWorktreeSetupStep: CompiledSchemaCheck<WorktreeSetupStep> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorktreeSetupStep {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorktreeSetupStep.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.stage === undefined) && (missing0 = "stage")) || ((data.label === undefined) && (missing0 = "label"))) || ((data.state === undefined) && (missing0 = "state"))){validateWorktreeSetupStep.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((key0 === "stage") || (key0 === "label")) || (key0 === "state")) || (key0 === "elapsedMs")) || (key0 === "error")) || (key0 === "output"))){validateWorktreeSetupStep.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.stage !== undefined){const _errs2: any = errors;if(!(validateWorktreeSetupStage.call(this, data.stage, {instancePath:instancePath+"/stage",parentData:data,parentDataProperty:"stage",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorktreeSetupStage.errors : vErrors.concat(validateWorktreeSetupStage.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.label !== undefined){let data1: any = data.label;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 8192){validateWorktreeSetupStep.errors = [{instancePath:instancePath+"/label",schemaPath:"#/properties/label/maxLength",keyword:"maxLength",params:{limit: 8192}}];return false;}else {if(func1(data1) < 1){validateWorktreeSetupStep.errors = [{instancePath:instancePath+"/label",schemaPath:"#/properties/label/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data1)){validateWorktreeSetupStep.errors = [{instancePath:instancePath+"/label",schemaPath:"#/properties/label/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateWorktreeSetupStep.errors = [{instancePath:instancePath+"/label",schemaPath:"#/properties/label/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){const _errs5: any = errors;if(!(validateWorktreeSetupStepState.call(this, data.state, {instancePath:instancePath+"/state",parentData:data,parentDataProperty:"state",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorktreeSetupStepState.errors : vErrors.concat(validateWorktreeSetupStepState.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.elapsedMs !== undefined){let data3: any = data.elapsedMs;const _errs6: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validateWorktreeSetupStep.errors = [{instancePath:instancePath+"/elapsedMs",schemaPath:"#/properties/elapsedMs/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs6){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validateWorktreeSetupStep.errors = [{instancePath:instancePath+"/elapsedMs",schemaPath:"#/properties/elapsedMs/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 0 || isNaN(data3)){validateWorktreeSetupStep.errors = [{instancePath:instancePath+"/elapsedMs",schemaPath:"#/properties/elapsedMs/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.error !== undefined){let data4: any = data.error;const _errs8: any = errors;if(errors === _errs8){if(typeof data4 === "string"){if(func1(data4) > 8192){validateWorktreeSetupStep.errors = [{instancePath:instancePath+"/error",schemaPath:"#/properties/error/maxLength",keyword:"maxLength",params:{limit: 8192}}];return false;}else {if(func1(data4) < 1){validateWorktreeSetupStep.errors = [{instancePath:instancePath+"/error",schemaPath:"#/properties/error/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data4)){validateWorktreeSetupStep.errors = [{instancePath:instancePath+"/error",schemaPath:"#/properties/error/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateWorktreeSetupStep.errors = [{instancePath:instancePath+"/error",schemaPath:"#/properties/error/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.output !== undefined){let data5: any = data.output;const _errs10: any = errors;if(errors === _errs10){if(typeof data5 === "string"){if(func1(data5) > 32768){validateWorktreeSetupStep.errors = [{instancePath:instancePath+"/output",schemaPath:"#/properties/output/maxLength",keyword:"maxLength",params:{limit: 32768}}];return false;}else {if(func1(data5) < 1){validateWorktreeSetupStep.errors = [{instancePath:instancePath+"/output",schemaPath:"#/properties/output/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data5)){validateWorktreeSetupStep.errors = [{instancePath:instancePath+"/output",schemaPath:"#/properties/output/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateWorktreeSetupStep.errors = [{instancePath:instancePath+"/output",schemaPath:"#/properties/output/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}}}}else {validateWorktreeSetupStep.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorktreeSetupStep.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorktreeSetupStep.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorktreeSetupStatus}. */
// prettier-ignore
export const validateWorktreeSetupStatus: CompiledSchemaCheck<WorktreeSetupStatus> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorktreeSetupStatus {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorktreeSetupStatus.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.worktreeId === undefined) && (missing0 = "worktreeId")) || ((data.state === undefined) && (missing0 = "state"))) || ((data.steps === undefined) && (missing0 = "steps"))){validateWorktreeSetupStatus.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "worktreeId") || (key0 === "state")) || (key0 === "steps"))){validateWorktreeSetupStatus.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.worktreeId !== undefined){const _errs2: any = errors;if(!(validateWorktreeId.call(this, data.worktreeId, {instancePath:instancePath+"/worktreeId",parentData:data,parentDataProperty:"worktreeId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorktreeId.errors : vErrors.concat(validateWorktreeId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){const _errs3: any = errors;if(!(validateWorktreeSetupState.call(this, data.state, {instancePath:instancePath+"/state",parentData:data,parentDataProperty:"state",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorktreeSetupState.errors : vErrors.concat(validateWorktreeSetupState.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.steps !== undefined){let data2: any = data.steps;const _errs4: any = errors;if(errors === _errs4){if(Array.isArray(data2)){var valid1: any = true;const len0: any = data2.length;for(let i0=0; i0<len0; i0++){const _errs6: any = errors;if(!(validateWorktreeSetupStep.call(this, data2[i0], {instancePath:instancePath+"/steps/" + i0,parentData:data2,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorktreeSetupStep.errors : vErrors.concat(validateWorktreeSetupStep.errors);errors = vErrors.length;}var valid1: any = _errs6 === errors;if(!valid1){break;}}}else {validateWorktreeSetupStatus.errors = [{instancePath:instancePath+"/steps",schemaPath:"#/properties/steps/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}}else {validateWorktreeSetupStatus.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorktreeSetupStatus.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorktreeSetupStatus.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorktreeSetupRequest}. */
// prettier-ignore
export const validateWorktreeSetupRequest: CompiledSchemaCheck<WorktreeSetupRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorktreeSetupRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorktreeSetupRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.worktreeId === undefined) && (missing0 = "worktreeId")){validateWorktreeSetupRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "worktreeId")){validateWorktreeSetupRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.worktreeId !== undefined){if(!(validateWorktreeId.call(this, data.worktreeId, {instancePath:instancePath+"/worktreeId",parentData:data,parentDataProperty:"worktreeId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorktreeId.errors : vErrors.concat(validateWorktreeId.errors);errors = vErrors.length;}}}}}else {validateWorktreeSetupRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorktreeSetupRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorktreeSetupRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
