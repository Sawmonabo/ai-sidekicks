// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The summarized child-run projection a transcript row carries and `transcript.childRun.expand` expands.

import { type CompiledSchemaCheck, deepEqual } from "../../schema-check.js";
import { type WireInstant, validateWireInstant } from "../internal/wire-scalars.js";
import { type RunId, validateRunId } from "../run/id.js";
import { type RunState, validateRunState } from "../run/state.js";

/**
 * Why a child-run summary is not the whole picture. Closed; a context compaction is not one.
 */
export type ChildRunIncompleteCause = "detailFetchFailed";
/**
 * Whether a summary row reflects the child run's full activity, and if not, why and as of when.
 * `observedAt` is required because the cause is transient: a retry decision and the age of the
 * notice both need to know how old it is.
 */
export type ChildRunCompleteness =
  | {
      state: "complete";
    }
  | {
      state: "incomplete";
      /**
       * Why.
       */
      cause: ChildRunIncompleteCause;
      /**
       * When the daemon noticed.
       */
      observedAt: WireInstant;
    };

/**
 * The summarized child-run projection: its parent, state, event count and completeness. No run
 * is its own parent.
 */
export interface ChildRunSummary {
  /**
   * The child run.
   */
  runId: RunId;
  /**
   * The run that started it; never the child itself.
   */
  parentRunId: RunId;
  /**
   * The child's state.
   */
  state: RunState;
  /**
   * How many events the daemon holds for it; on the `incomplete` arm a lower bound.
   */
  eventCount: number;
  /**
   * Whether the summary is the whole picture.
   */
  completeness: ChildRunCompleteness;
}

