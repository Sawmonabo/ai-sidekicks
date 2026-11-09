// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The driver methods a client calls (`provider.model.list`, `provider.mode.list`, `provider.command.list`, `agent.run.context.compact`), their requests and replies, grouped by provider.

import { type SchemaCheck, ucs2length } from "../../../schema-check.js";
import type { AgentId } from "../../agent/definition.js";
import type { RunId } from "../../run/id.js";
import type { SessionId } from "../../session/id.js";
import type { ProviderId } from "../id.js";
import type { ProviderMode, ProviderModel } from "./capabilities.js";
import {
  type ProviderCommandListResponse,
  validateProviderCommandListResponse,
} from "./commands.js";
import {
  type AgentRunContextCompactResponse,
  validateAgentRunContextCompactResponse,
} from "./compaction.js";

/**
 * The longest short identifier or label: a model's and a mode's id and name, and the words
 * in its capabilities, effort levels and output-speed levels.
 */
export const PROVIDER_WIRE_TOKEN_MAX_LEN = 128 as const;

/**
 * The longest opaque provider handle a client echoes back, roomier than a token, because
 * refusing a real handle would make a valid request unsendable.
 */
export const PROVIDER_WIRE_HANDLE_MAX_LEN = 256 as const;

/** The longest reason the person gives on an interrupt or a cancel. */
export const PROVIDER_WIRE_REASON_MAX_LEN = 512 as const;

/** The longest contract version a driver reports, where the daemon reads and stores it. */
export const PROVIDER_WIRE_CONTRACT_VERSION_MAX_LEN = 64 as const;

/** The refusal of a provider operation that outlived its deadline. */
export const PROVIDER_TIMEOUT_CODE = "provider.timeout" as const;

/**
 * One installed provider's outcome in the `provider.model.list` reply: its models, or the failure
 * its catalog's read answered, so one provider's outage never hides another's models.
 */
export type ProviderModelReport =
  | {
      /**
       * The provider.
       */
      providerName: ProviderId;
      /**
       * Its models.
       */
      models: ProviderModel[];
      /**
       * Only a failed read carries a failure.
       */
      failure?: never;
    }
  | {
      /**
       * The provider.
       */
      providerName: ProviderId;
      /**
       * Why the read failed.
       */
      failure: ProviderReadFailure;
      /**
       * Only a read catalog carries models.
       */
      models?: never;
    };
/**
 * One installed provider's outcome in the `provider.mode.list` reply: its modes, or the failure
 * their read answered, so one provider's outage never hides another's modes.
 */
export type ProviderModeReport =
  | {
      /**
       * The provider.
       */
      providerName: ProviderId;
      /**
       * Its modes.
       */
      modes: ProviderMode[];
      /**
       * Only a failed read carries a failure.
       */
      failure?: never;
    }
  | {
      /**
       * The provider.
       */
      providerName: ProviderId;
      /**
       * Why the read failed.
       */
      failure: ProviderReadFailure;
      /**
       * Only a read list carries modes.
       */
      modes?: never;
    };

/**
 * The request of `provider.model.list`: the session whose model control reads the catalog.
 */
export interface ProviderModelListRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
}
/**
 * The request of `provider.mode.list`: the session whose level control reads the report.
 */
export interface ProviderModeListRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
}
/**
 * Why one provider's models or modes could not be read: the refusal its read answered with, and
 * the provider's own words where it gave any.
 */
export interface ProviderReadFailure {
  /**
   * The refusal's code, as a JSON-RPC error's `data.type` carries it.
   */
  code: string;
  /**
   * What the provider said, where it said anything.
   */
  providerFailureDetail?: string;
}
/**
 * A provider whose catalog was read: its models.
 */
export interface ProviderModelsListed {
  /**
   * The provider.
   */
  providerName: ProviderId;
  /**
   * Its models.
   */
  models: ProviderModel[];
  /**
   * Only a failed read carries a failure.
   */
  failure?: never;
}
/**
 * A provider whose catalog could not be read: why, never an empty catalog.
 */
export interface ProviderModelsFailed {
  /**
   * The provider.
   */
  providerName: ProviderId;
  /**
   * Why the read failed.
   */
  failure: ProviderReadFailure;
  /**
   * Only a read catalog carries models.
   */
  models?: never;
}
/**
 * The reply of `provider.model.list`: one outcome per installed provider, the session's own
 * provider first, then the provider table's order.
 */
export interface ProviderModelListResponse {
  /**
   * The groups.
   */
  providers: ProviderModelReport[];
}
/**
 * A provider whose modes were read: its modes.
 */
export interface ProviderModesListed {
  /**
   * The provider.
   */
  providerName: ProviderId;
  /**
   * Its modes.
   */
  modes: ProviderMode[];
  /**
   * Only a failed read carries a failure.
   */
  failure?: never;
}
/**
 * A provider whose modes could not be read: why, never an empty list.
 */
export interface ProviderModesFailed {
  /**
   * The provider.
   */
  providerName: ProviderId;
  /**
   * Why the read failed.
   */
  failure: ProviderReadFailure;
  /**
   * Only a read list carries modes.
   */
  modes?: never;
}
/**
 * The reply of `provider.mode.list`: one outcome per installed provider, the session's own
 * provider first, then the provider table's order.
 */
