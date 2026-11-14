// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The session's agent tree: how the daemon's index names each agent in a session.

import { type CompiledSchemaCheck, ucs2length } from "../../schema-check.js";
import { type RunId, validateRunId } from "../run/id.js";
import { type AgentId, validateAgentId } from "./definition.js";

/**
 * The daemon-minted handle of a provider's own helper inside its parent's run: opaque, and
 * resolved only by the daemon's parent-to-child index that minted it.
 */
export type ChildHandle = string & { readonly __brand: "ChildHandle" };
/**
 * One agent in the session's tree as the daemon's index names it: an agent with an id (the lead,
 * or one a bridge `run` started), or a provider's own helper by the run it runs in and its
 * handle.
 */
export type AgentTreeMember =
  | {
      kind: "agent";
      /**
       * The agent.
       */
      agentId: AgentId;
    }
  | {
      kind: "providerChild";
      /**
       * The run it runs in.
       */
      runId: RunId;
      /**
       * Its handle.
       */
      childHandle: ChildHandle;
    };

// prettier-ignore
const func1 = ucs2length;
/** Checks that a value is a {@link ChildHandle}. */
// prettier-ignore
export const validateChildHandle: CompiledSchemaCheck<ChildHandle> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ChildHandle {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateChildHandle.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) > 256){validateChildHandle.errors = [{instancePath,schemaPath:"#/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data) < 1){validateChildHandle.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validateChildHandle.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateChildHandle.errors = vErrors;return errors === 0;};
// prettier-ignore
validateChildHandle.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AgentTreeMember}. */
// prettier-ignore
export const validateAgentTreeMember: CompiledSchemaCheck<AgentTreeMember> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentTreeMember {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAgentTreeMember.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "agent"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.kind === undefined) && (missing0 = "kind")) || ((data.agentId === undefined) && (missing0 = "agentId"))){validateAgentTreeMember.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!((key0 === "kind") || (key0 === "agentId"))){validateAgentTreeMember.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs5: any = errors;if(typeof data0 !== "string"){validateAgentTreeMember.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("agent" !== data0){validateAgentTreeMember.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "agent"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.agentId !== undefined){const _errs7: any = errors;if(!(validateAgentId.call(this, data.agentId, {instancePath:instancePath+"/agentId",parentData:data,parentDataProperty:"agentId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAgentId.errors : vErrors.concat(validateAgentId.errors);errors = vErrors.length;}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}}}}}else {validateAgentTreeMember.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "providerChild"){const _errs8: any = errors;if(errors === _errs8){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((data.kind === undefined) && (missing1 = "kind")) || ((data.runId === undefined) && (missing1 = "runId"))) || ((data.childHandle === undefined) && (missing1 = "childHandle"))){validateAgentTreeMember.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs10: any = errors;for(const key1 in data){if(!(((key1 === "kind") || (key1 === "runId")) || (key1 === "childHandle"))){validateAgentTreeMember.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs10 === errors){if(data.kind !== undefined){let data2: any = data.kind;const _errs11: any = errors;if(typeof data2 !== "string"){validateAgentTreeMember.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("providerChild" !== data2){validateAgentTreeMember.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "providerChild"}}];return false;}var valid4: any = _errs11 === errors;}else {var valid4: any = true;}if(valid4){if(data.runId !== undefined){const _errs13: any = errors;if(!(validateRunId.call(this, data.runId, {instancePath:instancePath+"/runId",parentData:data,parentDataProperty:"runId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunId.errors : vErrors.concat(validateRunId.errors);errors = vErrors.length;}var valid4: any = _errs13 === errors;}else {var valid4: any = true;}if(valid4){if(data.childHandle !== undefined){const _errs14: any = errors;if(!(validateChildHandle.call(this, data.childHandle, {instancePath:instancePath+"/childHandle",parentData:data,parentDataProperty:"childHandle",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateChildHandle.errors : vErrors.concat(validateChildHandle.errors);errors = vErrors.length;}var valid4: any = _errs14 === errors;}else {var valid4: any = true;}}}}}}else {validateAgentTreeMember.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs8 === errors;if(props0 !== true){props0 = true;}valid0 = valid3;}else {validateAgentTreeMember.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validateAgentTreeMember.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key2 in data){if(!props0 || !props0[key2]){validateAgentTreeMember.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key2}}];return false;break;}}}}}else {validateAgentTreeMember.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAgentTreeMember.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAgentTreeMember.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