// prettier-ignore
const schema1280: any = {"description":"Why a child-run summary is not the whole picture. Closed; a context compaction is not one.","type":"string","enum":["detailFetchFailed"]};
/** Checks that a value is a {@link ChildRunIncompleteCause}. */
// prettier-ignore
export const validateChildRunIncompleteCause: CompiledSchemaCheck<ChildRunIncompleteCause> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ChildRunIncompleteCause {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateChildRunIncompleteCause.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateChildRunIncompleteCause.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data === "detailFetchFailed")){validateChildRunIncompleteCause.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1280.enum}}];return false;}validateChildRunIncompleteCause.errors = vErrors;return errors === 0;};
// prettier-ignore
validateChildRunIncompleteCause.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ChildRunCompleteness}. */
// prettier-ignore
export const validateChildRunCompleteness: CompiledSchemaCheck<ChildRunCompleteness> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ChildRunCompleteness {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateChildRunCompleteness.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.state;if(typeof tag0 == "string"){if(tag0 === "complete"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.state === undefined) && (missing0 = "state")){validateChildRunCompleteness.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!(key0 === "state")){validateChildRunCompleteness.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.state !== undefined){let data0: any = data.state;if(typeof data0 !== "string"){validateChildRunCompleteness.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/0/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("complete" !== data0){validateChildRunCompleteness.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/0/properties/state/const",keyword:"const",params:{allowedValue: "complete"}}];return false;}}}}}else {validateChildRunCompleteness.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "incomplete"){const _errs7: any = errors;if(errors === _errs7){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((data.state === undefined) && (missing1 = "state")) || ((data.cause === undefined) && (missing1 = "cause"))) || ((data.observedAt === undefined) && (missing1 = "observedAt"))){validateChildRunCompleteness.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs9: any = errors;for(const key1 in data){if(!(((key1 === "state") || (key1 === "cause")) || (key1 === "observedAt"))){validateChildRunCompleteness.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs9 === errors){if(data.state !== undefined){let data1: any = data.state;const _errs10: any = errors;if(typeof data1 !== "string"){validateChildRunCompleteness.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/1/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("incomplete" !== data1){validateChildRunCompleteness.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/1/properties/state/const",keyword:"const",params:{allowedValue: "incomplete"}}];return false;}var valid4: any = _errs10 === errors;}else {var valid4: any = true;}if(valid4){if(data.cause !== undefined){const _errs12: any = errors;if(!(validateChildRunIncompleteCause.call(this, data.cause, {instancePath:instancePath+"/cause",parentData:data,parentDataProperty:"cause",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateChildRunIncompleteCause.errors : vErrors.concat(validateChildRunIncompleteCause.errors);errors = vErrors.length;}var valid4: any = _errs12 === errors;}else {var valid4: any = true;}if(valid4){if(data.observedAt !== undefined){const _errs13: any = errors;if(!(validateWireInstant.call(this, data.observedAt, {instancePath:instancePath+"/observedAt",parentData:data,parentDataProperty:"observedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid4: any = _errs13 === errors;}else {var valid4: any = true;}}}}}}else {validateChildRunCompleteness.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs7 === errors;if(props0 !== true){props0 = true;}valid0 = valid3;}else {validateChildRunCompleteness.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "state", tagValue: tag0}}];return false;}}else {validateChildRunCompleteness.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "state", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key2 in data){if(!props0 || !props0[key2]){validateChildRunCompleteness.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key2}}];return false;break;}}}}}else {validateChildRunCompleteness.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateChildRunCompleteness.errors = vErrors;return errors === 0;};
// prettier-ignore
validateChildRunCompleteness.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const func0 = deepEqual;
/** Checks that a value is a {@link ChildRunSummary}. */
// prettier-ignore
export const validateChildRunSummary: CompiledSchemaCheck<ChildRunSummary> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ChildRunSummary {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateChildRunSummary.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((data.runId === undefined) && (missing0 = "runId")) || ((data.parentRunId === undefined) && (missing0 = "parentRunId"))) || ((data.state === undefined) && (missing0 = "state"))) || ((data.eventCount === undefined) && (missing0 = "eventCount"))) || ((data.completeness === undefined) && (missing0 = "completeness"))){validateChildRunSummary.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "runId") || (key0 === "parentRunId")) || (key0 === "state")) || (key0 === "eventCount")) || (key0 === "completeness"))){validateChildRunSummary.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.runId !== undefined){const _errs2: any = errors;if(!(validateRunId.call(this, data.runId, {instancePath:instancePath+"/runId",parentData:data,parentDataProperty:"runId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunId.errors : vErrors.concat(validateRunId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.parentRunId !== undefined){let data1: any = data.parentRunId;const _errs3: any = errors;if(typeof data1 !== "string"){validateChildRunSummary.errors = [{instancePath:instancePath+"/parentRunId",schemaPath:"#/properties/parentRunId/type",keyword:"type",params:{type: "string"}}];return false;}if(!(validateRunId.call(this, data1, {instancePath:instancePath+"/parentRunId",parentData:data,parentDataProperty:"parentRunId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunId.errors : vErrors.concat(validateRunId.errors);errors = vErrors.length;}else {const _errs5: any = errors;const _errs6: any = errors;const vSchema0: any = data && data.runId;if(vSchema0 !== undefined && (!func0(data1, vSchema0))){const err0: any = {};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var valid1: any = _errs6 === errors;if(valid1){validateChildRunSummary.errors = [{instancePath:instancePath+"/parentRunId",schemaPath:"#/properties/parentRunId/not",keyword:"not",params:{}}];return false;}else {errors = _errs5;if(vErrors !== null){if(_errs5){vErrors.length = _errs5;}else {vErrors = null;}}}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){const _errs7: any = errors;if(!(validateRunState.call(this, data.state, {instancePath:instancePath+"/state",parentData:data,parentDataProperty:"state",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunState.errors : vErrors.concat(validateRunState.errors);errors = vErrors.length;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.eventCount !== undefined){let data3: any = data.eventCount;const _errs8: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validateChildRunSummary.errors = [{instancePath:instancePath+"/eventCount",schemaPath:"#/properties/eventCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs8){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validateChildRunSummary.errors = [{instancePath:instancePath+"/eventCount",schemaPath:"#/properties/eventCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 0 || isNaN(data3)){validateChildRunSummary.errors = [{instancePath:instancePath+"/eventCount",schemaPath:"#/properties/eventCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.completeness !== undefined){const _errs10: any = errors;if(!(validateChildRunCompleteness.call(this, data.completeness, {instancePath:instancePath+"/completeness",parentData:data,parentDataProperty:"completeness",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateChildRunCompleteness.errors : vErrors.concat(validateChildRunCompleteness.errors);errors = vErrors.length;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}}}else {validateChildRunSummary.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateChildRunSummary.errors = vErrors;return errors === 0;};
// prettier-ignore
validateChildRunSummary.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