export interface ProviderModeListResponse {
  /**
   * The groups.
   */
  providers: ProviderModeReport[];
}
/**
 * The request of `agent.run.context.compact`, the person's compaction of one run's context. The
 * reply's `refused` and `failed` arms are data a caller branches on, never a refusal.
 */
export interface AgentRunContextCompactRequest {
  /**
   * The session, the scope checked first.
   */
  sessionId: SessionId;
  /**
   * The run within it.
   */
  runId: RunId;
}
/**
 * The request of `provider.command.list`: the commands and skills one agent's providers
 * publish, one group per live binding the agent holds.
 */
export interface ProviderCommandListRequest {
  /**
   * The session, the scope checked first.
   */
  sessionId: SessionId;
  /**
   * The agent within it.
   */
  agentId: AgentId;
}

// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
function validate1517(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentRunContextCompactRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1517.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.runId === undefined) && (missing0 = "runId"))){validate1517.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "runId"))){validate1517.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1517.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1517.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.runId !== undefined){let data1: any = data.runId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate1517.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1517.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1517.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1517.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1517.errors = null as any[] | null;
// prettier-ignore
validate1517.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1518(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderCommandListRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1518.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.agentId === undefined) && (missing0 = "agentId"))){validate1518.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "agentId"))){validate1518.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1518.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1518.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.agentId !== undefined){let data1: any = data.agentId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate1518.errors = [{instancePath:instancePath+"/agentId",schemaPath:"sidekicks-contracts:agent/definition#/$defs/AgentId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1518.errors = [{instancePath:instancePath+"/agentId",schemaPath:"sidekicks-contracts:agent/definition#/$defs/AgentId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1518.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1518.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1518.errors = null as any[] | null;
// prettier-ignore
validate1518.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1519(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderModeListRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1519.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validate1519.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "sessionId")){validate1519.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1519.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1519.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate1519.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1519.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1519.errors = null as any[] | null;
// prettier-ignore
validate1519.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern16 = new RegExp("^[a-z][a-z0-9-]{0,31}$", "u");
// prettier-ignore
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
function validate1521(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1521.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(errors === _errs1){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.providerName === undefined) && (missing0 = "providerName")) || ((data.modes === undefined) && (missing0 = "modes"))){const err0: any = {instancePath,schemaPath:"#/anyOf/0/required",keyword:"required",params:{missingProperty: missing0}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {const _errs3: any = errors;for(const key0 in data){if(!(((key0 === "providerName") || (key0 === "modes")) || (key0 === "failure"))){const err1: any = {instancePath,schemaPath:"#/anyOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;break;}}if(_errs3 === errors){if(data.providerName !== undefined){let data0: any = data.providerName;const _errs4: any = errors;const _errs5: any = errors;if(errors === _errs5){if(typeof data0 === "string"){if(!pattern16.test(data0)){const err2: any = {instancePath:instancePath+"/providerName",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}}else {const err3: any = {instancePath:instancePath+"/providerName",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}}var valid1: any = _errs4 === errors;}else {var valid1: any = true;}if(valid1){if(data.modes !== undefined){let data1: any = data.modes;const _errs8: any = errors;if(errors === _errs8){if(Array.isArray(data1)){var valid3: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){let data2: any = data1[i0];const _errs10: any = errors;const _errs11: any = errors;if(errors === _errs11){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){let missing1: any;if(((data2.id === undefined) && (missing1 = "id")) || ((data2.name === undefined) && (missing1 = "name"))){const err4: any = {instancePath:instancePath+"/modes/" + i0,schemaPath:"sidekicks-contracts:provider/driver/capabilities#/$defs/ProviderMode/required",keyword:"required",params:{missingProperty: missing1}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}else {const _errs13: any = errors;for(const key1 in data2){if(!((key1 === "id") || (key1 === "name"))){const err5: any = {instancePath:instancePath+"/modes/" + i0,schemaPath:"sidekicks-contracts:provider/driver/capabilities#/$defs/ProviderMode/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;break;}}if(_errs13 === errors){if(data2.id !== undefined){let data3: any = data2.id;const _errs14: any = errors;if(errors === _errs14){if(typeof data3 === "string"){if(func1(data3) > 128){const err6: any = {instancePath:instancePath+"/modes/" + i0+"/id",schemaPath:"sidekicks-contracts:provider/driver/capabilities#/$defs/ProviderMode/properties/id/maxLength",keyword:"maxLength",params:{limit: 128}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;}else {if(func1(data3) < 1){const err7: any = {instancePath:instancePath+"/modes/" + i0+"/id",schemaPath:"sidekicks-contracts:provider/driver/capabilities#/$defs/ProviderMode/properties/id/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;}else {if(!pattern6.test(data3)){const err8: any = {instancePath:instancePath+"/modes/" + i0+"/id",schemaPath:"sidekicks-contracts:provider/driver/capabilities#/$defs/ProviderMode/properties/id/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;}}}}else {const err9: any = {instancePath:instancePath+"/modes/" + i0+"/id",schemaPath:"sidekicks-contracts:provider/driver/capabilities#/$defs/ProviderMode/properties/id/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;}}var valid5: any = _errs14 === errors;}else {var valid5: any = true;}if(valid5){if(data2.name !== undefined){let data4: any = data2.name;const _errs16: any = errors;if(errors === _errs16){if(typeof data4 === "string"){if(func1(data4) > 128){const err10: any = {instancePath:instancePath+"/modes/" + i0+"/name",schemaPath:"sidekicks-contracts:provider/driver/capabilities#/$defs/ProviderMode/properties/name/maxLength",keyword:"maxLength",params:{limit: 128}};if(vErrors === null){vErrors = [err10];}else {vErrors.push(err10);}errors++;}else {if(func1(data4) < 1){const err11: any = {instancePath:instancePath+"/modes/" + i0+"/name",schemaPath:"sidekicks-contracts:provider/driver/capabilities#/$defs/ProviderMode/properties/name/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err11];}else {vErrors.push(err11);}errors++;}else {if(!pattern6.test(data4)){const err12: any = {instancePath:instancePath+"/modes/" + i0+"/name",schemaPath:"sidekicks-contracts:provider/driver/capabilities#/$defs/ProviderMode/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err12];}else {vErrors.push(err12);}errors++;}}}}else {const err13: any = {instancePath:instancePath+"/modes/" + i0+"/name",schemaPath:"sidekicks-contracts:provider/driver/capabilities#/$defs/ProviderMode/properties/name/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err13];}else {vErrors.push(err13);}errors++;}}var valid5: any = _errs16 === errors;}else {var valid5: any = true;}}}}}else {const err14: any = {instancePath:instancePath+"/modes/" + i0,schemaPath:"sidekicks-contracts:provider/driver/capabilities#/$defs/ProviderMode/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err14];}else {vErrors.push(err14);}errors++;}}var valid3: any = _errs10 === errors;if(!valid3){break;}}}else {const err15: any = {instancePath:instancePath+"/modes",schemaPath:"#/anyOf/0/properties/modes/type",keyword:"type",params:{type: "array"}};if(vErrors === null){vErrors = [err15];}else {vErrors.push(err15);}errors++;}}var valid1: any = _errs8 === errors;}else {var valid1: any = true;}if(valid1){if(data.failure !== undefined){const _errs18: any = errors;const err16: any = {instancePath:instancePath+"/failure",schemaPath:"#/anyOf/0/properties/failure/not",keyword:"not",params:{}};if(vErrors === null){vErrors = [err16];}else {vErrors.push(err16);}errors++;var valid1: any = _errs18 === errors;}else {var valid1: any = true;}}}}}}else {const err17: any = {instancePath,schemaPath:"#/anyOf/0/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err17];}else {vErrors.push(err17);}errors++;}}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}const _errs21: any = errors;if(errors === _errs21){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if(((data.providerName === undefined) && (missing2 = "providerName")) || ((data.failure === undefined) && (missing2 = "failure"))){const err18: any = {instancePath,schemaPath:"#/anyOf/1/required",keyword:"required",params:{missingProperty: missing2}};if(vErrors === null){vErrors = [err18];}else {vErrors.push(err18);}errors++;}else {const _errs23: any = errors;for(const key2 in data){if(!(((key2 === "providerName") || (key2 === "failure")) || (key2 === "modes"))){const err19: any = {instancePath,schemaPath:"#/anyOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}};if(vErrors === null){vErrors = [err19];}else {vErrors.push(err19);}errors++;break;}}if(_errs23 === errors){if(data.providerName !== undefined){let data6: any = data.providerName;const _errs24: any = errors;const _errs25: any = errors;if(errors === _errs25){if(typeof data6 === "string"){if(!pattern16.test(data6)){const err20: any = {instancePath:instancePath+"/providerName",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}};if(vErrors === null){vErrors = [err20];}else {vErrors.push(err20);}errors++;}}else {const err21: any = {instancePath:instancePath+"/providerName",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err21];}else {vErrors.push(err21);}errors++;}}var valid6: any = _errs24 === errors;}else {var valid6: any = true;}if(valid6){if(data.failure !== undefined){let data7: any = data.failure;const _errs28: any = errors;const _errs29: any = errors;if(errors === _errs29){if(data7 && typeof data7 == "object" && !Array.isArray(data7)){let missing3: any;if((data7.code === undefined) && (missing3 = "code")){const err22: any = {instancePath:instancePath+"/failure",schemaPath:"#/$defs/ProviderReadFailure/required",keyword:"required",params:{missingProperty: missing3}};if(vErrors === null){vErrors = [err22];}else {vErrors.push(err22);}errors++;}else {const _errs31: any = errors;for(const key3 in data7){if(!((key3 === "code") || (key3 === "providerFailureDetail"))){const err23: any = {instancePath:instancePath+"/failure",schemaPath:"#/$defs/ProviderReadFailure/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}};if(vErrors === null){vErrors = [err23];}else {vErrors.push(err23);}errors++;break;}}if(_errs31 === errors){if(data7.code !== undefined){const _errs32: any = errors;if(typeof data7.code !== "string"){const err24: any = {instancePath:instancePath+"/failure/code",schemaPath:"#/$defs/ProviderReadFailure/properties/code/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err24];}else {vErrors.push(err24);}errors++;}var valid9: any = _errs32 === errors;}else {var valid9: any = true;}if(valid9){if(data7.providerFailureDetail !== undefined){let data9: any = data7.providerFailureDetail;const _errs34: any = errors;if(errors === _errs34){if(typeof data9 === "string"){if(func1(data9) > 32768){const err25: any = {instancePath:instancePath+"/failure/providerFailureDetail",schemaPath:"#/$defs/ProviderReadFailure/properties/providerFailureDetail/maxLength",keyword:"maxLength",params:{limit: 32768}};if(vErrors === null){vErrors = [err25];}else {vErrors.push(err25);}errors++;}else {if(func1(data9) < 1){const err26: any = {instancePath:instancePath+"/failure/providerFailureDetail",schemaPath:"#/$defs/ProviderReadFailure/properties/providerFailureDetail/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err26];}else {vErrors.push(err26);}errors++;}else {if(!pattern6.test(data9)){const err27: any = {instancePath:instancePath+"/failure/providerFailureDetail",schemaPath:"#/$defs/ProviderReadFailure/properties/providerFailureDetail/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err27];}else {vErrors.push(err27);}errors++;}}}}else {const err28: any = {instancePath:instancePath+"/failure/providerFailureDetail",schemaPath:"#/$defs/ProviderReadFailure/properties/providerFailureDetail/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err28];}else {vErrors.push(err28);}errors++;}}var valid9: any = _errs34 === errors;}else {var valid9: any = true;}}}}}else {const err29: any = {instancePath:instancePath+"/failure",schemaPath:"#/$defs/ProviderReadFailure/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err29];}else {vErrors.push(err29);}errors++;}}var valid6: any = _errs28 === errors;}else {var valid6: any = true;}if(valid6){if(data.modes !== undefined){const _errs36: any = errors;const err30: any = {instancePath:instancePath+"/modes",schemaPath:"#/anyOf/1/properties/modes/not",keyword:"not",params:{}};if(vErrors === null){vErrors = [err30];}else {vErrors.push(err30);}errors++;var valid6: any = _errs36 === errors;}else {var valid6: any = true;}}}}}}else {const err31: any = {instancePath,schemaPath:"#/anyOf/1/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err31];}else {vErrors.push(err31);}errors++;}}var _valid0: any = _errs21 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}if(!valid0){const err32: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err32];}else {vErrors.push(err32);}errors++;validate1521.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validate1521.errors = vErrors;evaluated0.props = props0;return errors === 0;}
// prettier-ignore
validate1521.errors = null as any[] | null;
// prettier-ignore
validate1521.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
// prettier-ignore
function validate1520(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderModeListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1520.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.providers === undefined) && (missing0 = "providers")){validate1520.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "providers")){validate1520.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.providers !== undefined){let data0: any = data.providers;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validate1521.call(this, data0[i0], {instancePath:instancePath+"/providers/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1521.errors : vErrors.concat(validate1521.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validate1520.errors = [{instancePath:instancePath+"/providers",schemaPath:"#/properties/providers/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validate1520.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1520.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1520.errors = null as any[] | null;
// prettier-ignore
validate1520.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1523(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderModelListRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1523.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validate1523.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "sessionId")){validate1523.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1523.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1523.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate1523.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1523.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1523.errors = null as any[] | null;
// prettier-ignore
validate1523.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1525(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1525.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(errors === _errs1){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.providerName === undefined) && (missing0 = "providerName")) || ((data.models === undefined) && (missing0 = "models"))){const err0: any = {instancePath,schemaPath:"#/anyOf/0/required",keyword:"required",params:{missingProperty: missing0}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {const _errs3: any = errors;for(const key0 in data){if(!(((key0 === "providerName") || (key0 === "models")) || (key0 === "failure"))){const err1: any = {instancePath,schemaPath:"#/anyOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;break;}}if(_errs3 === errors){if(data.providerName !== undefined){let data0: any = data.providerName;const _errs4: any = errors;const _errs5: any = errors;if(errors === _errs5){if(typeof data0 === "string"){if(!pattern16.test(data0)){const err2: any = {instancePath:instancePath+"/providerName",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}}else {const err3: any = {instancePath:instancePath+"/providerName",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}}var valid1: any = _errs4 === errors;}else {var valid1: any = true;}if(valid1){if(data.models !== undefined){let data1: any = data.models;const _errs8: any = errors;if(errors === _errs8){if(Array.isArray(data1)){var valid3: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){let data2: any = data1[i0];const _errs10: any = errors;const _errs11: any = errors;if(errors === _errs11){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){let missing1: any;if((((((data2.id === undefined) && (missing1 = "id")) || ((data2.name === undefined) && (missing1 = "name"))) || ((data2.capabilities === undefined) && (missing1 = "capabilities"))) || ((data2.fast === undefined) && (missing1 = "fast"))) || ((data2.largerWindow === undefined) && (missing1 = "largerWindow"))){const err4: any = {instancePath:instancePath+"/models/" + i0,schemaPath:"sidekicks-contracts:provider/driver/capabilities#/$defs/ProviderModel/required",keyword:"required",params:{missingProperty: missing1}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}else {const _errs13: any = errors;for(const key1 in data2){if(!((((((((key1 === "id") || (key1 === "name")) || (key1 === "capabilities")) || (key1 === "effortLevels")) || (key1 === "outputSpeedLevels")) || (key1 === "fast")) || (key1 === "largerWindow")) || (key1 === "contextWindow"))){const err5: any = {instancePath:instancePath+"/models/" + i0,schemaPath:"sidekicks-contracts:provider/driver/capabilities#/$defs/ProviderModel/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;break;}}if(_errs13 === errors){if(data2.id !== undefined){let data3: any = data2.id;const _errs14: any = errors;if(errors === _errs14){if(typeof data3 === "string"){if(func1(data3) > 128){const err6: any = {instancePath:instancePath+"/models/" + i0+"/id",schemaPath:"sidekicks-contracts:provider/driver/capabilities#/$defs/ProviderModel/properties/id/maxLength",keyword:"maxLength",params:{limit: 128}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;}else {if(func1(data3) < 1){const err7: any = {instancePath:instancePath+"/models/" + i0+"/id",schemaPath:"sidekicks-contracts:provider/driver/capabilities#/$defs/ProviderModel/properties/id/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;}else {if(!pattern6.test(data3)){const err8: any = {instancePath:instancePath+"/models/" + i0+"/id",schemaPath:"sidekicks-contracts:provider/driver/capabilities#/$defs/ProviderModel/properties/id/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;}}}}else {const err9: any = {instancePath:instancePath+"/models/" + i0+"/id",schemaPath:"sidekicks-contracts:provider/driver/capabilities#/$defs/ProviderModel/properties/id/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;}}var valid5: any = _errs14 === errors;}else {var valid5: any = true;}if(valid5){if(data2.name !== undefined){let data4: any = data2.name;const _errs16: any = errors;if(errors === _errs16){if(typeof data4 === "string"){if(func1(data4) > 128){const err10: any = {instancePath:instancePath+"/models/" + i0+"/name",schemaPath:"sidekicks-contracts:provider/driver/capabilities#/$defs/ProviderModel/properties/name/maxLength",keyword:"maxLength",params:{limit: 128}};if(vErrors === null){vErrors = [err10];}else {vErrors.push(err10);}errors++;}else {if(func1(data4) < 1){const err11: any = {instancePath:instancePath+"/models/" + i0+"/name",schemaPath:"sidekicks-contracts:provider/driver/capabilities#/$defs/ProviderModel/properties/name/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err11];}else {vErrors.push(err11);}errors++;}else {if(!pattern6.test(data4)){const err12: any = {instancePath:instancePath+"/models/" + i0+"/name",schemaPath:"sidekicks-contracts:provider/driver/capabilities#/$defs/ProviderModel/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err12];}else {vErrors.push(err12);}errors++;}}}}else {const err13: any = {instancePath:instancePath+"/models/" + i0+"/name",schemaPath:"sidekicks-contracts:provider/driver/capabilities#/$defs/ProviderModel/properties/name/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err13];}else {vErrors.push(err13);}errors++;}}var valid5: any = _errs16 === errors;}else {var valid5: any = true;}if(valid5){if(data2.capabilities !== undefined){let data5: any = data2.capabilities;const _errs18: any = errors;if(errors === _errs18){if(Array.isArray(data5)){var valid6: any = true;const len1: any = data5.length;for(let i1=0; i1<len1; i1++){let data6: any = data5[i1];const _errs20: any = errors;if(errors === _errs20){if(typeof data6 === "string"){if(func1(data6) > 128){const err14: any = {instancePath:instancePath+"/models/" + i0+"/capabilities/" + i1,schemaPath:"sidekicks-contracts:provider/driver/capabilities#/$defs/ProviderModel/properties/capabilities/items/maxLength",keyword:"maxLength",params:{limit: 128}};if(vErrors === null){vErrors = [err14];}else {vErrors.push(err14);}errors++;}else {if(func1(data6) < 1){const err15: any = {instancePath:instancePath+"/models/" + i0+"/capabilities/" + i1,schemaPath:"sidekicks-contracts:provider/driver/capabilities#/$defs/ProviderModel/properties/capabilities/items/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err15];}else {vErrors.push(err15);}errors++;}else {if(!pattern6.test(data6)){const err16: any = {instancePath:instancePath+"/models/" + i0+"/capabilities/" + i1,schemaPath:"sidekicks-contracts:provider/driver/capabilities#/$defs/ProviderModel/properties/capabilities/items/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err16];}else {vErrors.push(err16);}errors++;}}}}else {const err17: any = {instancePath:instancePath+"/models/" + i0+"/capabilities/" + i1,schemaPath:"sidekicks-contracts:provider/driver/capabilities#/$defs/ProviderModel/properties/capabilities/items/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err17];}else {vErrors.push(err17);}errors++;}}var valid6: any = _errs20 === errors;if(!valid6){break;}}}else {const err18: any = {instancePath:instancePath+"/models/" + i0+"/capabilities",schemaPath:"sidekicks-contracts:provider/driver/capabilities#/$defs/ProviderModel/properties/capabilities/type",keyword:"type",params:{type: "array"}};if(vErrors === null){vErrors = [err18];}else {vErrors.push(err18);}errors++;}}var valid5: any = _errs18 === errors;}else {var valid5: any = true;}if(valid5){if(data2.effortLevels !== undefined){let data7: any = data2.effortLevels;const _errs22: any = errors;if(errors === _errs22){if(Array.isArray(data7)){var valid7: any = true;const len2: any = data7.length;for(let i2=0; i2<len2; i2++){let data8: any = data7[i2];const _errs24: any = errors;if(errors === _errs24){if(typeof data8 === "string"){if(func1(data8) > 128){const err19: any = {instancePath:instancePath+"/models/" + i0+"/effortLevels/" + i2,schemaPath:"sidekicks-contracts:provider/driver/capabilities#/$defs/ProviderModel/properties/effortLevels/items/maxLength",keyword:"maxLength",params:{limit: 128}};if(vErrors === null){vErrors = [err19];}else {vErrors.push(err19);}errors++;}else {if(func1(data8) < 1){const err20: any = {instancePath:instancePath+"/models/" + i0+"/effortLevels/" + i2,schemaPath:"sidekicks-contracts:provider/driver/capabilities#/$defs/ProviderModel/properties/effortLevels/items/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err20];}else {vErrors.push(err20);}errors++;}else {if(!pattern6.test(data8)){const err21: any = {instancePath:instancePath+"/models/" + i0+"/effortLevels/" + i2,schemaPath:"sidekicks-contracts:provider/driver/capabilities#/$defs/ProviderModel/properties/effortLevels/items/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err21];}else {vErrors.push(err21);}errors++;}}}}else {const err22: any = {instancePath:instancePath+"/models/" + i0+"/effortLevels/" + i2,schemaPath:"sidekicks-contracts:provider/driver/capabilities#/$defs/ProviderModel/properties/effortLevels/items/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err22];}else {vErrors.push(err22);}errors++;}}var valid7: any = _errs24 === errors;if(!valid7){break;}}}else {const err23: any = {instancePath:instancePath+"/models/" + i0+"/effortLevels",schemaPath:"sidekicks-contracts:provider/driver/capabilities#/$defs/ProviderModel/properties/effortLevels/type",keyword:"type",params:{type: "array"}};if(vErrors === null){vErrors = [err23];}else {vErrors.push(err23);}errors++;}}var valid5: any = _errs22 === errors;}else {var valid5: any = true;}if(valid5){if(data2.outputSpeedLevels !== undefined){let data9: any = data2.outputSpeedLevels;const _errs26: any = errors;if(errors === _errs26){if(Array.isArray(data9)){var valid8: any = true;const len3: any = data9.length;for(let i3=0; i3<len3; i3++){let data10: any = data9[i3];const _errs28: any = errors;if(errors === _errs28){if(typeof data10 === "string"){if(func1(data10) > 128){const err24: any = {instancePath:instancePath+"/models/" + i0+"/outputSpeedLevels/" + i3,schemaPath:"sidekicks-contracts:provider/driver/capabilities#/$defs/ProviderModel/properties/outputSpeedLevels/items/maxLength",keyword:"maxLength",params:{limit: 128}};if(vErrors === null){vErrors = [err24];}else {vErrors.push(err24);}errors++;}else {if(func1(data10) < 1){const err25: any = {instancePath:instancePath+"/models/" + i0+"/outputSpeedLevels/" + i3,schemaPath:"sidekicks-contracts:provider/driver/capabilities#/$defs/ProviderModel/properties/outputSpeedLevels/items/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err25];}else {vErrors.push(err25);}errors++;}else {if(!pattern6.test(data10)){const err26: any = {instancePath:instancePath+"/models/" + i0+"/outputSpeedLevels/" + i3,schemaPath:"sidekicks-contracts:provider/driver/capabilities#/$defs/ProviderModel/properties/outputSpeedLevels/items/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err26];}else {vErrors.push(err26);}errors++;}}}}else {const err27: any = {instancePath:instancePath+"/models/" + i0+"/outputSpeedLevels/" + i3,schemaPath:"sidekicks-contracts:provider/driver/capabilities#/$defs/ProviderModel/properties/outputSpeedLevels/items/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err27];}else {vErrors.push(err27);}errors++;}}var valid8: any = _errs28 === errors;if(!valid8){break;}}}else {const err28: any = {instancePath:instancePath+"/models/" + i0+"/outputSpeedLevels",schemaPath:"sidekicks-contracts:provider/driver/capabilities#/$defs/ProviderModel/properties/outputSpeedLevels/type",keyword:"type",params:{type: "array"}};if(vErrors === null){vErrors = [err28];}else {vErrors.push(err28);}errors++;}}var valid5: any = _errs26 === errors;}else {var valid5: any = true;}if(valid5){if(data2.fast !== undefined){const _errs30: any = errors;if(typeof data2.fast !== "boolean"){const err29: any = {instancePath:instancePath+"/models/" + i0+"/fast",schemaPath:"sidekicks-contracts:provider/driver/capabilities#/$defs/ProviderModel/properties/fast/type",keyword:"type",params:{type: "boolean"}};if(vErrors === null){vErrors = [err29];}else {vErrors.push(err29);}errors++;}var valid5: any = _errs30 === errors;}else {var valid5: any = true;}if(valid5){if(data2.largerWindow !== undefined){const _errs32: any = errors;if(typeof data2.largerWindow !== "boolean"){const err30: any = {instancePath:instancePath+"/models/" + i0+"/largerWindow",schemaPath:"sidekicks-contracts:provider/driver/capabilities#/$defs/ProviderModel/properties/largerWindow/type",keyword:"type",params:{type: "boolean"}};if(vErrors === null){vErrors = [err30];}else {vErrors.push(err30);}errors++;}var valid5: any = _errs32 === errors;}else {var valid5: any = true;}if(valid5){if(data2.contextWindow !== undefined){let data13: any = data2.contextWindow;const _errs34: any = errors;if(!(((typeof data13 == "number") && (!(data13 % 1) && !isNaN(data13))) && (isFinite(data13)))){const err31: any = {instancePath:instancePath+"/models/" + i0+"/contextWindow",schemaPath:"sidekicks-contracts:provider/driver/capabilities#/$defs/ProviderModel/properties/contextWindow/type",keyword:"type",params:{type: "integer"}};if(vErrors === null){vErrors = [err31];}else {vErrors.push(err31);}errors++;}if(errors === _errs34){if((typeof data13 == "number") && (isFinite(data13))){if(data13 > 9007199254740991 || isNaN(data13)){const err32: any = {instancePath:instancePath+"/models/" + i0+"/contextWindow",schemaPath:"sidekicks-contracts:provider/driver/capabilities#/$defs/ProviderModel/properties/contextWindow/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}};if(vErrors === null){vErrors = [err32];}else {vErrors.push(err32);}errors++;}else {if(data13 < 1 || isNaN(data13)){const err33: any = {instancePath:instancePath+"/models/" + i0+"/contextWindow",schemaPath:"sidekicks-contracts:provider/driver/capabilities#/$defs/ProviderModel/properties/contextWindow/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}};if(vErrors === null){vErrors = [err33];}else {vErrors.push(err33);}errors++;}}}}var valid5: any = _errs34 === errors;}else {var valid5: any = true;}}}}}}}}}}}else {const err34: any = {instancePath:instancePath+"/models/" + i0,schemaPath:"sidekicks-contracts:provider/driver/capabilities#/$defs/ProviderModel/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err34];}else {vErrors.push(err34);}errors++;}}var valid3: any = _errs10 === errors;if(!valid3){break;}}}else {const err35: any = {instancePath:instancePath+"/models",schemaPath:"#/anyOf/0/properties/models/type",keyword:"type",params:{type: "array"}};if(vErrors === null){vErrors = [err35];}else {vErrors.push(err35);}errors++;}}var valid1: any = _errs8 === errors;}else {var valid1: any = true;}if(valid1){if(data.failure !== undefined){const _errs36: any = errors;const err36: any = {instancePath:instancePath+"/failure",schemaPath:"#/anyOf/0/properties/failure/not",keyword:"not",params:{}};if(vErrors === null){vErrors = [err36];}else {vErrors.push(err36);}errors++;var valid1: any = _errs36 === errors;}else {var valid1: any = true;}}}}}}else {const err37: any = {instancePath,schemaPath:"#/anyOf/0/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err37];}else {vErrors.push(err37);}errors++;}}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}const _errs39: any = errors;if(errors === _errs39){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if(((data.providerName === undefined) && (missing2 = "providerName")) || ((data.failure === undefined) && (missing2 = "failure"))){const err38: any = {instancePath,schemaPath:"#/anyOf/1/required",keyword:"required",params:{missingProperty: missing2}};if(vErrors === null){vErrors = [err38];}else {vErrors.push(err38);}errors++;}else {const _errs41: any = errors;for(const key2 in data){if(!(((key2 === "providerName") || (key2 === "failure")) || (key2 === "models"))){const err39: any = {instancePath,schemaPath:"#/anyOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}};if(vErrors === null){vErrors = [err39];}else {vErrors.push(err39);}errors++;break;}}if(_errs41 === errors){if(data.providerName !== undefined){let data15: any = data.providerName;const _errs42: any = errors;const _errs43: any = errors;if(errors === _errs43){if(typeof data15 === "string"){if(!pattern16.test(data15)){const err40: any = {instancePath:instancePath+"/providerName",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}};if(vErrors === null){vErrors = [err40];}else {vErrors.push(err40);}errors++;}}else {const err41: any = {instancePath:instancePath+"/providerName",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err41];}else {vErrors.push(err41);}errors++;}}var valid9: any = _errs42 === errors;}else {var valid9: any = true;}if(valid9){if(data.failure !== undefined){let data16: any = data.failure;const _errs46: any = errors;const _errs47: any = errors;if(errors === _errs47){if(data16 && typeof data16 == "object" && !Array.isArray(data16)){let missing3: any;if((data16.code === undefined) && (missing3 = "code")){const err42: any = {instancePath:instancePath+"/failure",schemaPath:"#/$defs/ProviderReadFailure/required",keyword:"required",params:{missingProperty: missing3}};if(vErrors === null){vErrors = [err42];}else {vErrors.push(err42);}errors++;}else {const _errs49: any = errors;for(const key3 in data16){if(!((key3 === "code") || (key3 === "providerFailureDetail"))){const err43: any = {instancePath:instancePath+"/failure",schemaPath:"#/$defs/ProviderReadFailure/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}};if(vErrors === null){vErrors = [err43];}else {vErrors.push(err43);}errors++;break;}}if(_errs49 === errors){if(data16.code !== undefined){const _errs50: any = errors;if(typeof data16.code !== "string"){const err44: any = {instancePath:instancePath+"/failure/code",schemaPath:"#/$defs/ProviderReadFailure/properties/code/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err44];}else {vErrors.push(err44);}errors++;}var valid12: any = _errs50 === errors;}else {var valid12: any = true;}if(valid12){if(data16.providerFailureDetail !== undefined){let data18: any = data16.providerFailureDetail;const _errs52: any = errors;if(errors === _errs52){if(typeof data18 === "string"){if(func1(data18) > 32768){const err45: any = {instancePath:instancePath+"/failure/providerFailureDetail",schemaPath:"#/$defs/ProviderReadFailure/properties/providerFailureDetail/maxLength",keyword:"maxLength",params:{limit: 32768}};if(vErrors === null){vErrors = [err45];}else {vErrors.push(err45);}errors++;}else {if(func1(data18) < 1){const err46: any = {instancePath:instancePath+"/failure/providerFailureDetail",schemaPath:"#/$defs/ProviderReadFailure/properties/providerFailureDetail/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err46];}else {vErrors.push(err46);}errors++;}else {if(!pattern6.test(data18)){const err47: any = {instancePath:instancePath+"/failure/providerFailureDetail",schemaPath:"#/$defs/ProviderReadFailure/properties/providerFailureDetail/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err47];}else {vErrors.push(err47);}errors++;}}}}else {const err48: any = {instancePath:instancePath+"/failure/providerFailureDetail",schemaPath:"#/$defs/ProviderReadFailure/properties/providerFailureDetail/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err48];}else {vErrors.push(err48);}errors++;}}var valid12: any = _errs52 === errors;}else {var valid12: any = true;}}}}}else {const err49: any = {instancePath:instancePath+"/failure",schemaPath:"#/$defs/ProviderReadFailure/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err49];}else {vErrors.push(err49);}errors++;}}var valid9: any = _errs46 === errors;}else {var valid9: any = true;}if(valid9){if(data.models !== undefined){const _errs54: any = errors;const err50: any = {instancePath:instancePath+"/models",schemaPath:"#/anyOf/1/properties/models/not",keyword:"not",params:{}};if(vErrors === null){vErrors = [err50];}else {vErrors.push(err50);}errors++;var valid9: any = _errs54 === errors;}else {var valid9: any = true;}}}}}}else {const err51: any = {instancePath,schemaPath:"#/anyOf/1/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err51];}else {vErrors.push(err51);}errors++;}}var _valid0: any = _errs39 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}if(!valid0){const err52: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err52];}else {vErrors.push(err52);}errors++;validate1525.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validate1525.errors = vErrors;evaluated0.props = props0;return errors === 0;}
// prettier-ignore
validate1525.errors = null as any[] | null;
// prettier-ignore
validate1525.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
// prettier-ignore
function validate1524(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderModelListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1524.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.providers === undefined) && (missing0 = "providers")){validate1524.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "providers")){validate1524.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.providers !== undefined){let data0: any = data.providers;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validate1525.call(this, data0[i0], {instancePath:instancePath+"/providers/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1525.errors : vErrors.concat(validate1525.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validate1524.errors = [{instancePath:instancePath+"/providers",schemaPath:"#/properties/providers/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validate1524.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1524.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1524.errors = null as any[] | null;
// prettier-ignore
validate1524.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AgentRunContextCompactRequest}. */
export const validateAgentRunContextCompactRequest: SchemaCheck<AgentRunContextCompactRequest> =
  validate1517;
/** Checks that a value is a {@link ProviderCommandListRequest}. */
export const validateProviderCommandListRequest: SchemaCheck<ProviderCommandListRequest> =
  validate1518;
/** Checks that a value is a {@link ProviderModeListRequest}. */
export const validateProviderModeListRequest: SchemaCheck<ProviderModeListRequest> = validate1519;
/** Checks that a value is a {@link ProviderModeListResponse}. */
export const validateProviderModeListResponse: SchemaCheck<ProviderModeListResponse> = validate1520;
/** Checks that a value is a {@link ProviderModelListRequest}. */
export const validateProviderModelListRequest: SchemaCheck<ProviderModelListRequest> = validate1523;
/** Checks that a value is a {@link ProviderModelListResponse}. */
export const validateProviderModelListResponse: SchemaCheck<ProviderModelListResponse> =
  validate1524;

/** The methods of {@link PROVIDER_DRIVER_METHOD_DESCRIPTORS}, each with its checks. */
export interface ProviderDriverMethodDescriptors {
  readonly "provider.model.list": {
    readonly method: "provider.model.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<ProviderModelListRequest>;
    readonly responseCheck: SchemaCheck<ProviderModelListResponse>;
  };
  readonly "provider.mode.list": {
    readonly method: "provider.mode.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<ProviderModeListRequest>;
    readonly responseCheck: SchemaCheck<ProviderModeListResponse>;
  };
  readonly "agent.run.context.compact": {
    readonly method: "agent.run.context.compact";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<AgentRunContextCompactRequest>;
    readonly responseCheck: SchemaCheck<AgentRunContextCompactResponse>;
  };
  readonly "provider.command.list": {
    readonly method: "provider.command.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<ProviderCommandListRequest>;
    readonly responseCheck: SchemaCheck<ProviderCommandListResponse>;
  };
}
/** The driver methods a client calls: their names, how each answers, and their shapes. */
export const PROVIDER_DRIVER_METHOD_DESCRIPTORS: ProviderDriverMethodDescriptors = Object.freeze({
  "provider.model.list": Object.freeze({
    method: "provider.model.list",
    procedureType: "query",
    mutating: false,
    requestCheck: validateProviderModelListRequest,
    responseCheck: validateProviderModelListResponse,
  }),
  "provider.mode.list": Object.freeze({
    method: "provider.mode.list",
    procedureType: "query",
    mutating: false,
    requestCheck: validateProviderModeListRequest,
    responseCheck: validateProviderModeListResponse,
  }),
  "agent.run.context.compact": Object.freeze({
    method: "agent.run.context.compact",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateAgentRunContextCompactRequest,
    responseCheck: validateAgentRunContextCompactResponse,
  }),
  "provider.command.list": Object.freeze({
    method: "provider.command.list",
    procedureType: "query",
    mutating: false,
    requestCheck: validateProviderCommandListRequest,
    responseCheck: validateProviderCommandListResponse,
  }),
});
