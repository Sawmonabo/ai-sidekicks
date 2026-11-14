// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The payload of a provider's own subagent starting and finishing under a run.

import { type CompiledSchemaCheck, ucs2length } from "../../schema-check.js";
import {
  type SourceEpoch,
  type SourcePosition,
  validateSourceEpoch,
  validateSourcePosition,
} from "../event/envelope.js";
import { type ProviderId, validateProviderId } from "../provider/id.js";
import { type ToolCallId, validateToolCallId } from "../provider/tool-call.js";
import { type SessionId, validateSessionId } from "../session/id.js";
import { type RunId, validateRunId } from "./id.js";

/**
 * A provider's own id of one helper, unique within its provider's run.
 */
export type SubagentId = string & { readonly __brand: "SubagentId" };

/**
 * The `agent.subagent.started`, `agent.subagent.completed` and `agent.subagent.stopped` payload:
 * a helper the provider started under the run `run_id`, by the provider's own id, and the tool
 * call it was opened under where the provider names one, and the helper's own run where one was
 * started. `subagent_id` is unique only within its provider's run, so a completion pairs to its
 * start on `run_id`, `provider` and `subagent_id` together. A stop of a helper already interrupted
 * carries the run the helper runs under in `run_id` and the helper's own run in `child_run_id`. It
 * takes the epoch stamp: `source_epoch` and `source_position` come together.
 */
export interface SubagentLifecyclePayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run the helper runs under.
   */
  runId: RunId;
  /**
   * The provider.
   */
  provider: ProviderId;
  /**
   * The provider's own id for the helper.
   */
  subagentId: SubagentId;
  /**
   * The helper's own run, which its usage is counted toward, where the daemon started one.
   */
  childRunId?: RunId;
  /**
   * The tool call the helper was opened under, where the provider names one.
   */
  parentToolCallId?: ToolCallId;
  /**
   * The execution epoch a late row is attributed to; comes with `source_position`.
   */
  sourceEpoch?: SourceEpoch;
  /**
   * The run position the row occupies within its epoch; comes with `source_epoch`.
   */
  sourcePosition?: SourcePosition;
}

// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern5 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
/** Checks that a value is a {@link SubagentId}. */
// prettier-ignore
export const validateSubagentId: CompiledSchemaCheck<SubagentId> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SubagentId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSubagentId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) > 256){validateSubagentId.errors = [{instancePath,schemaPath:"#/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data) < 1){validateSubagentId.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data)){validateSubagentId.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateSubagentId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateSubagentId.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSubagentId.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SubagentLifecyclePayload}. */
// prettier-ignore
export const validateSubagentLifecyclePayload: CompiledSchemaCheck<SubagentLifecyclePayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SubagentLifecyclePayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSubagentLifecyclePayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.runId === undefined) && (missing0 = "runId"))) || ((data.provider === undefined) && (missing0 = "provider"))) || ((data.subagentId === undefined) && (missing0 = "subagentId"))){validateSubagentLifecyclePayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((((key0 === "sessionId") || (key0 === "runId")) || (key0 === "provider")) || (key0 === "subagentId")) || (key0 === "childRunId")) || (key0 === "parentToolCallId")) || (key0 === "sourceEpoch")) || (key0 === "sourcePosition"))){validateSubagentLifecyclePayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.runId !== undefined){const _errs3: any = errors;if(!(validateRunId.call(this, data.runId, {instancePath:instancePath+"/runId",parentData:data,parentDataProperty:"runId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunId.errors : vErrors.concat(validateRunId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.provider !== undefined){const _errs4: any = errors;if(!(validateProviderId.call(this, data.provider, {instancePath:instancePath+"/provider",parentData:data,parentDataProperty:"provider",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderId.errors : vErrors.concat(validateProviderId.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.subagentId !== undefined){const _errs5: any = errors;if(!(validateSubagentId.call(this, data.subagentId, {instancePath:instancePath+"/subagentId",parentData:data,parentDataProperty:"subagentId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSubagentId.errors : vErrors.concat(validateSubagentId.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.childRunId !== undefined){const _errs6: any = errors;if(!(validateRunId.call(this, data.childRunId, {instancePath:instancePath+"/childRunId",parentData:data,parentDataProperty:"childRunId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunId.errors : vErrors.concat(validateRunId.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.parentToolCallId !== undefined){const _errs7: any = errors;if(!(validateToolCallId.call(this, data.parentToolCallId, {instancePath:instancePath+"/parentToolCallId",parentData:data,parentDataProperty:"parentToolCallId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateToolCallId.errors : vErrors.concat(validateToolCallId.errors);errors = vErrors.length;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.sourceEpoch !== undefined){const _errs8: any = errors;if(!(validateSourceEpoch.call(this, data.sourceEpoch, {instancePath:instancePath+"/sourceEpoch",parentData:data,parentDataProperty:"sourceEpoch",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSourceEpoch.errors : vErrors.concat(validateSourceEpoch.errors);errors = vErrors.length;}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.sourcePosition !== undefined){const _errs9: any = errors;if(!(validateSourcePosition.call(this, data.sourcePosition, {instancePath:instancePath+"/sourcePosition",parentData:data,parentDataProperty:"sourcePosition",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSourcePosition.errors : vErrors.concat(validateSourcePosition.errors);errors = vErrors.length;}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){let missing1: any;if(data.sourceEpoch !== undefined && (((data.sourcePosition === undefined) && (missing1 = "sourcePosition")) || ((data.runId === undefined) && (missing1 = "runId")))){validateSubagentLifecyclePayload.errors = [{instancePath,schemaPath:"#/dependentRequired",keyword:"dependentRequired",params:{property: "sourceEpoch",
    missingProperty: missing1,
    depsCount: 2,
    deps: "sourcePosition, runId"}}];return false;}else {if(data.sourcePosition !== undefined && (((data.sourceEpoch === undefined) && (missing1 = "sourceEpoch")) || ((data.runId === undefined) && (missing1 = "runId")))){validateSubagentLifecyclePayload.errors = [{instancePath,schemaPath:"#/dependentRequired",keyword:"dependentRequired",params:{property: "sourcePosition",
    missingProperty: missing1,
    depsCount: 2,
    deps: "sourceEpoch, runId"}}];return false;}}}}}}}}}}}}}else {validateSubagentLifecyclePayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSubagentLifecyclePayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSubagentLifecyclePayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
