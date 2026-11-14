// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The choices a provider asks the person to make while a run waits on the answer: the retry-or-edit choice after a refusal and the switch-or-credits choice when a model needs usage credits.

import { type CompiledSchemaCheck, ucs2length } from "../../schema-check.js";
import { type SessionId, validateSessionId } from "../session/id.js";
import { type DeviceId, validateDeviceId } from "../trust-statement.js";
import { type RunId, validateRunId } from "./id.js";

/**
 * The person's answer when the provider's safety check refuses a turn and names a fallback model:
 * `retryFallback` goes on on the fallback model, and `editPrompt` ends the turn refused and
 * returns the message to the composer. The driver translates each value to the provider's own
 * answer.
 */
export type RunRefusalChoice = "retryFallback" | "editPrompt";
/**
 * How the retry-or-edit choice ended with no answer: `canceled` is an interrupt or a message sent
 * while it waits, or an interrupted end of its run, and the driver maps the provider's own cancel
 * answer to it; `runEnded` is any other end of its run, a restart of the background service
 * among them.
 */
export type RunRefusalChoiceUnanswered = "canceled" | "runEnded";
/**
 * How the retry-or-edit choice settled: the person's answer, or an end with none.
 */
export type RunRefusalChoiceSettlement = RunRefusalChoice | RunRefusalChoiceUnanswered;
/**
 * The person's answer when a turn's model needs usage credits: `switchDefault` moves the turn to
 * the fallback model, and `consent` goes on on usage credits, which the provider accepts only
 * while credits are on. The driver translates each value to the provider's own answer.
 */
export type RunUsageCreditsChoice = "switchDefault" | "consent";
/**
 * How the switch-or-credits choice ended with no answer: `interrupted` is an interrupt or an
 * undo while it waits, which ends the turn on that model, or an interrupted end of its run;
 * `unanswered` is the provider settling it when a message is sent while it waits; `runEnded` is
 * any other end of its run, a restart of the background service among them.
 */
export type RunUsageCreditsChoiceUnanswered = "interrupted" | "unanswered" | "runEnded";
/**
 * How the switch-or-credits choice settled: the person's answer, or an end with none.
 */
export type RunUsageCreditsChoiceSettlement =
  | RunUsageCreditsChoice
  | RunUsageCreditsChoiceUnanswered;

/**
 * Answers the retry-or-edit choice a refused run waits on (`agent.run.refusalChoice.resolve`). The
 * first answer settles it; a second or late one is refused with `agent.run.invalidTransition`.
 */
export interface AgentRunRefusalChoiceResolveRequest {
  /**
   * The run that waits.
   */
  runId: RunId;
  /**
   * The answer.
   */
  choice: RunRefusalChoice;
}
/**
 * The payload of `agent.run.refusalChoice.requested`: the refusing model, the fallback it names,
 * the provider's own sentence and check category when it sends them, and the ids of the rows
 * already streamed for the refused answer, which leave the flow when the choice is answered.
 */
export interface AgentRunRefusalChoiceRequestedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run that waits.
   */
  runId: RunId;
  /**
   * The model that refused.
   */
  refusedModel: string;
  /**
   * The model a retry goes on on.
   */
  fallbackModel: string;
  /**
   * The provider's own sentence, where it sent one.
   */
  sentence?: string;
  /**
   * The provider's open safety category, where it sent one.
   */
  safetyCategory?: string;
  /**
   * The rows already streamed for the refused answer.
   */
  retractedMessageIds?: string[];
}
/**
 * The payload of `agent.run.refusalChoice.resolved`: the answer that settled the choice, and the
 * device that sent a person's answer.
 */
export interface AgentRunRefusalChoiceResolvedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run.
   */
  runId: RunId;
  /**
   * How it settled.
   */
  choice: RunRefusalChoiceSettlement;
  /**
   * The device that sent a person's answer.
   */
  deviceId?: DeviceId;
}
/**
 * Answers the switch-or-credits choice a run waits on (`agent.run.usageCreditsChoice.resolve`).
 * The first answer settles it; a second or late one is refused with `agent.run.invalidTransition`.
 */
