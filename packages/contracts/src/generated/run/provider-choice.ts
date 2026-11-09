/* eslint-disable */
// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The choices a provider asks the person to make while a run waits on the answer: the retry-or-edit choice after a refusal and the switch-or-credits choice when a model needs usage credits.

import { type SchemaCheck, ucs2length } from "../../schema-check.js";
import type { SessionId } from "../session/id.js";
import type { DeviceId } from "../trust-statement.js";
import type { RunId } from "./id.js";

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
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
function validate1758(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentRunRefusalChoiceRequestedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1758.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.runId === undefined) && (missing0 = "runId"))) || ((data.refusedModel === undefined) && (missing0 = "refusedModel"))) || ((data.fallbackModel === undefined) && (missing0 = "fallbackModel"))){validate1758.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((((key0 === "sessionId") || (key0 === "runId")) || (key0 === "refusedModel")) || (key0 === "fallbackModel")) || (key0 === "sentence")) || (key0 === "safetyCategory")) || (key0 === "retractedMessageIds"))){validate1758.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1758.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1758.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.runId !== undefined){let data1: any = data.runId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate1758.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1758.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.refusedModel !== undefined){let data2: any = data.refusedModel;const _errs10: any = errors;if(errors === _errs10){if(typeof data2 === "string"){if(func1(data2) > 256){validate1758.errors = [{instancePath:instancePath+"/refusedModel",schemaPath:"#/properties/refusedModel/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data2) < 1){validate1758.errors = [{instancePath:instancePath+"/refusedModel",schemaPath:"#/properties/refusedModel/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data2)){validate1758.errors = [{instancePath:instancePath+"/refusedModel",schemaPath:"#/properties/refusedModel/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1758.errors = [{instancePath:instancePath+"/refusedModel",schemaPath:"#/properties/refusedModel/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.fallbackModel !== undefined){let data3: any = data.fallbackModel;const _errs12: any = errors;if(errors === _errs12){if(typeof data3 === "string"){if(func1(data3) > 256){validate1758.errors = [{instancePath:instancePath+"/fallbackModel",schemaPath:"#/properties/fallbackModel/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data3) < 1){validate1758.errors = [{instancePath:instancePath+"/fallbackModel",schemaPath:"#/properties/fallbackModel/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data3)){validate1758.errors = [{instancePath:instancePath+"/fallbackModel",schemaPath:"#/properties/fallbackModel/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1758.errors = [{instancePath:instancePath+"/fallbackModel",schemaPath:"#/properties/fallbackModel/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.sentence !== undefined){let data4: any = data.sentence;const _errs14: any = errors;if(errors === _errs14){if(typeof data4 === "string"){if(func1(data4) > 32768){validate1758.errors = [{instancePath:instancePath+"/sentence",schemaPath:"#/properties/sentence/maxLength",keyword:"maxLength",params:{limit: 32768}}];return false;}else {if(func1(data4) < 1){validate1758.errors = [{instancePath:instancePath+"/sentence",schemaPath:"#/properties/sentence/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data4)){validate1758.errors = [{instancePath:instancePath+"/sentence",schemaPath:"#/properties/sentence/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1758.errors = [{instancePath:instancePath+"/sentence",schemaPath:"#/properties/sentence/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}if(valid0){if(data.safetyCategory !== undefined){let data5: any = data.safetyCategory;const _errs16: any = errors;if(errors === _errs16){if(typeof data5 === "string"){if(func1(data5) > 256){validate1758.errors = [{instancePath:instancePath+"/safetyCategory",schemaPath:"#/properties/safetyCategory/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data5) < 1){validate1758.errors = [{instancePath:instancePath+"/safetyCategory",schemaPath:"#/properties/safetyCategory/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data5)){validate1758.errors = [{instancePath:instancePath+"/safetyCategory",schemaPath:"#/properties/safetyCategory/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1758.errors = [{instancePath:instancePath+"/safetyCategory",schemaPath:"#/properties/safetyCategory/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs16 === errors;}else {var valid0: any = true;}if(valid0){if(data.retractedMessageIds !== undefined){let data6: any = data.retractedMessageIds;const _errs18: any = errors;if(errors === _errs18){if(Array.isArray(data6)){var valid3: any = true;const len0: any = data6.length;for(let i0=0; i0<len0; i0++){let data7: any = data6[i0];const _errs20: any = errors;if(errors === _errs20){if(typeof data7 === "string"){if(func1(data7) > 256){validate1758.errors = [{instancePath:instancePath+"/retractedMessageIds/" + i0,schemaPath:"#/properties/retractedMessageIds/items/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data7) < 1){validate1758.errors = [{instancePath:instancePath+"/retractedMessageIds/" + i0,schemaPath:"#/properties/retractedMessageIds/items/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data7)){validate1758.errors = [{instancePath:instancePath+"/retractedMessageIds/" + i0,schemaPath:"#/properties/retractedMessageIds/items/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1758.errors = [{instancePath:instancePath+"/retractedMessageIds/" + i0,schemaPath:"#/properties/retractedMessageIds/items/type",keyword:"type",params:{type: "string"}}];return false;}}var valid3: any = _errs20 === errors;if(!valid3){break;}}}else {validate1758.errors = [{instancePath:instancePath+"/retractedMessageIds",schemaPath:"#/properties/retractedMessageIds/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs18 === errors;}else {var valid0: any = true;}}}}}}}}}}else {validate1758.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1758.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1758.errors = null as any[] | null;
// prettier-ignore
validate1758.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1313: any = {"description":"The person's answer when the provider's safety check refuses a turn and names a fallback model:\n`retryFallback` goes on on the fallback model, and `editPrompt` ends the turn refused and\nreturns the message to the composer. The driver translates each value to the provider's own\nanswer.","type":"string","enum":["retryFallback","editPrompt"]};
// prettier-ignore
function validate1759(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentRunRefusalChoiceResolveRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1759.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.runId === undefined) && (missing0 = "runId")) || ((data.choice === undefined) && (missing0 = "choice"))){validate1759.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "runId") || (key0 === "choice"))){validate1759.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.runId !== undefined){let data0: any = data.runId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1759.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1759.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.choice !== undefined){let data1: any = data.choice;const _errs6: any = errors;if(typeof data1 !== "string"){validate1759.errors = [{instancePath:instancePath+"/choice",schemaPath:"#/$defs/RunRefusalChoice/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data1 === "retryFallback") || (data1 === "editPrompt"))){validate1759.errors = [{instancePath:instancePath+"/choice",schemaPath:"#/$defs/RunRefusalChoice/enum",keyword:"enum",params:{allowedValues: schema1313.enum}}];return false;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1759.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1759.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1759.errors = null as any[] | null;
// prettier-ignore
validate1759.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1314: any = {"description":"How the retry-or-edit choice ended with no answer: `canceled` is an interrupt or a message sent\nwhile it waits, or an interrupted end of its run, and the driver maps the provider's own cancel\nanswer to it; `runEnded` is any other end of its run, a restart of the background service\namong them.","type":"string","enum":["canceled","runEnded"]};
// prettier-ignore
function validate700(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate700.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(typeof data !== "string"){const err0: any = {instancePath,schemaPath:"#/$defs/RunRefusalChoice/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}if(!((data === "retryFallback") || (data === "editPrompt"))){const err1: any = {instancePath,schemaPath:"#/$defs/RunRefusalChoice/enum",keyword:"enum",params:{allowedValues: schema1313.enum}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;const _errs4: any = errors;if(typeof data !== "string"){const err2: any = {instancePath,schemaPath:"#/$defs/RunRefusalChoiceUnanswered/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}if(!((data === "canceled") || (data === "runEnded"))){const err3: any = {instancePath,schemaPath:"#/$defs/RunRefusalChoiceUnanswered/enum",keyword:"enum",params:{allowedValues: schema1314.enum}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}var _valid0: any = _errs4 === errors;valid0 = valid0 || _valid0;if(!valid0){const err4: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;validate700.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validate700.errors = vErrors;return errors === 0;}
// prettier-ignore
validate700.errors = null as any[] | null;
// prettier-ignore
validate700.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1760(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentRunRefusalChoiceResolvedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1760.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.runId === undefined) && (missing0 = "runId"))) || ((data.choice === undefined) && (missing0 = "choice"))){validate1760.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "sessionId") || (key0 === "runId")) || (key0 === "choice")) || (key0 === "deviceId"))){validate1760.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1760.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1760.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.runId !== undefined){let data1: any = data.runId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate1760.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1760.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.choice !== undefined){const _errs10: any = errors;if(!(validate700.call(this, data.choice, {instancePath:instancePath+"/choice",parentData:data,parentDataProperty:"choice",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate700.errors : vErrors.concat(validate700.errors);errors = vErrors.length;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.deviceId !== undefined){let data3: any = data.deviceId;const _errs11: any = errors;const _errs12: any = errors;if(errors === _errs12){if(typeof data3 === "string"){if(func1(data3) > 256){validate1760.errors = [{instancePath:instancePath+"/deviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(!pattern6.test(data3)){validate1760.errors = [{instancePath:instancePath+"/deviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate1760.errors = [{instancePath:instancePath+"/deviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs11 === errors;}else {var valid0: any = true;}}}}}}}else {validate1760.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1760.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1760.errors = null as any[] | null;
// prettier-ignore
validate1760.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1762(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentRunUsageCreditsChoiceRequestedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1762.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.runId === undefined) && (missing0 = "runId"))) || ((data.modelName === undefined) && (missing0 = "modelName"))) || ((data.overagesEnabled === undefined) && (missing0 = "overagesEnabled"))){validate1762.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((((key0 === "sessionId") || (key0 === "runId")) || (key0 === "modelName")) || (key0 === "overagesEnabled")) || (key0 === "balanceCents")) || (key0 === "currency")) || (key0 === "fallbackModel"))){validate1762.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1762.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1762.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.runId !== undefined){let data1: any = data.runId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate1762.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1762.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.modelName !== undefined){let data2: any = data.modelName;const _errs10: any = errors;if(errors === _errs10){if(typeof data2 === "string"){if(func1(data2) > 256){validate1762.errors = [{instancePath:instancePath+"/modelName",schemaPath:"#/properties/modelName/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data2) < 1){validate1762.errors = [{instancePath:instancePath+"/modelName",schemaPath:"#/properties/modelName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data2)){validate1762.errors = [{instancePath:instancePath+"/modelName",schemaPath:"#/properties/modelName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1762.errors = [{instancePath:instancePath+"/modelName",schemaPath:"#/properties/modelName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.overagesEnabled !== undefined){const _errs12: any = errors;if(typeof data.overagesEnabled !== "boolean"){validate1762.errors = [{instancePath:instancePath+"/overagesEnabled",schemaPath:"#/properties/overagesEnabled/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.balanceCents !== undefined){let data4: any = data.balanceCents;const _errs14: any = errors;if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){validate1762.errors = [{instancePath:instancePath+"/balanceCents",schemaPath:"#/properties/balanceCents/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs14){if((typeof data4 == "number") && (isFinite(data4))){if(data4 > 9007199254740991 || isNaN(data4)){validate1762.errors = [{instancePath:instancePath+"/balanceCents",schemaPath:"#/properties/balanceCents/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data4 < -9007199254740991 || isNaN(data4)){validate1762.errors = [{instancePath:instancePath+"/balanceCents",schemaPath:"#/properties/balanceCents/minimum",keyword:"minimum",params:{comparison: ">=", limit: -9007199254740991}}];return false;}}}}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}if(valid0){if(data.currency !== undefined){let data5: any = data.currency;const _errs16: any = errors;if(errors === _errs16){if(typeof data5 === "string"){if(func1(data5) > 256){validate1762.errors = [{instancePath:instancePath+"/currency",schemaPath:"#/properties/currency/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data5) < 1){validate1762.errors = [{instancePath:instancePath+"/currency",schemaPath:"#/properties/currency/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data5)){validate1762.errors = [{instancePath:instancePath+"/currency",schemaPath:"#/properties/currency/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1762.errors = [{instancePath:instancePath+"/currency",schemaPath:"#/properties/currency/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs16 === errors;}else {var valid0: any = true;}if(valid0){if(data.fallbackModel !== undefined){let data6: any = data.fallbackModel;const _errs18: any = errors;if(errors === _errs18){if(typeof data6 === "string"){if(func1(data6) > 256){validate1762.errors = [{instancePath:instancePath+"/fallbackModel",schemaPath:"#/properties/fallbackModel/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data6) < 1){validate1762.errors = [{instancePath:instancePath+"/fallbackModel",schemaPath:"#/properties/fallbackModel/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data6)){validate1762.errors = [{instancePath:instancePath+"/fallbackModel",schemaPath:"#/properties/fallbackModel/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1762.errors = [{instancePath:instancePath+"/fallbackModel",schemaPath:"#/properties/fallbackModel/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs18 === errors;}else {var valid0: any = true;}}}}}}}}}}else {validate1762.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1762.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1762.errors = null as any[] | null;
// prettier-ignore
validate1762.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1323: any = {"description":"The person's answer when a turn's model needs usage credits: `switchDefault` moves the turn to\nthe fallback model, and `consent` goes on on usage credits, which the provider accepts only\nwhile credits are on. The driver translates each value to the provider's own answer.","type":"string","enum":["switchDefault","consent"]};
// prettier-ignore
function validate1763(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentRunUsageCreditsChoiceResolveRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1763.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.runId === undefined) && (missing0 = "runId")) || ((data.choice === undefined) && (missing0 = "choice"))){validate1763.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "runId") || (key0 === "choice"))){validate1763.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.runId !== undefined){let data0: any = data.runId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1763.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1763.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.choice !== undefined){let data1: any = data.choice;const _errs6: any = errors;if(typeof data1 !== "string"){validate1763.errors = [{instancePath:instancePath+"/choice",schemaPath:"#/$defs/RunUsageCreditsChoice/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data1 === "switchDefault") || (data1 === "consent"))){validate1763.errors = [{instancePath:instancePath+"/choice",schemaPath:"#/$defs/RunUsageCreditsChoice/enum",keyword:"enum",params:{allowedValues: schema1323.enum}}];return false;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1763.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1763.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1763.errors = null as any[] | null;
// prettier-ignore
validate1763.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1324: any = {"description":"How the switch-or-credits choice ended with no answer: `interrupted` is an interrupt or an\nundo while it waits, which ends the turn on that model, or an interrupted end of its run;\n`unanswered` is the provider settling it when a message is sent while it waits; `runEnded` is\nany other end of its run, a restart of the background service among them.","type":"string","enum":["interrupted","unanswered","runEnded"]};
// prettier-ignore
function validate706(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate706.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(typeof data !== "string"){const err0: any = {instancePath,schemaPath:"#/$defs/RunUsageCreditsChoice/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}if(!((data === "switchDefault") || (data === "consent"))){const err1: any = {instancePath,schemaPath:"#/$defs/RunUsageCreditsChoice/enum",keyword:"enum",params:{allowedValues: schema1323.enum}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;const _errs4: any = errors;if(typeof data !== "string"){const err2: any = {instancePath,schemaPath:"#/$defs/RunUsageCreditsChoiceUnanswered/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}if(!(((data === "interrupted") || (data === "unanswered")) || (data === "runEnded"))){const err3: any = {instancePath,schemaPath:"#/$defs/RunUsageCreditsChoiceUnanswered/enum",keyword:"enum",params:{allowedValues: schema1324.enum}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}var _valid0: any = _errs4 === errors;valid0 = valid0 || _valid0;if(!valid0){const err4: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;validate706.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validate706.errors = vErrors;return errors === 0;}
// prettier-ignore
validate706.errors = null as any[] | null;
// prettier-ignore
validate706.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1764(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentRunUsageCreditsChoiceResolvedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1764.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.runId === undefined) && (missing0 = "runId"))) || ((data.choice === undefined) && (missing0 = "choice"))){validate1764.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "sessionId") || (key0 === "runId")) || (key0 === "choice")) || (key0 === "deviceId"))){validate1764.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1764.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1764.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.runId !== undefined){let data1: any = data.runId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate1764.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1764.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.choice !== undefined){const _errs10: any = errors;if(!(validate706.call(this, data.choice, {instancePath:instancePath+"/choice",parentData:data,parentDataProperty:"choice",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate706.errors : vErrors.concat(validate706.errors);errors = vErrors.length;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.deviceId !== undefined){let data3: any = data.deviceId;const _errs11: any = errors;const _errs12: any = errors;if(errors === _errs12){if(typeof data3 === "string"){if(func1(data3) > 256){validate1764.errors = [{instancePath:instancePath+"/deviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(!pattern6.test(data3)){validate1764.errors = [{instancePath:instancePath+"/deviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate1764.errors = [{instancePath:instancePath+"/deviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs11 === errors;}else {var valid0: any = true;}}}}}}}else {validate1764.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1764.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1764.errors = null as any[] | null;
// prettier-ignore
validate1764.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AgentRunRefusalChoiceRequestedPayload}. */
export const validateAgentRunRefusalChoiceRequestedPayload: SchemaCheck<AgentRunRefusalChoiceRequestedPayload> =
  validate1758;
/** Checks that a value is a {@link AgentRunRefusalChoiceResolveRequest}. */
export const validateAgentRunRefusalChoiceResolveRequest: SchemaCheck<AgentRunRefusalChoiceResolveRequest> =
  validate1759;
/** Checks that a value is a {@link AgentRunRefusalChoiceResolvedPayload}. */
export const validateAgentRunRefusalChoiceResolvedPayload: SchemaCheck<AgentRunRefusalChoiceResolvedPayload> =
  validate1760;
/** Checks that a value is a {@link AgentRunUsageCreditsChoiceRequestedPayload}. */
export const validateAgentRunUsageCreditsChoiceRequestedPayload: SchemaCheck<AgentRunUsageCreditsChoiceRequestedPayload> =
  validate1762;
/** Checks that a value is a {@link AgentRunUsageCreditsChoiceResolveRequest}. */
export const validateAgentRunUsageCreditsChoiceResolveRequest: SchemaCheck<AgentRunUsageCreditsChoiceResolveRequest> =
  validate1763;
/** Checks that a value is a {@link AgentRunUsageCreditsChoiceResolvedPayload}. */
export const validateAgentRunUsageCreditsChoiceResolvedPayload: SchemaCheck<AgentRunUsageCreditsChoiceResolvedPayload> =
  validate1764;
