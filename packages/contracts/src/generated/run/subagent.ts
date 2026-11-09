// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The payload of a provider's own subagent starting and finishing under a run.

import { type SchemaCheck, ucs2length } from "../../schema-check.js";
import type { SourceEpoch, SourcePosition } from "../event/envelope.js";
import type { ProviderId } from "../provider/id.js";
import type { ToolCallId } from "../provider/tool-call.js";
import type { SessionId } from "../session/id.js";
import type { RunId } from "./id.js";

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
   * The turn position the row occupies within its epoch; comes with `source_epoch`.
   */
  sourcePosition?: SourcePosition;
}

// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
const pattern16 = new RegExp("^[a-z][a-z0-9-]{0,31}$", "u");
// prettier-ignore
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
function validate1817(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SubagentLifecyclePayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1817.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.runId === undefined) && (missing0 = "runId"))) || ((data.provider === undefined) && (missing0 = "provider"))) || ((data.subagentId === undefined) && (missing0 = "subagentId"))){validate1817.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((((key0 === "sessionId") || (key0 === "runId")) || (key0 === "provider")) || (key0 === "subagentId")) || (key0 === "childRunId")) || (key0 === "parentToolCallId")) || (key0 === "sourceEpoch")) || (key0 === "sourcePosition"))){validate1817.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1817.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1817.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.runId !== undefined){let data1: any = data.runId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate1817.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1817.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.provider !== undefined){let data2: any = data.provider;const _errs10: any = errors;const _errs11: any = errors;if(errors === _errs11){if(typeof data2 === "string"){if(!pattern16.test(data2)){validate1817.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate1817.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.subagentId !== undefined){let data3: any = data.subagentId;const _errs14: any = errors;const _errs15: any = errors;if(errors === _errs15){if(typeof data3 === "string"){if(func1(data3) > 256){validate1817.errors = [{instancePath:instancePath+"/subagentId",schemaPath:"#/$defs/SubagentId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data3) < 1){validate1817.errors = [{instancePath:instancePath+"/subagentId",schemaPath:"#/$defs/SubagentId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data3)){validate1817.errors = [{instancePath:instancePath+"/subagentId",schemaPath:"#/$defs/SubagentId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1817.errors = [{instancePath:instancePath+"/subagentId",schemaPath:"#/$defs/SubagentId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}if(valid0){if(data.childRunId !== undefined){let data4: any = data.childRunId;const _errs18: any = errors;const _errs19: any = errors;if(errors === _errs19){if(typeof data4 === "string"){if(!pattern4.test(data4)){validate1817.errors = [{instancePath:instancePath+"/childRunId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1817.errors = [{instancePath:instancePath+"/childRunId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs18 === errors;}else {var valid0: any = true;}if(valid0){if(data.parentToolCallId !== undefined){let data5: any = data.parentToolCallId;const _errs22: any = errors;const _errs23: any = errors;if(errors === _errs23){if(typeof data5 === "string"){if(func1(data5) > 256){validate1817.errors = [{instancePath:instancePath+"/parentToolCallId",schemaPath:"sidekicks-contracts:provider/tool-call#/$defs/ToolCallId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data5) < 1){validate1817.errors = [{instancePath:instancePath+"/parentToolCallId",schemaPath:"sidekicks-contracts:provider/tool-call#/$defs/ToolCallId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data5)){validate1817.errors = [{instancePath:instancePath+"/parentToolCallId",schemaPath:"sidekicks-contracts:provider/tool-call#/$defs/ToolCallId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1817.errors = [{instancePath:instancePath+"/parentToolCallId",schemaPath:"sidekicks-contracts:provider/tool-call#/$defs/ToolCallId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs22 === errors;}else {var valid0: any = true;}if(valid0){if(data.sourceEpoch !== undefined){let data6: any = data.sourceEpoch;const _errs26: any = errors;const _errs27: any = errors;if(!(((typeof data6 == "number") && (!(data6 % 1) && !isNaN(data6))) && (isFinite(data6)))){validate1817.errors = [{instancePath:instancePath+"/sourceEpoch",schemaPath:"sidekicks-contracts:event/envelope#/$defs/SourceEpoch/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs27){if((typeof data6 == "number") && (isFinite(data6))){if(data6 > 9007199254740991 || isNaN(data6)){validate1817.errors = [{instancePath:instancePath+"/sourceEpoch",schemaPath:"sidekicks-contracts:event/envelope#/$defs/SourceEpoch/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data6 < 0 || isNaN(data6)){validate1817.errors = [{instancePath:instancePath+"/sourceEpoch",schemaPath:"sidekicks-contracts:event/envelope#/$defs/SourceEpoch/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs26 === errors;}else {var valid0: any = true;}if(valid0){if(data.sourcePosition !== undefined){let data7: any = data.sourcePosition;const _errs29: any = errors;const _errs30: any = errors;if(!(((typeof data7 == "number") && (!(data7 % 1) && !isNaN(data7))) && (isFinite(data7)))){validate1817.errors = [{instancePath:instancePath+"/sourcePosition",schemaPath:"sidekicks-contracts:event/envelope#/$defs/SourcePosition/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs30){if((typeof data7 == "number") && (isFinite(data7))){if(data7 > 9007199254740991 || isNaN(data7)){validate1817.errors = [{instancePath:instancePath+"/sourcePosition",schemaPath:"sidekicks-contracts:event/envelope#/$defs/SourcePosition/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data7 < 0 || isNaN(data7)){validate1817.errors = [{instancePath:instancePath+"/sourcePosition",schemaPath:"sidekicks-contracts:event/envelope#/$defs/SourcePosition/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs29 === errors;}else {var valid0: any = true;}if(valid0){let missing1: any;if(data.sourceEpoch !== undefined && (((data.sourcePosition === undefined) && (missing1 = "sourcePosition")) || ((data.runId === undefined) && (missing1 = "runId")))){validate1817.errors = [{instancePath,schemaPath:"#/dependentRequired",keyword:"dependentRequired",params:{property: "sourceEpoch",
    missingProperty: missing1,
    depsCount: 2,
    deps: "sourcePosition, runId"}}];return false;}else {if(data.sourcePosition !== undefined && (((data.sourceEpoch === undefined) && (missing1 = "sourceEpoch")) || ((data.runId === undefined) && (missing1 = "runId")))){validate1817.errors = [{instancePath,schemaPath:"#/dependentRequired",keyword:"dependentRequired",params:{property: "sourcePosition",
    missingProperty: missing1,
    depsCount: 2,
    deps: "sourceEpoch, runId"}}];return false;}}}}}}}}}}}}}else {validate1817.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1817.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1817.errors = null as any[] | null;
// prettier-ignore
validate1817.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SubagentLifecyclePayload}. */
export const validateSubagentLifecyclePayload: SchemaCheck<SubagentLifecyclePayload> = validate1817;