export interface AgentRunUsageCreditsChoiceResolveRequest {
  /**
   * The run that waits.
   */
  runId: RunId;
  /**
   * The answer.
   */
  choice: RunUsageCreditsChoice;
}
/**
 * The payload of `agent.run.usageCreditsChoice.requested`: the model that needs credits, whether
 * credits are on, the balance and its currency when the provider reports them, and the model a
 * switch moves to when the provider's model list names one.
 */
export interface AgentRunUsageCreditsChoiceRequestedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run that waits.
   */
  runId: RunId;
  /**
   * The model that needs credits.
   */
  modelName: string;
  /**
   * Whether usage credits are on.
   */
  overagesEnabled: boolean;
  /**
   * The credit balance in cents, where the provider reports it.
   */
  balanceCents?: number;
  /**
   * The balance's currency, where the provider reports it.
   */
  currency?: string;
  /**
   * The model a switch moves to, where the provider's model list names one.
   */
  fallbackModel?: string;
}
/**
 * The payload of `agent.run.usageCreditsChoice.resolved`: how the choice settled, and the device
 * that sent a person's answer.
 */
export interface AgentRunUsageCreditsChoiceResolvedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run.
   */
  runId: RunId;
  /**
   * How it settled.
   */
  choice: RunUsageCreditsChoiceSettlement;
  /**
   * The device that sent a person's answer.
   */
  deviceId?: DeviceId;
}

