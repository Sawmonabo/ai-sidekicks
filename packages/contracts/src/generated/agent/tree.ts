/* eslint-disable */
// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The session's agent tree: how the daemon's index names each agent in a session.

import { type SchemaCheck, ucs2length } from "../../schema-check.js";
import type { RunId } from "../run/id.js";
import type { AgentId } from "./definition.js";

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
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
function validate131(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentTreeMember {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate131.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs2: any = errors;for(const key0 in data){validate131.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key0}}];return false;break;}if(_errs2 === errors){const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "agent"){const _errs3: any = errors;if(errors === _errs3){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.kind === undefined) && (missing0 = "kind")) || ((data.agentId === undefined) && (missing0 = "agentId"))){validate131.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs5: any = errors;for(const key1 in data){if(!((key1 === "kind") || (key1 === "agentId"))){validate131.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs5 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs6: any = errors;if(typeof data0 !== "string"){validate131.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("agent" !== data0){validate131.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "agent"}}];return false;}var valid2: any = _errs6 === errors;}else {var valid2: any = true;}if(valid2){if(data.agentId !== undefined){let data1: any = data.agentId;const _errs8: any = errors;const _errs9: any = errors;if(errors === _errs9){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate131.errors = [{instancePath:instancePath+"/agentId",schemaPath:"sidekicks-contracts:agent/definition#/$defs/AgentId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate131.errors = [{instancePath:instancePath+"/agentId",schemaPath:"sidekicks-contracts:agent/definition#/$defs/AgentId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}}}}}else {validate131.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "providerChild"){const _errs12: any = errors;if(errors === _errs12){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((data.kind === undefined) && (missing1 = "kind")) || ((data.runId === undefined) && (missing1 = "runId"))) || ((data.childHandle === undefined) && (missing1 = "childHandle"))){validate131.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs14: any = errors;for(const key2 in data){if(!(((key2 === "kind") || (key2 === "runId")) || (key2 === "childHandle"))){validate131.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs14 === errors){if(data.kind !== undefined){let data2: any = data.kind;const _errs15: any = errors;if(typeof data2 !== "string"){validate131.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("providerChild" !== data2){validate131.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "providerChild"}}];return false;}var valid5: any = _errs15 === errors;}else {var valid5: any = true;}if(valid5){if(data.runId !== undefined){let data3: any = data.runId;const _errs17: any = errors;const _errs18: any = errors;if(errors === _errs18){if(typeof data3 === "string"){if(!pattern4.test(data3)){validate131.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate131.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs17 === errors;}else {var valid5: any = true;}if(valid5){if(data.childHandle !== undefined){let data4: any = data.childHandle;const _errs21: any = errors;const _errs22: any = errors;if(errors === _errs22){if(typeof data4 === "string"){if(func1(data4) > 256){validate131.errors = [{instancePath:instancePath+"/childHandle",schemaPath:"#/$defs/ChildHandle/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data4) < 1){validate131.errors = [{instancePath:instancePath+"/childHandle",schemaPath:"#/$defs/ChildHandle/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate131.errors = [{instancePath:instancePath+"/childHandle",schemaPath:"#/$defs/ChildHandle/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs21 === errors;}else {var valid5: any = true;}}}}}}else {validate131.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}}else {validate131.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validate131.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}}}else {validate131.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate131.errors = vErrors;return errors === 0;}
// prettier-ignore
validate131.errors = null as any[] | null;
// prettier-ignore
validate131.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate132(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ChildHandle {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate132.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) > 256){validate132.errors = [{instancePath,schemaPath:"#/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data) < 1){validate132.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate132.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validate132.errors = vErrors;return errors === 0;}
// prettier-ignore
validate132.errors = null as any[] | null;
// prettier-ignore
validate132.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AgentTreeMember}. */
export const validateAgentTreeMember: SchemaCheck<AgentTreeMember> = validate131;
/** Checks that a value is a {@link ChildHandle}. */
export const validateChildHandle: SchemaCheck<ChildHandle> = validate132;
