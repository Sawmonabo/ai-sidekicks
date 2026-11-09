/* eslint-disable */
// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A session's spend: the committed figure and each agent's share of it, and the cost receipt the inspector reads by provider and account, all in whole micro-dollars.

import { type SchemaCheck, ucs2length } from "../../schema-check.js";
import type { AgentTreeMember } from "../agent/tree.js";
import type { BillingMode, ProviderAccountId } from "../provider/account/record.js";
import type { ProviderId } from "../provider/id.js";
import type { SessionId } from "./id.js";

/**
 * A cost in whole micro-dollars, the one money unit on the wire.
 */
export type UsdMicros = number;
/**
 * A `Tokens per run` limit: input and output tokens together, for one run; at least one.
 */
export type TokensPerRun = number;

/**
 * One agent's spend in the session's tree, the lead included: `ownUsdMicros` is what its own
 * requests cost, and `subtreeUsdMicros` that plus every descendant's at any depth. A helper
 * request, such as a reviewer's, counts on the agent it belongs to.
 */
export interface AgentSpend {
  /**
   * The agent.
   */
  agent: AgentTreeMember;
  /**
   * What the agent's own requests cost.
   */
  ownUsdMicros: UsdMicros;
  /**
   * The agent's own spend plus every descendant's; never less than its own.
   */
  subtreeUsdMicros: UsdMicros;
}
/**
 * The session's two limits, its committed spend and each agent's share of it. A limit of `null`
 * is `Unlimited`. The committed figure is the one session cost every screen shows, never a sum a
 * client takes over the rows it holds.
 */
export interface SessionBudgetState {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The spend limit, or `null` for `Unlimited`.
   */
  spendLimitUsdMicros: UsdMicros | null;
  /**
   * The `Tokens per run` limit, or `null` for `Unlimited`.
   */
  tokensPerRun: TokensPerRun | null;
  /**
   * The session's committed spend.
   */
  committedSpendUsdMicros: UsdMicros;
  /**
   * Each agent's spend.
   */
  agentSpend: AgentSpend[];
}
/**
 * The session whose spend `session.budget.read` answers with.
 */
export interface SessionBudgetReadRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
}
/**
 * The session whose cost receipt `session.costReceipt.read` answers with.
 */
export interface SessionCostReceiptReadRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
}
/**
 * One provider account's spend: its tokens and its dollars. `billingMode` labels the figure and
 * never changes how it is derived; `unknown` is never presented as billed dollars.
 */
export interface SessionCostReceiptAccountRow {
  /**
   * The account.
   */
  providerAccountId: ProviderAccountId;
  /**
   * How the account is charged.
   */
  billingMode: BillingMode;
  /**
   * The tokens the session spent on the account.
   */
  tokens: number;
  /**
   * What those tokens cost.
   */
  usdMicros: UsdMicros;
}
/**
 * A provider's voice calls: their length and their cost at the voice model's price.
 */
export interface SessionCostReceiptVoiceRow {
  /**
   * How long the calls ran, in seconds.
   */
  seconds: number;
  /**
   * What the calls cost.
   */
  usdMicros: UsdMicros;
}
/**
 * One provider the session spent on: a row per account it spent on, its voice row where the
 * session made voice calls on it, and a subtotal the daemon computes.
 */
export interface SessionCostReceiptProvider {
  /**
   * The provider.
   */
  providerName: ProviderId;
  /**
   * A row per account the session spent on.
   */
  accounts: SessionCostReceiptAccountRow[];
  /**
   * The provider's voice calls, where the session made any.
   */
  voice?: SessionCostReceiptVoiceRow;
  /**
   * The provider's subtotal.
   */
  subtotalUsdMicros: UsdMicros;
}
/**
 * The session's spend, decomposed by provider and account, beside the committed figure it adds up
 * to. Providers are in the order the session first spent on them, the session's own provider
 * first; a session that has spent nothing has none.
 */
export interface SessionCostReceipt {
  /**
   * The session's committed spend and limits.
   */
  sessionTotal: SessionBudgetState;
  /**
   * The providers the session spent on.
   */
  providers: SessionCostReceiptProvider[];
}

// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
function validate131(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate131.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs2: any = errors;for(const key0 in data){validate131.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key0}}];return false;break;}if(_errs2 === errors){const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "agent"){const _errs3: any = errors;if(errors === _errs3){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.kind === undefined) && (missing0 = "kind")) || ((data.agentId === undefined) && (missing0 = "agentId"))){validate131.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs5: any = errors;for(const key1 in data){if(!((key1 === "kind") || (key1 === "agentId"))){validate131.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs5 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs6: any = errors;if(typeof data0 !== "string"){validate131.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("agent" !== data0){validate131.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "agent"}}];return false;}var valid2: any = _errs6 === errors;}else {var valid2: any = true;}if(valid2){if(data.agentId !== undefined){let data1: any = data.agentId;const _errs8: any = errors;const _errs9: any = errors;if(errors === _errs9){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate131.errors = [{instancePath:instancePath+"/agentId",schemaPath:"sidekicks-contracts:agent/definition#/$defs/AgentId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate131.errors = [{instancePath:instancePath+"/agentId",schemaPath:"sidekicks-contracts:agent/definition#/$defs/AgentId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}}}}}else {validate131.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "providerChild"){const _errs12: any = errors;if(errors === _errs12){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((data.kind === undefined) && (missing1 = "kind")) || ((data.runId === undefined) && (missing1 = "runId"))) || ((data.childHandle === undefined) && (missing1 = "childHandle"))){validate131.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs14: any = errors;for(const key2 in data){if(!(((key2 === "kind") || (key2 === "runId")) || (key2 === "childHandle"))){validate131.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs14 === errors){if(data.kind !== undefined){let data2: any = data.kind;const _errs15: any = errors;if(typeof data2 !== "string"){validate131.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("providerChild" !== data2){validate131.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "providerChild"}}];return false;}var valid5: any = _errs15 === errors;}else {var valid5: any = true;}if(valid5){if(data.runId !== undefined){let data3: any = data.runId;const _errs17: any = errors;const _errs18: any = errors;if(errors === _errs18){if(typeof data3 === "string"){if(!pattern4.test(data3)){validate131.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate131.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs17 === errors;}else {var valid5: any = true;}if(valid5){if(data.childHandle !== undefined){let data4: any = data.childHandle;const _errs21: any = errors;const _errs22: any = errors;if(errors === _errs22){if(typeof data4 === "string"){if(func1(data4) > 256){validate131.errors = [{instancePath:instancePath+"/childHandle",schemaPath:"#/$defs/ChildHandle/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data4) < 1){validate131.errors = [{instancePath:instancePath+"/childHandle",schemaPath:"#/$defs/ChildHandle/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate131.errors = [{instancePath:instancePath+"/childHandle",schemaPath:"#/$defs/ChildHandle/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs21 === errors;}else {var valid5: any = true;}}}}}}else {validate131.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}}else {validate131.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validate131.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}}}else {validate131.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate131.errors = vErrors;return errors === 0;}
// prettier-ignore
validate131.errors = null as any[] | null;
// prettier-ignore
validate131.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1866(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentSpend {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1866.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.agent === undefined) && (missing0 = "agent")) || ((data.ownUsdMicros === undefined) && (missing0 = "ownUsdMicros"))) || ((data.subtreeUsdMicros === undefined) && (missing0 = "subtreeUsdMicros"))){validate1866.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "agent") || (key0 === "ownUsdMicros")) || (key0 === "subtreeUsdMicros"))){validate1866.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.agent !== undefined){const _errs2: any = errors;if(!(validate131.call(this, data.agent, {instancePath:instancePath+"/agent",parentData:data,parentDataProperty:"agent",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate131.errors : vErrors.concat(validate131.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.ownUsdMicros !== undefined){let data1: any = data.ownUsdMicros;const _errs3: any = errors;const _errs4: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validate1866.errors = [{instancePath:instancePath+"/ownUsdMicros",schemaPath:"#/$defs/UsdMicros/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs4){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validate1866.errors = [{instancePath:instancePath+"/ownUsdMicros",schemaPath:"#/$defs/UsdMicros/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 0 || isNaN(data1)){validate1866.errors = [{instancePath:instancePath+"/ownUsdMicros",schemaPath:"#/$defs/UsdMicros/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.subtreeUsdMicros !== undefined){let data2: any = data.subtreeUsdMicros;const _errs6: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validate1866.errors = [{instancePath:instancePath+"/subtreeUsdMicros",schemaPath:"#/properties/subtreeUsdMicros/type",keyword:"type",params:{type: "integer"}}];return false;}const _errs7: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validate1866.errors = [{instancePath:instancePath+"/subtreeUsdMicros",schemaPath:"#/$defs/UsdMicros/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs7){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validate1866.errors = [{instancePath:instancePath+"/subtreeUsdMicros",schemaPath:"#/$defs/UsdMicros/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 0 || isNaN(data2)){validate1866.errors = [{instancePath:instancePath+"/subtreeUsdMicros",schemaPath:"#/$defs/UsdMicros/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}if(errors === _errs6){if((typeof data2 == "number") && (isFinite(data2))){const vSchema0: any = data && data.ownUsdMicros;if(vSchema0 !== undefined && ((!((typeof vSchema0 == "number") && (isFinite(vSchema0)))) || (data2 < vSchema0 || isNaN(data2)))){validate1866.errors = [{instancePath:instancePath+"/subtreeUsdMicros",schemaPath:"#/properties/subtreeUsdMicros/minimum",keyword:"minimum",params:{comparison: ">=", limit: vSchema0}}];return false;}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}else {validate1866.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1866.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1866.errors = null as any[] | null;
// prettier-ignore
validate1866.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1868(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionBudgetReadRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1868.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validate1868.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "sessionId")){validate1868.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1868.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1868.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate1868.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1868.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1868.errors = null as any[] | null;
// prettier-ignore
validate1868.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1869(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionBudgetState {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1869.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.spendLimitUsdMicros === undefined) && (missing0 = "spendLimitUsdMicros"))) || ((data.tokensPerRun === undefined) && (missing0 = "tokensPerRun"))) || ((data.committedSpendUsdMicros === undefined) && (missing0 = "committedSpendUsdMicros"))) || ((data.agentSpend === undefined) && (missing0 = "agentSpend"))){validate1869.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "sessionId") || (key0 === "spendLimitUsdMicros")) || (key0 === "tokensPerRun")) || (key0 === "committedSpendUsdMicros")) || (key0 === "agentSpend"))){validate1869.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1869.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1869.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.spendLimitUsdMicros !== undefined){let data1: any = data.spendLimitUsdMicros;const _errs6: any = errors;const _errs7: any = errors;let valid2: any = false;const _errs8: any = errors;const _errs9: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){const err0: any = {instancePath:instancePath+"/spendLimitUsdMicros",schemaPath:"#/$defs/UsdMicros/type",keyword:"type",params:{type: "integer"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}if(errors === _errs9){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){const err1: any = {instancePath:instancePath+"/spendLimitUsdMicros",schemaPath:"#/$defs/UsdMicros/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}else {if(data1 < 0 || isNaN(data1)){const err2: any = {instancePath:instancePath+"/spendLimitUsdMicros",schemaPath:"#/$defs/UsdMicros/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}}}}var _valid0: any = _errs8 === errors;valid2 = valid2 || _valid0;const _errs11: any = errors;if(data1 !== null){const err3: any = {instancePath:instancePath+"/spendLimitUsdMicros",schemaPath:"#/properties/spendLimitUsdMicros/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}var _valid0: any = _errs11 === errors;valid2 = valid2 || _valid0;if(!valid2){const err4: any = {instancePath:instancePath+"/spendLimitUsdMicros",schemaPath:"#/properties/spendLimitUsdMicros/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;validate1869.errors = vErrors;return false;}else {errors = _errs7;if(vErrors !== null){if(_errs7){vErrors.length = _errs7;}else {vErrors = null;}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.tokensPerRun !== undefined){let data2: any = data.tokensPerRun;const _errs13: any = errors;const _errs14: any = errors;let valid4: any = false;const _errs15: any = errors;const _errs16: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){const err5: any = {instancePath:instancePath+"/tokensPerRun",schemaPath:"#/$defs/TokensPerRun/type",keyword:"type",params:{type: "integer"}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}if(errors === _errs16){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){const err6: any = {instancePath:instancePath+"/tokensPerRun",schemaPath:"#/$defs/TokensPerRun/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;}else {if(data2 < 1 || isNaN(data2)){const err7: any = {instancePath:instancePath+"/tokensPerRun",schemaPath:"#/$defs/TokensPerRun/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;}}}}var _valid1: any = _errs15 === errors;valid4 = valid4 || _valid1;const _errs18: any = errors;if(data2 !== null){const err8: any = {instancePath:instancePath+"/tokensPerRun",schemaPath:"#/properties/tokensPerRun/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;}var _valid1: any = _errs18 === errors;valid4 = valid4 || _valid1;if(!valid4){const err9: any = {instancePath:instancePath+"/tokensPerRun",schemaPath:"#/properties/tokensPerRun/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;validate1869.errors = vErrors;return false;}else {errors = _errs14;if(vErrors !== null){if(_errs14){vErrors.length = _errs14;}else {vErrors = null;}}}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}if(valid0){if(data.committedSpendUsdMicros !== undefined){let data3: any = data.committedSpendUsdMicros;const _errs20: any = errors;const _errs21: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validate1869.errors = [{instancePath:instancePath+"/committedSpendUsdMicros",schemaPath:"#/$defs/UsdMicros/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs21){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validate1869.errors = [{instancePath:instancePath+"/committedSpendUsdMicros",schemaPath:"#/$defs/UsdMicros/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 0 || isNaN(data3)){validate1869.errors = [{instancePath:instancePath+"/committedSpendUsdMicros",schemaPath:"#/$defs/UsdMicros/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs20 === errors;}else {var valid0: any = true;}if(valid0){if(data.agentSpend !== undefined){let data4: any = data.agentSpend;const _errs23: any = errors;if(errors === _errs23){if(Array.isArray(data4)){var valid7: any = true;const len0: any = data4.length;for(let i0=0; i0<len0; i0++){const _errs25: any = errors;if(!(validate1866.call(this, data4[i0], {instancePath:instancePath+"/agentSpend/" + i0,parentData:data4,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1866.errors : vErrors.concat(validate1866.errors);errors = vErrors.length;}var valid7: any = _errs25 === errors;if(!valid7){break;}}}else {validate1869.errors = [{instancePath:instancePath+"/agentSpend",schemaPath:"#/properties/agentSpend/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs23 === errors;}else {var valid0: any = true;}}}}}}}}else {validate1869.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1869.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1869.errors = null as any[] | null;
// prettier-ignore
validate1869.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern16 = new RegExp("^[a-z][a-z0-9-]{0,31}$", "u");
// prettier-ignore
const schema2633: any = {"description":"How an account is charged. `unknown` means not known, never `metered`: it labels cost and\nnever derives it.","type":"string","enum":["subscription","metered","unknown"]};
// prettier-ignore
function validate1874(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1874.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.providerAccountId === undefined) && (missing0 = "providerAccountId")) || ((data.billingMode === undefined) && (missing0 = "billingMode"))) || ((data.tokens === undefined) && (missing0 = "tokens"))) || ((data.usdMicros === undefined) && (missing0 = "usdMicros"))){validate1874.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "providerAccountId") || (key0 === "billingMode")) || (key0 === "tokens")) || (key0 === "usdMicros"))){validate1874.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.providerAccountId !== undefined){let data0: any = data.providerAccountId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) > 256){validate1874.errors = [{instancePath:instancePath+"/providerAccountId",schemaPath:"sidekicks-contracts:provider/account/record#/$defs/ProviderAccountId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data0) < 1){validate1874.errors = [{instancePath:instancePath+"/providerAccountId",schemaPath:"sidekicks-contracts:provider/account/record#/$defs/ProviderAccountId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1874.errors = [{instancePath:instancePath+"/providerAccountId",schemaPath:"sidekicks-contracts:provider/account/record#/$defs/ProviderAccountId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.billingMode !== undefined){let data1: any = data.billingMode;const _errs6: any = errors;if(typeof data1 !== "string"){validate1874.errors = [{instancePath:instancePath+"/billingMode",schemaPath:"sidekicks-contracts:provider/account/record#/$defs/BillingMode/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data1 === "subscription") || (data1 === "metered")) || (data1 === "unknown"))){validate1874.errors = [{instancePath:instancePath+"/billingMode",schemaPath:"sidekicks-contracts:provider/account/record#/$defs/BillingMode/enum",keyword:"enum",params:{allowedValues: schema2633.enum}}];return false;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.tokens !== undefined){let data2: any = data.tokens;const _errs9: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validate1874.errors = [{instancePath:instancePath+"/tokens",schemaPath:"#/properties/tokens/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs9){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validate1874.errors = [{instancePath:instancePath+"/tokens",schemaPath:"#/properties/tokens/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 0 || isNaN(data2)){validate1874.errors = [{instancePath:instancePath+"/tokens",schemaPath:"#/properties/tokens/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.usdMicros !== undefined){let data3: any = data.usdMicros;const _errs11: any = errors;const _errs12: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validate1874.errors = [{instancePath:instancePath+"/usdMicros",schemaPath:"#/$defs/UsdMicros/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs12){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validate1874.errors = [{instancePath:instancePath+"/usdMicros",schemaPath:"#/$defs/UsdMicros/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 0 || isNaN(data3)){validate1874.errors = [{instancePath:instancePath+"/usdMicros",schemaPath:"#/$defs/UsdMicros/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs11 === errors;}else {var valid0: any = true;}}}}}}}else {validate1874.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1874.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1874.errors = null as any[] | null;
// prettier-ignore
validate1874.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1876(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1876.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.seconds === undefined) && (missing0 = "seconds")) || ((data.usdMicros === undefined) && (missing0 = "usdMicros"))){validate1876.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "seconds") || (key0 === "usdMicros"))){validate1876.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.seconds !== undefined){let data0: any = data.seconds;const _errs2: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validate1876.errors = [{instancePath:instancePath+"/seconds",schemaPath:"#/properties/seconds/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs2){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){validate1876.errors = [{instancePath:instancePath+"/seconds",schemaPath:"#/properties/seconds/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data0 < 0 || isNaN(data0)){validate1876.errors = [{instancePath:instancePath+"/seconds",schemaPath:"#/properties/seconds/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.usdMicros !== undefined){let data1: any = data.usdMicros;const _errs4: any = errors;const _errs5: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validate1876.errors = [{instancePath:instancePath+"/usdMicros",schemaPath:"#/$defs/UsdMicros/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs5){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validate1876.errors = [{instancePath:instancePath+"/usdMicros",schemaPath:"#/$defs/UsdMicros/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 0 || isNaN(data1)){validate1876.errors = [{instancePath:instancePath+"/usdMicros",schemaPath:"#/$defs/UsdMicros/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validate1876.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1876.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1876.errors = null as any[] | null;
// prettier-ignore
validate1876.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1873(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1873.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.providerName === undefined) && (missing0 = "providerName")) || ((data.accounts === undefined) && (missing0 = "accounts"))) || ((data.subtotalUsdMicros === undefined) && (missing0 = "subtotalUsdMicros"))){validate1873.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "providerName") || (key0 === "accounts")) || (key0 === "voice")) || (key0 === "subtotalUsdMicros"))){validate1873.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.providerName !== undefined){let data0: any = data.providerName;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern16.test(data0)){validate1873.errors = [{instancePath:instancePath+"/providerName",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate1873.errors = [{instancePath:instancePath+"/providerName",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.accounts !== undefined){let data1: any = data.accounts;const _errs6: any = errors;if(errors === _errs6){if(Array.isArray(data1)){var valid2: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){const _errs8: any = errors;if(!(validate1874.call(this, data1[i0], {instancePath:instancePath+"/accounts/" + i0,parentData:data1,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1874.errors : vErrors.concat(validate1874.errors);errors = vErrors.length;}var valid2: any = _errs8 === errors;if(!valid2){break;}}}else {validate1873.errors = [{instancePath:instancePath+"/accounts",schemaPath:"#/properties/accounts/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.voice !== undefined){const _errs9: any = errors;if(!(validate1876.call(this, data.voice, {instancePath:instancePath+"/voice",parentData:data,parentDataProperty:"voice",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1876.errors : vErrors.concat(validate1876.errors);errors = vErrors.length;}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.subtotalUsdMicros !== undefined){let data4: any = data.subtotalUsdMicros;const _errs10: any = errors;const _errs11: any = errors;if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){validate1873.errors = [{instancePath:instancePath+"/subtotalUsdMicros",schemaPath:"#/$defs/UsdMicros/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs11){if((typeof data4 == "number") && (isFinite(data4))){if(data4 > 9007199254740991 || isNaN(data4)){validate1873.errors = [{instancePath:instancePath+"/subtotalUsdMicros",schemaPath:"#/$defs/UsdMicros/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data4 < 0 || isNaN(data4)){validate1873.errors = [{instancePath:instancePath+"/subtotalUsdMicros",schemaPath:"#/$defs/UsdMicros/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}}else {validate1873.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1873.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1873.errors = null as any[] | null;
// prettier-ignore
validate1873.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1871(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionCostReceipt {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1871.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionTotal === undefined) && (missing0 = "sessionTotal")) || ((data.providers === undefined) && (missing0 = "providers"))){validate1871.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionTotal") || (key0 === "providers"))){validate1871.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionTotal !== undefined){const _errs2: any = errors;if(!(validate1869.call(this, data.sessionTotal, {instancePath:instancePath+"/sessionTotal",parentData:data,parentDataProperty:"sessionTotal",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1869.errors : vErrors.concat(validate1869.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.providers !== undefined){let data1: any = data.providers;const _errs3: any = errors;if(errors === _errs3){if(Array.isArray(data1)){var valid1: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){const _errs5: any = errors;if(!(validate1873.call(this, data1[i0], {instancePath:instancePath+"/providers/" + i0,parentData:data1,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1873.errors : vErrors.concat(validate1873.errors);errors = vErrors.length;}var valid1: any = _errs5 === errors;if(!valid1){break;}}}else {validate1871.errors = [{instancePath:instancePath+"/providers",schemaPath:"#/properties/providers/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validate1871.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1871.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1871.errors = null as any[] | null;
// prettier-ignore
validate1871.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1879(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionCostReceiptReadRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1879.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validate1879.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "sessionId")){validate1879.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1879.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1879.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate1879.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1879.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1879.errors = null as any[] | null;
// prettier-ignore
validate1879.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1880(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TokensPerRun {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1880.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(!(((typeof data == "number") && (!(data % 1) && !isNaN(data))) && (isFinite(data)))){validate1880.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === 0){if((typeof data == "number") && (isFinite(data))){if(data > 9007199254740991 || isNaN(data)){validate1880.errors = [{instancePath,schemaPath:"#/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data < 1 || isNaN(data)){validate1880.errors = [{instancePath,schemaPath:"#/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}validate1880.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1880.errors = null as any[] | null;
// prettier-ignore
validate1880.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1881(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is UsdMicros {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1881.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(!(((typeof data == "number") && (!(data % 1) && !isNaN(data))) && (isFinite(data)))){validate1881.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === 0){if((typeof data == "number") && (isFinite(data))){if(data > 9007199254740991 || isNaN(data)){validate1881.errors = [{instancePath,schemaPath:"#/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data < 0 || isNaN(data)){validate1881.errors = [{instancePath,schemaPath:"#/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}validate1881.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1881.errors = null as any[] | null;
// prettier-ignore
validate1881.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AgentSpend}. */
export const validateAgentSpend: SchemaCheck<AgentSpend> = validate1866;
/** Checks that a value is a {@link SessionBudgetReadRequest}. */
export const validateSessionBudgetReadRequest: SchemaCheck<SessionBudgetReadRequest> = validate1868;
/** Checks that a value is a {@link SessionBudgetState}. */
export const validateSessionBudgetState: SchemaCheck<SessionBudgetState> = validate1869;
/** Checks that a value is a {@link SessionCostReceipt}. */
export const validateSessionCostReceipt: SchemaCheck<SessionCostReceipt> = validate1871;
/** Checks that a value is a {@link SessionCostReceiptReadRequest}. */
export const validateSessionCostReceiptReadRequest: SchemaCheck<SessionCostReceiptReadRequest> =
  validate1879;
/** Checks that a value is a {@link TokensPerRun}. */
export const validateTokensPerRun: SchemaCheck<TokensPerRun> = validate1880;
/** Checks that a value is a {@link UsdMicros}. */
export const validateUsdMicros: SchemaCheck<UsdMicros> = validate1881;
