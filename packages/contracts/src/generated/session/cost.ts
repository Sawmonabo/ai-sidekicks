// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A session's spend: the committed figure and each agent's share of it, and the cost receipt the inspector reads by provider and account, all in whole micro-dollars.

import { type CompiledSchemaCheck, ucs2length } from "../../schema-check.js";
import { type AgentTreeMember, validateAgentTreeMember } from "../agent/tree.js";
import {
  type BillingMode,
  type ProviderAccountId,
  validateBillingMode,
  validateProviderAccountId,
} from "../provider/account/record.js";
import { type ProviderId, validateProviderId } from "../provider/id.js";
import { type SessionId, validateSessionId } from "./id.js";

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

/** Checks that a value is a {@link UsdMicros}. */
// prettier-ignore
export const validateUsdMicros: CompiledSchemaCheck<UsdMicros> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is UsdMicros {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateUsdMicros.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(!(((typeof data == "number") && (!(data % 1) && !isNaN(data))) && (isFinite(data)))){validateUsdMicros.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === 0){if((typeof data == "number") && (isFinite(data))){if(data > 9007199254740991 || isNaN(data)){validateUsdMicros.errors = [{instancePath,schemaPath:"#/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data < 0 || isNaN(data)){validateUsdMicros.errors = [{instancePath,schemaPath:"#/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}validateUsdMicros.errors = vErrors;return errors === 0;};
// prettier-ignore
validateUsdMicros.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link TokensPerRun}. */
// prettier-ignore
export const validateTokensPerRun: CompiledSchemaCheck<TokensPerRun> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TokensPerRun {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateTokensPerRun.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(!(((typeof data == "number") && (!(data % 1) && !isNaN(data))) && (isFinite(data)))){validateTokensPerRun.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === 0){if((typeof data == "number") && (isFinite(data))){if(data > 9007199254740991 || isNaN(data)){validateTokensPerRun.errors = [{instancePath,schemaPath:"#/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data < 1 || isNaN(data)){validateTokensPerRun.errors = [{instancePath,schemaPath:"#/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}validateTokensPerRun.errors = vErrors;return errors === 0;};
// prettier-ignore
validateTokensPerRun.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AgentSpend}. */
// prettier-ignore
export const validateAgentSpend: CompiledSchemaCheck<AgentSpend> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentSpend {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAgentSpend.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.agent === undefined) && (missing0 = "agent")) || ((data.ownUsdMicros === undefined) && (missing0 = "ownUsdMicros"))) || ((data.subtreeUsdMicros === undefined) && (missing0 = "subtreeUsdMicros"))){validateAgentSpend.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "agent") || (key0 === "ownUsdMicros")) || (key0 === "subtreeUsdMicros"))){validateAgentSpend.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.agent !== undefined){const _errs2: any = errors;if(!(validateAgentTreeMember.call(this, data.agent, {instancePath:instancePath+"/agent",parentData:data,parentDataProperty:"agent",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAgentTreeMember.errors : vErrors.concat(validateAgentTreeMember.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.ownUsdMicros !== undefined){const _errs3: any = errors;if(!(validateUsdMicros.call(this, data.ownUsdMicros, {instancePath:instancePath+"/ownUsdMicros",parentData:data,parentDataProperty:"ownUsdMicros",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateUsdMicros.errors : vErrors.concat(validateUsdMicros.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.subtreeUsdMicros !== undefined){let data2: any = data.subtreeUsdMicros;const _errs4: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validateAgentSpend.errors = [{instancePath:instancePath+"/subtreeUsdMicros",schemaPath:"#/properties/subtreeUsdMicros/type",keyword:"type",params:{type: "integer"}}];return false;}if(!(validateUsdMicros.call(this, data2, {instancePath:instancePath+"/subtreeUsdMicros",parentData:data,parentDataProperty:"subtreeUsdMicros",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateUsdMicros.errors : vErrors.concat(validateUsdMicros.errors);errors = vErrors.length;}if(errors === _errs4){if((typeof data2 == "number") && (isFinite(data2))){const vSchema0: any = data && data.ownUsdMicros;if(vSchema0 !== undefined && ((!((typeof vSchema0 == "number") && (isFinite(vSchema0)))) || (data2 < vSchema0 || isNaN(data2)))){validateAgentSpend.errors = [{instancePath:instancePath+"/subtreeUsdMicros",schemaPath:"#/properties/subtreeUsdMicros/minimum",keyword:"minimum",params:{comparison: ">=", limit: vSchema0}}];return false;}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}}else {validateAgentSpend.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAgentSpend.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAgentSpend.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionBudgetState}. */
// prettier-ignore
export const validateSessionBudgetState: CompiledSchemaCheck<SessionBudgetState> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionBudgetState {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionBudgetState.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.spendLimitUsdMicros === undefined) && (missing0 = "spendLimitUsdMicros"))) || ((data.tokensPerRun === undefined) && (missing0 = "tokensPerRun"))) || ((data.committedSpendUsdMicros === undefined) && (missing0 = "committedSpendUsdMicros"))) || ((data.agentSpend === undefined) && (missing0 = "agentSpend"))){validateSessionBudgetState.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "sessionId") || (key0 === "spendLimitUsdMicros")) || (key0 === "tokensPerRun")) || (key0 === "committedSpendUsdMicros")) || (key0 === "agentSpend"))){validateSessionBudgetState.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.spendLimitUsdMicros !== undefined){let data1: any = data.spendLimitUsdMicros;const _errs3: any = errors;const _errs4: any = errors;let valid1: any = false;const _errs5: any = errors;if(!(validateUsdMicros.call(this, data1, {instancePath:instancePath+"/spendLimitUsdMicros",parentData:data,parentDataProperty:"spendLimitUsdMicros",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateUsdMicros.errors : vErrors.concat(validateUsdMicros.errors);errors = vErrors.length;}var _valid0: any = _errs5 === errors;valid1 = valid1 || _valid0;const _errs6: any = errors;if(data1 !== null){const err0: any = {instancePath:instancePath+"/spendLimitUsdMicros",schemaPath:"#/properties/spendLimitUsdMicros/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var _valid0: any = _errs6 === errors;valid1 = valid1 || _valid0;if(!valid1){const err1: any = {instancePath:instancePath+"/spendLimitUsdMicros",schemaPath:"#/properties/spendLimitUsdMicros/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;validateSessionBudgetState.errors = vErrors;return false;}else {errors = _errs4;if(vErrors !== null){if(_errs4){vErrors.length = _errs4;}else {vErrors = null;}}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.tokensPerRun !== undefined){let data2: any = data.tokensPerRun;const _errs8: any = errors;const _errs9: any = errors;let valid2: any = false;const _errs10: any = errors;if(!(validateTokensPerRun.call(this, data2, {instancePath:instancePath+"/tokensPerRun",parentData:data,parentDataProperty:"tokensPerRun",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTokensPerRun.errors : vErrors.concat(validateTokensPerRun.errors);errors = vErrors.length;}var _valid1: any = _errs10 === errors;valid2 = valid2 || _valid1;const _errs11: any = errors;if(data2 !== null){const err2: any = {instancePath:instancePath+"/tokensPerRun",schemaPath:"#/properties/tokensPerRun/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}var _valid1: any = _errs11 === errors;valid2 = valid2 || _valid1;if(!valid2){const err3: any = {instancePath:instancePath+"/tokensPerRun",schemaPath:"#/properties/tokensPerRun/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;validateSessionBudgetState.errors = vErrors;return false;}else {errors = _errs9;if(vErrors !== null){if(_errs9){vErrors.length = _errs9;}else {vErrors = null;}}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.committedSpendUsdMicros !== undefined){const _errs13: any = errors;if(!(validateUsdMicros.call(this, data.committedSpendUsdMicros, {instancePath:instancePath+"/committedSpendUsdMicros",parentData:data,parentDataProperty:"committedSpendUsdMicros",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateUsdMicros.errors : vErrors.concat(validateUsdMicros.errors);errors = vErrors.length;}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}if(valid0){if(data.agentSpend !== undefined){let data4: any = data.agentSpend;const _errs14: any = errors;if(errors === _errs14){if(Array.isArray(data4)){var valid3: any = true;const len0: any = data4.length;for(let i0=0; i0<len0; i0++){const _errs16: any = errors;if(!(validateAgentSpend.call(this, data4[i0], {instancePath:instancePath+"/agentSpend/" + i0,parentData:data4,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAgentSpend.errors : vErrors.concat(validateAgentSpend.errors);errors = vErrors.length;}var valid3: any = _errs16 === errors;if(!valid3){break;}}}else {validateSessionBudgetState.errors = [{instancePath:instancePath+"/agentSpend",schemaPath:"#/properties/agentSpend/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}}}}}}}}else {validateSessionBudgetState.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionBudgetState.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionBudgetState.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionBudgetReadRequest}. */
// prettier-ignore
export const validateSessionBudgetReadRequest: CompiledSchemaCheck<SessionBudgetReadRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionBudgetReadRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionBudgetReadRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validateSessionBudgetReadRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "sessionId")){validateSessionBudgetReadRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}}}}}else {validateSessionBudgetReadRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionBudgetReadRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionBudgetReadRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionCostReceiptReadRequest}. */
// prettier-ignore
export const validateSessionCostReceiptReadRequest: CompiledSchemaCheck<SessionCostReceiptReadRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionCostReceiptReadRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionCostReceiptReadRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validateSessionCostReceiptReadRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "sessionId")){validateSessionCostReceiptReadRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}}}}}else {validateSessionCostReceiptReadRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionCostReceiptReadRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionCostReceiptReadRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionCostReceiptAccountRow}. */
// prettier-ignore
export const validateSessionCostReceiptAccountRow: CompiledSchemaCheck<SessionCostReceiptAccountRow> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionCostReceiptAccountRow {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionCostReceiptAccountRow.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.providerAccountId === undefined) && (missing0 = "providerAccountId")) || ((data.billingMode === undefined) && (missing0 = "billingMode"))) || ((data.tokens === undefined) && (missing0 = "tokens"))) || ((data.usdMicros === undefined) && (missing0 = "usdMicros"))){validateSessionCostReceiptAccountRow.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "providerAccountId") || (key0 === "billingMode")) || (key0 === "tokens")) || (key0 === "usdMicros"))){validateSessionCostReceiptAccountRow.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.providerAccountId !== undefined){const _errs2: any = errors;if(!(validateProviderAccountId.call(this, data.providerAccountId, {instancePath:instancePath+"/providerAccountId",parentData:data,parentDataProperty:"providerAccountId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderAccountId.errors : vErrors.concat(validateProviderAccountId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.billingMode !== undefined){const _errs3: any = errors;if(!(validateBillingMode.call(this, data.billingMode, {instancePath:instancePath+"/billingMode",parentData:data,parentDataProperty:"billingMode",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateBillingMode.errors : vErrors.concat(validateBillingMode.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.tokens !== undefined){let data2: any = data.tokens;const _errs4: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validateSessionCostReceiptAccountRow.errors = [{instancePath:instancePath+"/tokens",schemaPath:"#/properties/tokens/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs4){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validateSessionCostReceiptAccountRow.errors = [{instancePath:instancePath+"/tokens",schemaPath:"#/properties/tokens/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 0 || isNaN(data2)){validateSessionCostReceiptAccountRow.errors = [{instancePath:instancePath+"/tokens",schemaPath:"#/properties/tokens/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.usdMicros !== undefined){const _errs6: any = errors;if(!(validateUsdMicros.call(this, data.usdMicros, {instancePath:instancePath+"/usdMicros",parentData:data,parentDataProperty:"usdMicros",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateUsdMicros.errors : vErrors.concat(validateUsdMicros.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}}else {validateSessionCostReceiptAccountRow.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionCostReceiptAccountRow.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionCostReceiptAccountRow.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionCostReceiptVoiceRow}. */
// prettier-ignore
export const validateSessionCostReceiptVoiceRow: CompiledSchemaCheck<SessionCostReceiptVoiceRow> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionCostReceiptVoiceRow {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionCostReceiptVoiceRow.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.seconds === undefined) && (missing0 = "seconds")) || ((data.usdMicros === undefined) && (missing0 = "usdMicros"))){validateSessionCostReceiptVoiceRow.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "seconds") || (key0 === "usdMicros"))){validateSessionCostReceiptVoiceRow.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.seconds !== undefined){let data0: any = data.seconds;const _errs2: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validateSessionCostReceiptVoiceRow.errors = [{instancePath:instancePath+"/seconds",schemaPath:"#/properties/seconds/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs2){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){validateSessionCostReceiptVoiceRow.errors = [{instancePath:instancePath+"/seconds",schemaPath:"#/properties/seconds/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data0 < 0 || isNaN(data0)){validateSessionCostReceiptVoiceRow.errors = [{instancePath:instancePath+"/seconds",schemaPath:"#/properties/seconds/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.usdMicros !== undefined){const _errs4: any = errors;if(!(validateUsdMicros.call(this, data.usdMicros, {instancePath:instancePath+"/usdMicros",parentData:data,parentDataProperty:"usdMicros",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateUsdMicros.errors : vErrors.concat(validateUsdMicros.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validateSessionCostReceiptVoiceRow.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionCostReceiptVoiceRow.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionCostReceiptVoiceRow.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionCostReceiptProvider}. */
// prettier-ignore
export const validateSessionCostReceiptProvider: CompiledSchemaCheck<SessionCostReceiptProvider> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionCostReceiptProvider {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionCostReceiptProvider.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.providerName === undefined) && (missing0 = "providerName")) || ((data.accounts === undefined) && (missing0 = "accounts"))) || ((data.subtotalUsdMicros === undefined) && (missing0 = "subtotalUsdMicros"))){validateSessionCostReceiptProvider.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "providerName") || (key0 === "accounts")) || (key0 === "voice")) || (key0 === "subtotalUsdMicros"))){validateSessionCostReceiptProvider.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.providerName !== undefined){const _errs2: any = errors;if(!(validateProviderId.call(this, data.providerName, {instancePath:instancePath+"/providerName",parentData:data,parentDataProperty:"providerName",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderId.errors : vErrors.concat(validateProviderId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.accounts !== undefined){let data1: any = data.accounts;const _errs3: any = errors;if(errors === _errs3){if(Array.isArray(data1)){var valid1: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){const _errs5: any = errors;if(!(validateSessionCostReceiptAccountRow.call(this, data1[i0], {instancePath:instancePath+"/accounts/" + i0,parentData:data1,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionCostReceiptAccountRow.errors : vErrors.concat(validateSessionCostReceiptAccountRow.errors);errors = vErrors.length;}var valid1: any = _errs5 === errors;if(!valid1){break;}}}else {validateSessionCostReceiptProvider.errors = [{instancePath:instancePath+"/accounts",schemaPath:"#/properties/accounts/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.voice !== undefined){const _errs6: any = errors;if(!(validateSessionCostReceiptVoiceRow.call(this, data.voice, {instancePath:instancePath+"/voice",parentData:data,parentDataProperty:"voice",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionCostReceiptVoiceRow.errors : vErrors.concat(validateSessionCostReceiptVoiceRow.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.subtotalUsdMicros !== undefined){const _errs7: any = errors;if(!(validateUsdMicros.call(this, data.subtotalUsdMicros, {instancePath:instancePath+"/subtotalUsdMicros",parentData:data,parentDataProperty:"subtotalUsdMicros",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateUsdMicros.errors : vErrors.concat(validateUsdMicros.errors);errors = vErrors.length;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}}}}}}}else {validateSessionCostReceiptProvider.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionCostReceiptProvider.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionCostReceiptProvider.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionCostReceipt}. */
// prettier-ignore
export const validateSessionCostReceipt: CompiledSchemaCheck<SessionCostReceipt> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionCostReceipt {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionCostReceipt.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionTotal === undefined) && (missing0 = "sessionTotal")) || ((data.providers === undefined) && (missing0 = "providers"))){validateSessionCostReceipt.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionTotal") || (key0 === "providers"))){validateSessionCostReceipt.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionTotal !== undefined){const _errs2: any = errors;if(!(validateSessionBudgetState.call(this, data.sessionTotal, {instancePath:instancePath+"/sessionTotal",parentData:data,parentDataProperty:"sessionTotal",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionBudgetState.errors : vErrors.concat(validateSessionBudgetState.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.providers !== undefined){let data1: any = data.providers;const _errs3: any = errors;if(errors === _errs3){if(Array.isArray(data1)){var valid1: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){const _errs5: any = errors;if(!(validateSessionCostReceiptProvider.call(this, data1[i0], {instancePath:instancePath+"/providers/" + i0,parentData:data1,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionCostReceiptProvider.errors : vErrors.concat(validateSessionCostReceiptProvider.errors);errors = vErrors.length;}var valid1: any = _errs5 === errors;if(!valid1){break;}}}else {validateSessionCostReceipt.errors = [{instancePath:instancePath+"/providers",schemaPath:"#/properties/providers/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateSessionCostReceipt.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionCostReceipt.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionCostReceipt.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