// prettier-ignore
const schema499: any = {"description":"The person's answer when the provider's safety check refuses a turn and names a fallback model:\n`retryFallback` goes on on the fallback model, and `editPrompt` ends the turn refused and\nreturns the message to the composer. The driver translates each value to the provider's own\nanswer.","type":"string","enum":["retryFallback","editPrompt"]};
/** Checks that a value is a {@link RunRefusalChoice}. */
// prettier-ignore
export const validateRunRefusalChoice: CompiledSchemaCheck<RunRefusalChoice> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is RunRefusalChoice {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateRunRefusalChoice.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateRunRefusalChoice.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data === "retryFallback") || (data === "editPrompt"))){validateRunRefusalChoice.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema499.enum}}];return false;}validateRunRefusalChoice.errors = vErrors;return errors === 0;};
// prettier-ignore
validateRunRefusalChoice.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AgentRunRefusalChoiceResolveRequest}. */
// prettier-ignore
export const validateAgentRunRefusalChoiceResolveRequest: CompiledSchemaCheck<AgentRunRefusalChoiceResolveRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentRunRefusalChoiceResolveRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAgentRunRefusalChoiceResolveRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.runId === undefined) && (missing0 = "runId")) || ((data.choice === undefined) && (missing0 = "choice"))){validateAgentRunRefusalChoiceResolveRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "runId") || (key0 === "choice"))){validateAgentRunRefusalChoiceResolveRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.runId !== undefined){const _errs2: any = errors;if(!(validateRunId.call(this, data.runId, {instancePath:instancePath+"/runId",parentData:data,parentDataProperty:"runId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunId.errors : vErrors.concat(validateRunId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.choice !== undefined){const _errs3: any = errors;if(!(validateRunRefusalChoice.call(this, data.choice, {instancePath:instancePath+"/choice",parentData:data,parentDataProperty:"choice",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunRefusalChoice.errors : vErrors.concat(validateRunRefusalChoice.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateAgentRunRefusalChoiceResolveRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAgentRunRefusalChoiceResolveRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAgentRunRefusalChoiceResolveRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern5 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
/** Checks that a value is a {@link AgentRunRefusalChoiceRequestedPayload}. */
// prettier-ignore
export const validateAgentRunRefusalChoiceRequestedPayload: CompiledSchemaCheck<AgentRunRefusalChoiceRequestedPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentRunRefusalChoiceRequestedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAgentRunRefusalChoiceRequestedPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.runId === undefined) && (missing0 = "runId"))) || ((data.refusedModel === undefined) && (missing0 = "refusedModel"))) || ((data.fallbackModel === undefined) && (missing0 = "fallbackModel"))){validateAgentRunRefusalChoiceRequestedPayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((((key0 === "sessionId") || (key0 === "runId")) || (key0 === "refusedModel")) || (key0 === "fallbackModel")) || (key0 === "sentence")) || (key0 === "safetyCategory")) || (key0 === "retractedMessageIds"))){validateAgentRunRefusalChoiceRequestedPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.runId !== undefined){const _errs3: any = errors;if(!(validateRunId.call(this, data.runId, {instancePath:instancePath+"/runId",parentData:data,parentDataProperty:"runId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunId.errors : vErrors.concat(validateRunId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.refusedModel !== undefined){let data2: any = data.refusedModel;const _errs4: any = errors;if(errors === _errs4){if(typeof data2 === "string"){if(func1(data2) > 256){validateAgentRunRefusalChoiceRequestedPayload.errors = [{instancePath:instancePath+"/refusedModel",schemaPath:"#/properties/refusedModel/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data2) < 1){validateAgentRunRefusalChoiceRequestedPayload.errors = [{instancePath:instancePath+"/refusedModel",schemaPath:"#/properties/refusedModel/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data2)){validateAgentRunRefusalChoiceRequestedPayload.errors = [{instancePath:instancePath+"/refusedModel",schemaPath:"#/properties/refusedModel/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateAgentRunRefusalChoiceRequestedPayload.errors = [{instancePath:instancePath+"/refusedModel",schemaPath:"#/properties/refusedModel/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.fallbackModel !== undefined){let data3: any = data.fallbackModel;const _errs6: any = errors;if(errors === _errs6){if(typeof data3 === "string"){if(func1(data3) > 256){validateAgentRunRefusalChoiceRequestedPayload.errors = [{instancePath:instancePath+"/fallbackModel",schemaPath:"#/properties/fallbackModel/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data3) < 1){validateAgentRunRefusalChoiceRequestedPayload.errors = [{instancePath:instancePath+"/fallbackModel",schemaPath:"#/properties/fallbackModel/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data3)){validateAgentRunRefusalChoiceRequestedPayload.errors = [{instancePath:instancePath+"/fallbackModel",schemaPath:"#/properties/fallbackModel/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateAgentRunRefusalChoiceRequestedPayload.errors = [{instancePath:instancePath+"/fallbackModel",schemaPath:"#/properties/fallbackModel/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.sentence !== undefined){let data4: any = data.sentence;const _errs8: any = errors;if(errors === _errs8){if(typeof data4 === "string"){if(func1(data4) > 32768){validateAgentRunRefusalChoiceRequestedPayload.errors = [{instancePath:instancePath+"/sentence",schemaPath:"#/properties/sentence/maxLength",keyword:"maxLength",params:{limit: 32768}}];return false;}else {if(func1(data4) < 1){validateAgentRunRefusalChoiceRequestedPayload.errors = [{instancePath:instancePath+"/sentence",schemaPath:"#/properties/sentence/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data4)){validateAgentRunRefusalChoiceRequestedPayload.errors = [{instancePath:instancePath+"/sentence",schemaPath:"#/properties/sentence/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateAgentRunRefusalChoiceRequestedPayload.errors = [{instancePath:instancePath+"/sentence",schemaPath:"#/properties/sentence/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.safetyCategory !== undefined){let data5: any = data.safetyCategory;const _errs10: any = errors;if(errors === _errs10){if(typeof data5 === "string"){if(func1(data5) > 256){validateAgentRunRefusalChoiceRequestedPayload.errors = [{instancePath:instancePath+"/safetyCategory",schemaPath:"#/properties/safetyCategory/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data5) < 1){validateAgentRunRefusalChoiceRequestedPayload.errors = [{instancePath:instancePath+"/safetyCategory",schemaPath:"#/properties/safetyCategory/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data5)){validateAgentRunRefusalChoiceRequestedPayload.errors = [{instancePath:instancePath+"/safetyCategory",schemaPath:"#/properties/safetyCategory/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateAgentRunRefusalChoiceRequestedPayload.errors = [{instancePath:instancePath+"/safetyCategory",schemaPath:"#/properties/safetyCategory/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.retractedMessageIds !== undefined){let data6: any = data.retractedMessageIds;const _errs12: any = errors;if(errors === _errs12){if(Array.isArray(data6)){var valid1: any = true;const len0: any = data6.length;for(let i0=0; i0<len0; i0++){let data7: any = data6[i0];const _errs14: any = errors;if(errors === _errs14){if(typeof data7 === "string"){if(func1(data7) > 256){validateAgentRunRefusalChoiceRequestedPayload.errors = [{instancePath:instancePath+"/retractedMessageIds/" + i0,schemaPath:"#/properties/retractedMessageIds/items/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data7) < 1){validateAgentRunRefusalChoiceRequestedPayload.errors = [{instancePath:instancePath+"/retractedMessageIds/" + i0,schemaPath:"#/properties/retractedMessageIds/items/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data7)){validateAgentRunRefusalChoiceRequestedPayload.errors = [{instancePath:instancePath+"/retractedMessageIds/" + i0,schemaPath:"#/properties/retractedMessageIds/items/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateAgentRunRefusalChoiceRequestedPayload.errors = [{instancePath:instancePath+"/retractedMessageIds/" + i0,schemaPath:"#/properties/retractedMessageIds/items/type",keyword:"type",params:{type: "string"}}];return false;}}var valid1: any = _errs14 === errors;if(!valid1){break;}}}else {validateAgentRunRefusalChoiceRequestedPayload.errors = [{instancePath:instancePath+"/retractedMessageIds",schemaPath:"#/properties/retractedMessageIds/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}}}}}}}}}}else {validateAgentRunRefusalChoiceRequestedPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAgentRunRefusalChoiceRequestedPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAgentRunRefusalChoiceRequestedPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema500: any = {"description":"How the retry-or-edit choice ended with no answer: `canceled` is an interrupt or a message sent\nwhile it waits, or an interrupted end of its run, and the driver maps the provider's own cancel\nanswer to it; `runEnded` is any other end of its run, a restart of the background service\namong them.","type":"string","enum":["canceled","runEnded"]};
/** Checks that a value is a {@link RunRefusalChoiceUnanswered}. */
// prettier-ignore
export const validateRunRefusalChoiceUnanswered: CompiledSchemaCheck<RunRefusalChoiceUnanswered> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is RunRefusalChoiceUnanswered {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateRunRefusalChoiceUnanswered.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateRunRefusalChoiceUnanswered.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data === "canceled") || (data === "runEnded"))){validateRunRefusalChoiceUnanswered.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema500.enum}}];return false;}validateRunRefusalChoiceUnanswered.errors = vErrors;return errors === 0;};
// prettier-ignore
validateRunRefusalChoiceUnanswered.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link RunRefusalChoiceSettlement}. */
// prettier-ignore
export const validateRunRefusalChoiceSettlement: CompiledSchemaCheck<RunRefusalChoiceSettlement> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is RunRefusalChoiceSettlement {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateRunRefusalChoiceSettlement.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(!(validateRunRefusalChoice.call(this, data, {instancePath,parentData,parentDataProperty,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunRefusalChoice.errors : vErrors.concat(validateRunRefusalChoice.errors);errors = vErrors.length;}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;const _errs2: any = errors;if(!(validateRunRefusalChoiceUnanswered.call(this, data, {instancePath,parentData,parentDataProperty,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunRefusalChoiceUnanswered.errors : vErrors.concat(validateRunRefusalChoiceUnanswered.errors);errors = vErrors.length;}var _valid0: any = _errs2 === errors;valid0 = valid0 || _valid0;if(!valid0){const err0: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;validateRunRefusalChoiceSettlement.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validateRunRefusalChoiceSettlement.errors = vErrors;return errors === 0;};
// prettier-ignore
validateRunRefusalChoiceSettlement.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AgentRunRefusalChoiceResolvedPayload}. */
// prettier-ignore
export const validateAgentRunRefusalChoiceResolvedPayload: CompiledSchemaCheck<AgentRunRefusalChoiceResolvedPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentRunRefusalChoiceResolvedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAgentRunRefusalChoiceResolvedPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.runId === undefined) && (missing0 = "runId"))) || ((data.choice === undefined) && (missing0 = "choice"))){validateAgentRunRefusalChoiceResolvedPayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "sessionId") || (key0 === "runId")) || (key0 === "choice")) || (key0 === "deviceId"))){validateAgentRunRefusalChoiceResolvedPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.runId !== undefined){const _errs3: any = errors;if(!(validateRunId.call(this, data.runId, {instancePath:instancePath+"/runId",parentData:data,parentDataProperty:"runId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunId.errors : vErrors.concat(validateRunId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.choice !== undefined){const _errs4: any = errors;if(!(validateRunRefusalChoiceSettlement.call(this, data.choice, {instancePath:instancePath+"/choice",parentData:data,parentDataProperty:"choice",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunRefusalChoiceSettlement.errors : vErrors.concat(validateRunRefusalChoiceSettlement.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.deviceId !== undefined){const _errs5: any = errors;if(!(validateDeviceId.call(this, data.deviceId, {instancePath:instancePath+"/deviceId",parentData:data,parentDataProperty:"deviceId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDeviceId.errors : vErrors.concat(validateDeviceId.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}}}else {validateAgentRunRefusalChoiceResolvedPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAgentRunRefusalChoiceResolvedPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAgentRunRefusalChoiceResolvedPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema504: any = {"description":"The person's answer when a turn's model needs usage credits: `switchDefault` moves the turn to\nthe fallback model, and `consent` goes on on usage credits, which the provider accepts only\nwhile credits are on. The driver translates each value to the provider's own answer.","type":"string","enum":["switchDefault","consent"]};
/** Checks that a value is a {@link RunUsageCreditsChoice}. */
// prettier-ignore
export const validateRunUsageCreditsChoice: CompiledSchemaCheck<RunUsageCreditsChoice> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is RunUsageCreditsChoice {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateRunUsageCreditsChoice.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateRunUsageCreditsChoice.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data === "switchDefault") || (data === "consent"))){validateRunUsageCreditsChoice.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema504.enum}}];return false;}validateRunUsageCreditsChoice.errors = vErrors;return errors === 0;};
// prettier-ignore
validateRunUsageCreditsChoice.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AgentRunUsageCreditsChoiceResolveRequest}. */
// prettier-ignore
export const validateAgentRunUsageCreditsChoiceResolveRequest: CompiledSchemaCheck<AgentRunUsageCreditsChoiceResolveRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentRunUsageCreditsChoiceResolveRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAgentRunUsageCreditsChoiceResolveRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.runId === undefined) && (missing0 = "runId")) || ((data.choice === undefined) && (missing0 = "choice"))){validateAgentRunUsageCreditsChoiceResolveRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "runId") || (key0 === "choice"))){validateAgentRunUsageCreditsChoiceResolveRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.runId !== undefined){const _errs2: any = errors;if(!(validateRunId.call(this, data.runId, {instancePath:instancePath+"/runId",parentData:data,parentDataProperty:"runId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunId.errors : vErrors.concat(validateRunId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.choice !== undefined){const _errs3: any = errors;if(!(validateRunUsageCreditsChoice.call(this, data.choice, {instancePath:instancePath+"/choice",parentData:data,parentDataProperty:"choice",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunUsageCreditsChoice.errors : vErrors.concat(validateRunUsageCreditsChoice.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateAgentRunUsageCreditsChoiceResolveRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAgentRunUsageCreditsChoiceResolveRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAgentRunUsageCreditsChoiceResolveRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AgentRunUsageCreditsChoiceRequestedPayload}. */
// prettier-ignore
export const validateAgentRunUsageCreditsChoiceRequestedPayload: CompiledSchemaCheck<AgentRunUsageCreditsChoiceRequestedPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentRunUsageCreditsChoiceRequestedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAgentRunUsageCreditsChoiceRequestedPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.runId === undefined) && (missing0 = "runId"))) || ((data.modelName === undefined) && (missing0 = "modelName"))) || ((data.overagesEnabled === undefined) && (missing0 = "overagesEnabled"))){validateAgentRunUsageCreditsChoiceRequestedPayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((((key0 === "sessionId") || (key0 === "runId")) || (key0 === "modelName")) || (key0 === "overagesEnabled")) || (key0 === "balanceCents")) || (key0 === "currency")) || (key0 === "fallbackModel"))){validateAgentRunUsageCreditsChoiceRequestedPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.runId !== undefined){const _errs3: any = errors;if(!(validateRunId.call(this, data.runId, {instancePath:instancePath+"/runId",parentData:data,parentDataProperty:"runId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunId.errors : vErrors.concat(validateRunId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.modelName !== undefined){let data2: any = data.modelName;const _errs4: any = errors;if(errors === _errs4){if(typeof data2 === "string"){if(func1(data2) > 256){validateAgentRunUsageCreditsChoiceRequestedPayload.errors = [{instancePath:instancePath+"/modelName",schemaPath:"#/properties/modelName/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data2) < 1){validateAgentRunUsageCreditsChoiceRequestedPayload.errors = [{instancePath:instancePath+"/modelName",schemaPath:"#/properties/modelName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data2)){validateAgentRunUsageCreditsChoiceRequestedPayload.errors = [{instancePath:instancePath+"/modelName",schemaPath:"#/properties/modelName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateAgentRunUsageCreditsChoiceRequestedPayload.errors = [{instancePath:instancePath+"/modelName",schemaPath:"#/properties/modelName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.overagesEnabled !== undefined){const _errs6: any = errors;if(typeof data.overagesEnabled !== "boolean"){validateAgentRunUsageCreditsChoiceRequestedPayload.errors = [{instancePath:instancePath+"/overagesEnabled",schemaPath:"#/properties/overagesEnabled/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.balanceCents !== undefined){let data4: any = data.balanceCents;const _errs8: any = errors;if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){validateAgentRunUsageCreditsChoiceRequestedPayload.errors = [{instancePath:instancePath+"/balanceCents",schemaPath:"#/properties/balanceCents/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs8){if((typeof data4 == "number") && (isFinite(data4))){if(data4 > 9007199254740991 || isNaN(data4)){validateAgentRunUsageCreditsChoiceRequestedPayload.errors = [{instancePath:instancePath+"/balanceCents",schemaPath:"#/properties/balanceCents/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data4 < -9007199254740991 || isNaN(data4)){validateAgentRunUsageCreditsChoiceRequestedPayload.errors = [{instancePath:instancePath+"/balanceCents",schemaPath:"#/properties/balanceCents/minimum",keyword:"minimum",params:{comparison: ">=", limit: -9007199254740991}}];return false;}}}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.currency !== undefined){let data5: any = data.currency;const _errs10: any = errors;if(errors === _errs10){if(typeof data5 === "string"){if(func1(data5) > 256){validateAgentRunUsageCreditsChoiceRequestedPayload.errors = [{instancePath:instancePath+"/currency",schemaPath:"#/properties/currency/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data5) < 1){validateAgentRunUsageCreditsChoiceRequestedPayload.errors = [{instancePath:instancePath+"/currency",schemaPath:"#/properties/currency/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data5)){validateAgentRunUsageCreditsChoiceRequestedPayload.errors = [{instancePath:instancePath+"/currency",schemaPath:"#/properties/currency/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateAgentRunUsageCreditsChoiceRequestedPayload.errors = [{instancePath:instancePath+"/currency",schemaPath:"#/properties/currency/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.fallbackModel !== undefined){let data6: any = data.fallbackModel;const _errs12: any = errors;if(errors === _errs12){if(typeof data6 === "string"){if(func1(data6) > 256){validateAgentRunUsageCreditsChoiceRequestedPayload.errors = [{instancePath:instancePath+"/fallbackModel",schemaPath:"#/properties/fallbackModel/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data6) < 1){validateAgentRunUsageCreditsChoiceRequestedPayload.errors = [{instancePath:instancePath+"/fallbackModel",schemaPath:"#/properties/fallbackModel/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data6)){validateAgentRunUsageCreditsChoiceRequestedPayload.errors = [{instancePath:instancePath+"/fallbackModel",schemaPath:"#/properties/fallbackModel/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateAgentRunUsageCreditsChoiceRequestedPayload.errors = [{instancePath:instancePath+"/fallbackModel",schemaPath:"#/properties/fallbackModel/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}}}}}}}}}}else {validateAgentRunUsageCreditsChoiceRequestedPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAgentRunUsageCreditsChoiceRequestedPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAgentRunUsageCreditsChoiceRequestedPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema505: any = {"description":"How the switch-or-credits choice ended with no answer: `interrupted` is an interrupt or an\nundo while it waits, which ends the turn on that model, or an interrupted end of its run;\n`unanswered` is the provider settling it when a message is sent while it waits; `runEnded` is\nany other end of its run, a restart of the background service among them.","type":"string","enum":["interrupted","unanswered","runEnded"]};
/** Checks that a value is a {@link RunUsageCreditsChoiceUnanswered}. */
// prettier-ignore
export const validateRunUsageCreditsChoiceUnanswered: CompiledSchemaCheck<RunUsageCreditsChoiceUnanswered> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is RunUsageCreditsChoiceUnanswered {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateRunUsageCreditsChoiceUnanswered.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateRunUsageCreditsChoiceUnanswered.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data === "interrupted") || (data === "unanswered")) || (data === "runEnded"))){validateRunUsageCreditsChoiceUnanswered.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema505.enum}}];return false;}validateRunUsageCreditsChoiceUnanswered.errors = vErrors;return errors === 0;};
// prettier-ignore
validateRunUsageCreditsChoiceUnanswered.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link RunUsageCreditsChoiceSettlement}. */
// prettier-ignore
export const validateRunUsageCreditsChoiceSettlement: CompiledSchemaCheck<RunUsageCreditsChoiceSettlement> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is RunUsageCreditsChoiceSettlement {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateRunUsageCreditsChoiceSettlement.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(!(validateRunUsageCreditsChoice.call(this, data, {instancePath,parentData,parentDataProperty,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunUsageCreditsChoice.errors : vErrors.concat(validateRunUsageCreditsChoice.errors);errors = vErrors.length;}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;const _errs2: any = errors;if(!(validateRunUsageCreditsChoiceUnanswered.call(this, data, {instancePath,parentData,parentDataProperty,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunUsageCreditsChoiceUnanswered.errors : vErrors.concat(validateRunUsageCreditsChoiceUnanswered.errors);errors = vErrors.length;}var _valid0: any = _errs2 === errors;valid0 = valid0 || _valid0;if(!valid0){const err0: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;validateRunUsageCreditsChoiceSettlement.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validateRunUsageCreditsChoiceSettlement.errors = vErrors;return errors === 0;};
// prettier-ignore
validateRunUsageCreditsChoiceSettlement.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AgentRunUsageCreditsChoiceResolvedPayload}. */
// prettier-ignore
export const validateAgentRunUsageCreditsChoiceResolvedPayload: CompiledSchemaCheck<AgentRunUsageCreditsChoiceResolvedPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentRunUsageCreditsChoiceResolvedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAgentRunUsageCreditsChoiceResolvedPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.runId === undefined) && (missing0 = "runId"))) || ((data.choice === undefined) && (missing0 = "choice"))){validateAgentRunUsageCreditsChoiceResolvedPayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "sessionId") || (key0 === "runId")) || (key0 === "choice")) || (key0 === "deviceId"))){validateAgentRunUsageCreditsChoiceResolvedPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.runId !== undefined){const _errs3: any = errors;if(!(validateRunId.call(this, data.runId, {instancePath:instancePath+"/runId",parentData:data,parentDataProperty:"runId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunId.errors : vErrors.concat(validateRunId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.choice !== undefined){const _errs4: any = errors;if(!(validateRunUsageCreditsChoiceSettlement.call(this, data.choice, {instancePath:instancePath+"/choice",parentData:data,parentDataProperty:"choice",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunUsageCreditsChoiceSettlement.errors : vErrors.concat(validateRunUsageCreditsChoiceSettlement.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.deviceId !== undefined){const _errs5: any = errors;if(!(validateDeviceId.call(this, data.deviceId, {instancePath:instancePath+"/deviceId",parentData:data,parentDataProperty:"deviceId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDeviceId.errors : vErrors.concat(validateDeviceId.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}}}else {validateAgentRunUsageCreditsChoiceResolvedPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAgentRunUsageCreditsChoiceResolvedPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAgentRunUsageCreditsChoiceResolvedPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
