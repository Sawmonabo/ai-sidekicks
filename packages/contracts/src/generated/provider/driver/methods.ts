// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The driver methods a client calls (`provider.model.list`, `provider.mode.list`, `provider.command.list`, `agent.run.context.compact`), their requests and replies, grouped by provider.

import { type CompiledSchemaCheck, type SchemaCheck, ucs2length } from "../../../schema-check.js";
import { type AgentId, validateAgentId } from "../../agent/definition.js";
import { type RunId, validateRunId } from "../../run/id.js";
import { type SessionId, validateSessionId } from "../../session/id.js";
import { type ProviderId, validateProviderId } from "../id.js";
import {
  type ProviderMode,
  type ProviderModel,
  validateProviderMode,
  validateProviderModel,
} from "./capabilities.js";
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

/** Checks that a value is a {@link ProviderModelListRequest}. */
// prettier-ignore
export const validateProviderModelListRequest: CompiledSchemaCheck<ProviderModelListRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderModelListRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderModelListRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validateProviderModelListRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "sessionId")){validateProviderModelListRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}}}}}else {validateProviderModelListRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProviderModelListRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderModelListRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProviderModeListRequest}. */
// prettier-ignore
export const validateProviderModeListRequest: CompiledSchemaCheck<ProviderModeListRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderModeListRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderModeListRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validateProviderModeListRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "sessionId")){validateProviderModeListRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}}}}}else {validateProviderModeListRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProviderModeListRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderModeListRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern5 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
/** Checks that a value is a {@link ProviderReadFailure}. */
// prettier-ignore
export const validateProviderReadFailure: CompiledSchemaCheck<ProviderReadFailure> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderReadFailure {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderReadFailure.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.code === undefined) && (missing0 = "code")){validateProviderReadFailure.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "code") || (key0 === "providerFailureDetail"))){validateProviderReadFailure.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.code !== undefined){const _errs2: any = errors;if(typeof data.code !== "string"){validateProviderReadFailure.errors = [{instancePath:instancePath+"/code",schemaPath:"#/properties/code/type",keyword:"type",params:{type: "string"}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.providerFailureDetail !== undefined){let data1: any = data.providerFailureDetail;const _errs4: any = errors;if(errors === _errs4){if(typeof data1 === "string"){if(func1(data1) > 32768){validateProviderReadFailure.errors = [{instancePath:instancePath+"/providerFailureDetail",schemaPath:"#/properties/providerFailureDetail/maxLength",keyword:"maxLength",params:{limit: 32768}}];return false;}else {if(func1(data1) < 1){validateProviderReadFailure.errors = [{instancePath:instancePath+"/providerFailureDetail",schemaPath:"#/properties/providerFailureDetail/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data1)){validateProviderReadFailure.errors = [{instancePath:instancePath+"/providerFailureDetail",schemaPath:"#/properties/providerFailureDetail/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateProviderReadFailure.errors = [{instancePath:instancePath+"/providerFailureDetail",schemaPath:"#/properties/providerFailureDetail/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validateProviderReadFailure.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProviderReadFailure.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderReadFailure.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProviderModelReport}. */
// prettier-ignore
export const validateProviderModelReport: CompiledSchemaCheck<ProviderModelReport> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderModelReport {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderModelReport.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(errors === _errs1){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.providerName === undefined) && (missing0 = "providerName")) || ((data.models === undefined) && (missing0 = "models"))){const err0: any = {instancePath,schemaPath:"#/anyOf/0/required",keyword:"required",params:{missingProperty: missing0}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {const _errs3: any = errors;for(const key0 in data){if(!(((key0 === "providerName") || (key0 === "models")) || (key0 === "failure"))){const err1: any = {instancePath,schemaPath:"#/anyOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;break;}}if(_errs3 === errors){if(data.providerName !== undefined){const _errs4: any = errors;if(!(validateProviderId.call(this, data.providerName, {instancePath:instancePath+"/providerName",parentData:data,parentDataProperty:"providerName",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderId.errors : vErrors.concat(validateProviderId.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;}else {var valid1: any = true;}if(valid1){if(data.models !== undefined){let data1: any = data.models;const _errs5: any = errors;if(errors === _errs5){if(Array.isArray(data1)){var valid2: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){const _errs7: any = errors;if(!(validateProviderModel.call(this, data1[i0], {instancePath:instancePath+"/models/" + i0,parentData:data1,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderModel.errors : vErrors.concat(validateProviderModel.errors);errors = vErrors.length;}var valid2: any = _errs7 === errors;if(!valid2){break;}}}else {const err2: any = {instancePath:instancePath+"/models",schemaPath:"#/anyOf/0/properties/models/type",keyword:"type",params:{type: "array"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}}var valid1: any = _errs5 === errors;}else {var valid1: any = true;}if(valid1){if(data.failure !== undefined){const _errs8: any = errors;const err3: any = {instancePath:instancePath+"/failure",schemaPath:"#/anyOf/0/properties/failure/not",keyword:"not",params:{}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;var valid1: any = _errs8 === errors;}else {var valid1: any = true;}}}}}}else {const err4: any = {instancePath,schemaPath:"#/anyOf/0/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}const _errs11: any = errors;if(errors === _errs11){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((data.providerName === undefined) && (missing1 = "providerName")) || ((data.failure === undefined) && (missing1 = "failure"))){const err5: any = {instancePath,schemaPath:"#/anyOf/1/required",keyword:"required",params:{missingProperty: missing1}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}else {const _errs13: any = errors;for(const key1 in data){if(!(((key1 === "providerName") || (key1 === "failure")) || (key1 === "models"))){const err6: any = {instancePath,schemaPath:"#/anyOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;break;}}if(_errs13 === errors){if(data.providerName !== undefined){const _errs14: any = errors;if(!(validateProviderId.call(this, data.providerName, {instancePath:instancePath+"/providerName",parentData:data,parentDataProperty:"providerName",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderId.errors : vErrors.concat(validateProviderId.errors);errors = vErrors.length;}var valid3: any = _errs14 === errors;}else {var valid3: any = true;}if(valid3){if(data.failure !== undefined){const _errs15: any = errors;if(!(validateProviderReadFailure.call(this, data.failure, {instancePath:instancePath+"/failure",parentData:data,parentDataProperty:"failure",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderReadFailure.errors : vErrors.concat(validateProviderReadFailure.errors);errors = vErrors.length;}var valid3: any = _errs15 === errors;}else {var valid3: any = true;}if(valid3){if(data.models !== undefined){const _errs16: any = errors;const err7: any = {instancePath:instancePath+"/models",schemaPath:"#/anyOf/1/properties/models/not",keyword:"not",params:{}};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;var valid3: any = _errs16 === errors;}else {var valid3: any = true;}}}}}}else {const err8: any = {instancePath,schemaPath:"#/anyOf/1/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;}}var _valid0: any = _errs11 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}if(!valid0){const err9: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;validateProviderModelReport.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validateProviderModelReport.errors = vErrors;evaluated0.props = props0;return errors === 0;};
// prettier-ignore
validateProviderModelReport.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProviderModelListResponse}. */
// prettier-ignore
export const validateProviderModelListResponse: CompiledSchemaCheck<ProviderModelListResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderModelListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderModelListResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.providers === undefined) && (missing0 = "providers")){validateProviderModelListResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "providers")){validateProviderModelListResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.providers !== undefined){let data0: any = data.providers;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validateProviderModelReport.call(this, data0[i0], {instancePath:instancePath+"/providers/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderModelReport.errors : vErrors.concat(validateProviderModelReport.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validateProviderModelListResponse.errors = [{instancePath:instancePath+"/providers",schemaPath:"#/properties/providers/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validateProviderModelListResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProviderModelListResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderModelListResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProviderModeReport}. */
// prettier-ignore
export const validateProviderModeReport: CompiledSchemaCheck<ProviderModeReport> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderModeReport {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderModeReport.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(errors === _errs1){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.providerName === undefined) && (missing0 = "providerName")) || ((data.modes === undefined) && (missing0 = "modes"))){const err0: any = {instancePath,schemaPath:"#/anyOf/0/required",keyword:"required",params:{missingProperty: missing0}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {const _errs3: any = errors;for(const key0 in data){if(!(((key0 === "providerName") || (key0 === "modes")) || (key0 === "failure"))){const err1: any = {instancePath,schemaPath:"#/anyOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;break;}}if(_errs3 === errors){if(data.providerName !== undefined){const _errs4: any = errors;if(!(validateProviderId.call(this, data.providerName, {instancePath:instancePath+"/providerName",parentData:data,parentDataProperty:"providerName",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderId.errors : vErrors.concat(validateProviderId.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;}else {var valid1: any = true;}if(valid1){if(data.modes !== undefined){let data1: any = data.modes;const _errs5: any = errors;if(errors === _errs5){if(Array.isArray(data1)){var valid2: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){const _errs7: any = errors;if(!(validateProviderMode.call(this, data1[i0], {instancePath:instancePath+"/modes/" + i0,parentData:data1,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderMode.errors : vErrors.concat(validateProviderMode.errors);errors = vErrors.length;}var valid2: any = _errs7 === errors;if(!valid2){break;}}}else {const err2: any = {instancePath:instancePath+"/modes",schemaPath:"#/anyOf/0/properties/modes/type",keyword:"type",params:{type: "array"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}}var valid1: any = _errs5 === errors;}else {var valid1: any = true;}if(valid1){if(data.failure !== undefined){const _errs8: any = errors;const err3: any = {instancePath:instancePath+"/failure",schemaPath:"#/anyOf/0/properties/failure/not",keyword:"not",params:{}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;var valid1: any = _errs8 === errors;}else {var valid1: any = true;}}}}}}else {const err4: any = {instancePath,schemaPath:"#/anyOf/0/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}const _errs11: any = errors;if(errors === _errs11){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((data.providerName === undefined) && (missing1 = "providerName")) || ((data.failure === undefined) && (missing1 = "failure"))){const err5: any = {instancePath,schemaPath:"#/anyOf/1/required",keyword:"required",params:{missingProperty: missing1}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}else {const _errs13: any = errors;for(const key1 in data){if(!(((key1 === "providerName") || (key1 === "failure")) || (key1 === "modes"))){const err6: any = {instancePath,schemaPath:"#/anyOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;break;}}if(_errs13 === errors){if(data.providerName !== undefined){const _errs14: any = errors;if(!(validateProviderId.call(this, data.providerName, {instancePath:instancePath+"/providerName",parentData:data,parentDataProperty:"providerName",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderId.errors : vErrors.concat(validateProviderId.errors);errors = vErrors.length;}var valid3: any = _errs14 === errors;}else {var valid3: any = true;}if(valid3){if(data.failure !== undefined){const _errs15: any = errors;if(!(validateProviderReadFailure.call(this, data.failure, {instancePath:instancePath+"/failure",parentData:data,parentDataProperty:"failure",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderReadFailure.errors : vErrors.concat(validateProviderReadFailure.errors);errors = vErrors.length;}var valid3: any = _errs15 === errors;}else {var valid3: any = true;}if(valid3){if(data.modes !== undefined){const _errs16: any = errors;const err7: any = {instancePath:instancePath+"/modes",schemaPath:"#/anyOf/1/properties/modes/not",keyword:"not",params:{}};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;var valid3: any = _errs16 === errors;}else {var valid3: any = true;}}}}}}else {const err8: any = {instancePath,schemaPath:"#/anyOf/1/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;}}var _valid0: any = _errs11 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}if(!valid0){const err9: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;validateProviderModeReport.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validateProviderModeReport.errors = vErrors;evaluated0.props = props0;return errors === 0;};
// prettier-ignore
validateProviderModeReport.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProviderModeListResponse}. */
// prettier-ignore
export const validateProviderModeListResponse: CompiledSchemaCheck<ProviderModeListResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderModeListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderModeListResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.providers === undefined) && (missing0 = "providers")){validateProviderModeListResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "providers")){validateProviderModeListResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.providers !== undefined){let data0: any = data.providers;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validateProviderModeReport.call(this, data0[i0], {instancePath:instancePath+"/providers/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderModeReport.errors : vErrors.concat(validateProviderModeReport.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validateProviderModeListResponse.errors = [{instancePath:instancePath+"/providers",schemaPath:"#/properties/providers/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validateProviderModeListResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProviderModeListResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderModeListResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AgentRunContextCompactRequest}. */
// prettier-ignore
export const validateAgentRunContextCompactRequest: CompiledSchemaCheck<AgentRunContextCompactRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentRunContextCompactRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAgentRunContextCompactRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.runId === undefined) && (missing0 = "runId"))){validateAgentRunContextCompactRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "runId"))){validateAgentRunContextCompactRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.runId !== undefined){const _errs3: any = errors;if(!(validateRunId.call(this, data.runId, {instancePath:instancePath+"/runId",parentData:data,parentDataProperty:"runId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunId.errors : vErrors.concat(validateRunId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateAgentRunContextCompactRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAgentRunContextCompactRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAgentRunContextCompactRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProviderCommandListRequest}. */
// prettier-ignore
export const validateProviderCommandListRequest: CompiledSchemaCheck<ProviderCommandListRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderCommandListRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderCommandListRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.agentId === undefined) && (missing0 = "agentId"))){validateProviderCommandListRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "agentId"))){validateProviderCommandListRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.agentId !== undefined){const _errs3: any = errors;if(!(validateAgentId.call(this, data.agentId, {instancePath:instancePath+"/agentId",parentData:data,parentDataProperty:"agentId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAgentId.errors : vErrors.concat(validateAgentId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateProviderCommandListRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProviderCommandListRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderCommandListRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;

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
