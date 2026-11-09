// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A session's own controls and the reads behind its composer chips. Every method names the session it acts on, and every setting it changes belongs to that session alone.

import { type SchemaCheck, ucs2length } from "../../../schema-check.js";
import {
  type SubscribeAcknowledgmentResponse,
  validateSubscribeAcknowledgmentResponse,
} from "../../jsonrpc/streaming.js";
import type { McpServerStatus } from "../../mcp/server.js";
import { type EmptyPayload, validateEmptyPayload } from "../../method-descriptor.js";
import type { ProviderCommandEntry } from "../../provider/driver/commands.js";
import type { ProviderId } from "../../provider/id.js";
import {
  type AgentQueueItemCreateResponse,
  validateAgentQueueItemCreateResponse,
} from "../../run/queue.js";
import {
  type SessionBudgetState,
  type TokensPerRun,
  type UsdMicros,
  validateSessionBudgetState,
} from "../cost.js";
import type { SessionId } from "../id.js";

/**
 * The five permission levels, most careful first, the same five words on every provider. Only
 * the first three ever ask the person; at `sandboxed` and `yolo` the daemon answers every ask
 * itself. Plan is not a level: it is the session's mode.
 */
export type PermissionLevel = "readonly" | "ask" | "reviewed" | "sandboxed" | "yolo";
/**
 * Whether the session's next turns plan or build: the composer's mode control.
 */
export type SessionMode = "build" | "plan";
/**
 * The daemon-minted id of one side question, echoed on its answer.
 */
export type SideQuestionId = string & { readonly __brand: "SideQuestionId" };
/**
 * A side question's text: a message sent into a provider turn, uncapped like any other
 * message; not blank and free of NUL.
 */
export type SideQuestionText = string;
/**
 * What a review covers: the working tree, the staged set, or the branch against its base.
 */
export type SessionReviewTarget = "workingTree" | "staged" | "branch";
/**
 * Where a provider session typed in a terminal stands.
 */
export type TerminalProviderSessionState = "working" | "idle" | "unreachable";

/**
 * The one input every session read takes: the session.
 */
export interface SessionAddressedRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
}
/**
 * The acknowledgment an operation with nothing more to say answers with.
 */
export interface SessionAcknowledgment {
  /**
   * The session.
   */
  sessionId: SessionId;
}
/**
 * Moves the session to a level. Setting the level it already has changes nothing, and a move never
 * answers an open card: the new level decides from the next ask.
 */
export interface SessionPermissionLevelUpdateRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The level to move to.
   */
  level: PermissionLevel;
}
/**
 * The level the session now stands at.
 */
export interface SessionPermissionLevelUpdateResponse {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The level it stands at.
   */
  level: PermissionLevel;
}
/**
 * Sets the session's mode.
 */
export interface SessionModeUpdateRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The mode to run in.
   */
  mode: SessionMode;
}
/**
 * The mode the session now runs in.
 */
export interface SessionModeUpdateResponse {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The mode it runs in.
   */
  mode: SessionMode;
}
/**
 * Sets this session's own auto-compact bound from its next turn, as a percent of the window;
 * `null` returns the session to the Settings default. The accepted range comes from the provider's
 * live figures, so the daemon refuses a percent outside it; the type bounds only a percent.
 */
export interface SessionAutoCompactUpdateRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The bound, or `null` for the Settings default.
   */
  percent: number | null;
}
/**
 * The bound the session compacts at from its next turn, and whether it is its own.
 */
export interface SessionAutoCompactUpdateResponse {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The bound.
   */
  percent: number;
  /**
   * Whether the bound is the session's own rather than the Settings default.
   */
  sessionOverride: boolean;
}
/**
 * One tool server this session was started with. `enabled` is the session's own switch;
 * `pendingUntilNextTurn` says a switch flipped mid-turn waits for the next turn. `reason` is
 * the failure or sign-in reason, carried for a server that is not working.
 */
export interface SessionMcpServer {
  /**
   * The server's name.
   */
  serverName: string;
  /**
   * The server's connection state.
   */
  status: McpServerStatus;
  /**
   * Why the server is not working, where it is not.
   */
  reason?: string;
  /**
   * The session's own switch.
   */
  enabled: boolean;
  /**
   * Whether a switch flipped mid-turn waits for the next turn.
   */
  pendingUntilNextTurn: boolean;
}
/**
 * The session's whole server list, sent again on every change.
 */
export interface SessionMcpServerList {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * Its servers.
   */
  servers: SessionMcpServer[];
}
/**
 * Turns one server on or off for this session only.
 */
export interface SessionMcpServerEnabledUpdateRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The server.
   */
  serverName: string;
  /**
   * Whether it is on.
   */
  enabled: boolean;
}
/**
 * The switch as the session now holds it.
 */
export interface SessionMcpServerEnabledUpdateResponse {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The server.
   */
  serverName: string;
  /**
   * Whether it is on.
   */
  enabled: boolean;
}
/**
 * Lists what one working server offers, for `Attach a resource…`.
 */
export interface McpResourceListRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The server.
   */
  serverName: string;
}
/**
 * One resource as the server describes it.
 */
export interface SessionMcpResource {
  /**
   * The resource's address on its server.
   */
  uri: string;
  /**
   * The resource's name.
   */
  name: string;
  /**
   * Its description, where the server gives one.
   */
  description?: string;
  /**
   * Its media type, where the server gives one.
   */
  mimeType?: string;
  /**
   * Its size in bytes, where the server gives one.
   */
  size?: number;
}
/**
 * The server's resources.
 */
export interface McpResourceListResponse {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The server.
   */
  serverName: string;
  /**
   * Its resources.
   */
  resources: SessionMcpResource[];
  /**
   * Whether every page was read; `false` where a page cap stopped the read.
   */
  complete: boolean;
}
/**
 * One prompt a working tool server publishes, listed under the server's name.
 */
export interface SessionServerPrompt {
  /**
   * The server.
   */
  serverName: string;
  /**
   * The prompt's name.
   */
  name: string;
  /**
   * Its description, where the server gives one.
   */
  description?: string;
}
/**
 * The live `/` list's provider half: the running process's slash commands, as its provider
 * publishes them, and each working server's prompts. It is sent whole on every change: a new
 * process, the provider's own list-changed push, a server coming up or going down.
 */
export interface SessionProviderCommandList {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The provider's commands.
   */
  commands: ProviderCommandEntry[];
  /**
   * The working servers' prompts.
   */
  serverPrompts: SessionServerPrompt[];
}
/**
 * Asks a side question in a throwaway copy of the conversation.
 */
export interface SessionSideQuestionAskRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The question.
   */
  question: SideQuestionText;
}
/**
 * The id the answer will carry; the answer arrives later as an event.
 */
export interface SessionSideQuestionAskResponse {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The side question's id.
   */
  sideQuestionId: SideQuestionId;
}
/**
 * Starts the provider's own review as the session's next queued item: admitted at once on an
 * idle session, behind a running turn otherwise, and waking a session with no process as a
 * message does. Answers the queued item as a send answers it; its report lands as the agent's
 * reply.
 */
export interface SessionCodeReviewStartRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * A start again under the same key answers the review the first queued.
   */
  clientIdempotencyKey: string;
  /**
   * What the review covers.
   */
  target: SessionReviewTarget;
}
/**
 * Sets or clears this session's own bound on how many steps one turn may take, from its next
 * turn. `null` returns the session to the machine's own value; a bound below one is refused.
 */
export interface SessionMaxStepsUpdateRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The bound, or `null` for the machine's own value.
   */
  maxStepsPerTurn: number | null;
}
/**
 * The stored override; absent after a clear.
 */
export interface SessionMaxStepsUpdateResponse {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The stored bound, absent after a clear.
   */
  maxStepsPerTurn?: number;
}
/**
 * Sets or clears this session's own `Spend limit`, in micro-dollars; `null` is `Unlimited`.
 * Saving a higher limit carries on the turns the limit stopped.
 */
export interface SessionSpendLimitUpdateRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The limit, or `null` for `Unlimited`.
   */
  spendLimitUsdMicros: UsdMicros | null;
}
/**
 * Sets or clears this session's own `Tokens per run`; `null` is `Unlimited`. Saving a higher limit
 * carries on the run the limit stopped.
 */
export interface SessionTokensPerRunUpdateRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The limit, or `null` for `Unlimited`.
   */
  tokensPerRun: TokensPerRun | null;
}
/**
 * One provider session a person typed in a terminal, inside that provider's shared service.
 */
export interface TerminalProviderSession {
  /**
   * The provider.
   */
  provider: ProviderId;
  /**
   * The session's name.
   */
  name: string;
  /**
   * The provider's thread id.
   */
  threadId: string;
  /**
   * Where it stands.
   */
  state: TerminalProviderSessionState;
}
/**
 * The words a person reads for one provider that has sessions typed in a terminal.
 */
export interface TerminalSessionProvider {
  /**
   * The provider.
   */
  provider: ProviderId;
  /**
   * The provider's name as a person reads it.
   */
  name: string;
  /**
   * The command a person types in a terminal to pick up one of the provider's sessions typed
   * there again.
   */
  resumeCommand: string;
}
/**
 * The provider sessions typed in a terminal, read off the same directory entries the agents'
 * `session_list` names. Empty while the provider's switch that reaches sessions started in a
 * terminal is off.
 */
export interface ProviderTerminalSessionListResponse {
  /**
   * The sessions.
   */
  sessions: TerminalProviderSession[];
  /**
   * Each provider with at least one session in `sessions`, in the provider table's order.
   */
  providers: TerminalSessionProvider[];
}

// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
function validate1826(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is McpResourceListRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1826.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.serverName === undefined) && (missing0 = "serverName"))){validate1826.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "serverName"))){validate1826.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1826.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1826.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.serverName !== undefined){let data1: any = data.serverName;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) > 128){validate1826.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data1) < 1){validate1826.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data1)){validate1826.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1826.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1826.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1826.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1826.errors = null as any[] | null;
// prettier-ignore
validate1826.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1827(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is McpResourceListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1827.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.serverName === undefined) && (missing0 = "serverName"))) || ((data.resources === undefined) && (missing0 = "resources"))) || ((data.complete === undefined) && (missing0 = "complete"))){validate1827.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "sessionId") || (key0 === "serverName")) || (key0 === "resources")) || (key0 === "complete"))){validate1827.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1827.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1827.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.serverName !== undefined){let data1: any = data.serverName;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) > 128){validate1827.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data1) < 1){validate1827.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data1)){validate1827.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1827.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.resources !== undefined){let data2: any = data.resources;const _errs8: any = errors;if(errors === _errs8){if(Array.isArray(data2)){var valid2: any = true;const len0: any = data2.length;for(let i0=0; i0<len0; i0++){let data3: any = data2[i0];const _errs10: any = errors;const _errs11: any = errors;if(errors === _errs11){if(data3 && typeof data3 == "object" && !Array.isArray(data3)){let missing1: any;if(((data3.uri === undefined) && (missing1 = "uri")) || ((data3.name === undefined) && (missing1 = "name"))){validate1827.errors = [{instancePath:instancePath+"/resources/" + i0,schemaPath:"#/$defs/SessionMcpResource/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs13: any = errors;for(const key1 in data3){if(!((((((key1 === "uri") || (key1 === "name")) || (key1 === "title")) || (key1 === "description")) || (key1 === "mimeType")) || (key1 === "size"))){validate1827.errors = [{instancePath:instancePath+"/resources/" + i0,schemaPath:"#/$defs/SessionMcpResource/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs13 === errors){if(data3.uri !== undefined){let data4: any = data3.uri;const _errs14: any = errors;if(errors === _errs14){if(typeof data4 === "string"){if(func1(data4) < 1){validate1827.errors = [{instancePath:instancePath+"/resources/" + i0+"/uri",schemaPath:"#/$defs/SessionMcpResource/properties/uri/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1827.errors = [{instancePath:instancePath+"/resources/" + i0+"/uri",schemaPath:"#/$defs/SessionMcpResource/properties/uri/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs14 === errors;}else {var valid4: any = true;}if(valid4){if(data3.name !== undefined){let data5: any = data3.name;const _errs16: any = errors;if(errors === _errs16){if(typeof data5 === "string"){if(func1(data5) < 1){validate1827.errors = [{instancePath:instancePath+"/resources/" + i0+"/name",schemaPath:"#/$defs/SessionMcpResource/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1827.errors = [{instancePath:instancePath+"/resources/" + i0+"/name",schemaPath:"#/$defs/SessionMcpResource/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs16 === errors;}else {var valid4: any = true;}if(valid4){if(data3.title !== undefined){let data6: any = data3.title;const _errs18: any = errors;if(errors === _errs18){if(typeof data6 === "string"){if(func1(data6) < 1){validate1827.errors = [{instancePath:instancePath+"/resources/" + i0+"/title",schemaPath:"#/$defs/SessionMcpResource/properties/title/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1827.errors = [{instancePath:instancePath+"/resources/" + i0+"/title",schemaPath:"#/$defs/SessionMcpResource/properties/title/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs18 === errors;}else {var valid4: any = true;}if(valid4){if(data3.description !== undefined){let data7: any = data3.description;const _errs20: any = errors;if(errors === _errs20){if(typeof data7 === "string"){if(func1(data7) < 1){validate1827.errors = [{instancePath:instancePath+"/resources/" + i0+"/description",schemaPath:"#/$defs/SessionMcpResource/properties/description/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1827.errors = [{instancePath:instancePath+"/resources/" + i0+"/description",schemaPath:"#/$defs/SessionMcpResource/properties/description/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs20 === errors;}else {var valid4: any = true;}if(valid4){if(data3.mimeType !== undefined){let data8: any = data3.mimeType;const _errs22: any = errors;if(errors === _errs22){if(typeof data8 === "string"){if(func1(data8) < 1){validate1827.errors = [{instancePath:instancePath+"/resources/" + i0+"/mimeType",schemaPath:"#/$defs/SessionMcpResource/properties/mimeType/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1827.errors = [{instancePath:instancePath+"/resources/" + i0+"/mimeType",schemaPath:"#/$defs/SessionMcpResource/properties/mimeType/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs22 === errors;}else {var valid4: any = true;}if(valid4){if(data3.size !== undefined){let data9: any = data3.size;const _errs24: any = errors;if(!(((typeof data9 == "number") && (!(data9 % 1) && !isNaN(data9))) && (isFinite(data9)))){validate1827.errors = [{instancePath:instancePath+"/resources/" + i0+"/size",schemaPath:"#/$defs/SessionMcpResource/properties/size/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs24){if((typeof data9 == "number") && (isFinite(data9))){if(data9 > 9007199254740991 || isNaN(data9)){validate1827.errors = [{instancePath:instancePath+"/resources/" + i0+"/size",schemaPath:"#/$defs/SessionMcpResource/properties/size/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data9 < 0 || isNaN(data9)){validate1827.errors = [{instancePath:instancePath+"/resources/" + i0+"/size",schemaPath:"#/$defs/SessionMcpResource/properties/size/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid4: any = _errs24 === errors;}else {var valid4: any = true;}}}}}}}}}else {validate1827.errors = [{instancePath:instancePath+"/resources/" + i0,schemaPath:"#/$defs/SessionMcpResource/type",keyword:"type",params:{type: "object"}}];return false;}}var valid2: any = _errs10 === errors;if(!valid2){break;}}}else {validate1827.errors = [{instancePath:instancePath+"/resources",schemaPath:"#/properties/resources/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.complete !== undefined){const _errs26: any = errors;if(typeof data.complete !== "boolean"){validate1827.errors = [{instancePath:instancePath+"/complete",schemaPath:"#/properties/complete/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs26 === errors;}else {var valid0: any = true;}}}}}}}else {validate1827.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1827.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1827.errors = null as any[] | null;
// prettier-ignore
validate1827.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1110: any = {"description":"The five permission levels, most careful first, the same five words on every provider. Only\nthe first three ever ask the person; at `sandboxed` and `yolo` the daemon answers every ask\nitself. Plan is not a level: it is the session's mode.","type":"string","enum":["readonly","ask","reviewed","sandboxed","yolo"]};
// prettier-ignore
function validate1828(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PermissionLevel {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1828.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validate1828.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((((data === "readonly") || (data === "ask")) || (data === "reviewed")) || (data === "sandboxed")) || (data === "yolo"))){validate1828.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1110.enum}}];return false;}validate1828.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1828.errors = null as any[] | null;
// prettier-ignore
validate1828.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema3657: any = {"description":"Where a provider session typed in a terminal stands.","type":"string","enum":["working","idle","unreachable"]};
// prettier-ignore
const pattern16 = new RegExp("^[a-z][a-z0-9-]{0,31}$", "u");
// prettier-ignore
function validate1830(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1830.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.provider === undefined) && (missing0 = "provider")) || ((data.name === undefined) && (missing0 = "name"))) || ((data.threadId === undefined) && (missing0 = "threadId"))) || ((data.state === undefined) && (missing0 = "state"))){validate1830.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "provider") || (key0 === "name")) || (key0 === "threadId")) || (key0 === "state"))){validate1830.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.provider !== undefined){let data0: any = data.provider;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern16.test(data0)){validate1830.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate1830.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data1: any = data.name;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) < 1){validate1830.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1830.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.threadId !== undefined){let data2: any = data.threadId;const _errs8: any = errors;if(errors === _errs8){if(typeof data2 === "string"){if(func1(data2) < 1){validate1830.errors = [{instancePath:instancePath+"/threadId",schemaPath:"#/properties/threadId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1830.errors = [{instancePath:instancePath+"/threadId",schemaPath:"#/properties/threadId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){let data3: any = data.state;const _errs10: any = errors;if(typeof data3 !== "string"){validate1830.errors = [{instancePath:instancePath+"/state",schemaPath:"#/$defs/TerminalProviderSessionState/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data3 === "working") || (data3 === "idle")) || (data3 === "unreachable"))){validate1830.errors = [{instancePath:instancePath+"/state",schemaPath:"#/$defs/TerminalProviderSessionState/enum",keyword:"enum",params:{allowedValues: schema3657.enum}}];return false;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}}else {validate1830.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1830.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1830.errors = null as any[] | null;
// prettier-ignore
validate1830.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1832(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1832.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.provider === undefined) && (missing0 = "provider")) || ((data.name === undefined) && (missing0 = "name"))) || ((data.resumeCommand === undefined) && (missing0 = "resumeCommand"))){validate1832.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "provider") || (key0 === "name")) || (key0 === "resumeCommand"))){validate1832.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.provider !== undefined){let data0: any = data.provider;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern16.test(data0)){validate1832.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate1832.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data1: any = data.name;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) > 512){validate1832.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/maxLength",keyword:"maxLength",params:{limit: 512}}];return false;}else {if(func1(data1) < 1){validate1832.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data1)){validate1832.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1832.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.resumeCommand !== undefined){let data2: any = data.resumeCommand;const _errs8: any = errors;if(errors === _errs8){if(typeof data2 === "string"){if(func1(data2) > 512){validate1832.errors = [{instancePath:instancePath+"/resumeCommand",schemaPath:"#/properties/resumeCommand/maxLength",keyword:"maxLength",params:{limit: 512}}];return false;}else {if(func1(data2) < 1){validate1832.errors = [{instancePath:instancePath+"/resumeCommand",schemaPath:"#/properties/resumeCommand/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data2)){validate1832.errors = [{instancePath:instancePath+"/resumeCommand",schemaPath:"#/properties/resumeCommand/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1832.errors = [{instancePath:instancePath+"/resumeCommand",schemaPath:"#/properties/resumeCommand/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}}}}}}else {validate1832.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1832.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1832.errors = null as any[] | null;
// prettier-ignore
validate1832.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1829(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderTerminalSessionListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1829.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessions === undefined) && (missing0 = "sessions")) || ((data.providers === undefined) && (missing0 = "providers"))){validate1829.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessions") || (key0 === "providers"))){validate1829.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessions !== undefined){let data0: any = data.sessions;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validate1830.call(this, data0[i0], {instancePath:instancePath+"/sessions/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1830.errors : vErrors.concat(validate1830.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validate1829.errors = [{instancePath:instancePath+"/sessions",schemaPath:"#/properties/sessions/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.providers !== undefined){let data2: any = data.providers;const _errs5: any = errors;if(errors === _errs5){if(Array.isArray(data2)){var valid2: any = true;const len1: any = data2.length;for(let i1=0; i1<len1; i1++){const _errs7: any = errors;if(!(validate1832.call(this, data2[i1], {instancePath:instancePath+"/providers/" + i1,parentData:data2,parentDataProperty:i1,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1832.errors : vErrors.concat(validate1832.errors);errors = vErrors.length;}var valid2: any = _errs7 === errors;if(!valid2){break;}}}else {validate1829.errors = [{instancePath:instancePath+"/providers",schemaPath:"#/properties/providers/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}else {validate1829.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1829.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1829.errors = null as any[] | null;
// prettier-ignore
validate1829.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1834(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionAcknowledgment {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1834.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validate1834.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "sessionId")){validate1834.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1834.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1834.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate1834.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1834.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1834.errors = null as any[] | null;
// prettier-ignore
validate1834.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1835(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionAddressedRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1835.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validate1835.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "sessionId")){validate1835.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1835.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1835.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate1835.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1835.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1835.errors = null as any[] | null;
// prettier-ignore
validate1835.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema3664: any = {"type":"object","additionalProperties":false,"properties":{"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"percent":{"type":["number","null"],"exclusiveMinimum":0,"maximum":100,"description":"The bound, or `null` for the Settings default."}},"required":["sessionId","percent"],"description":"Sets this session's own auto-compact bound from its next turn, as a percent of the window;\n`null` returns the session to the Settings default. The accepted range comes from the provider's\nlive figures, so the daemon refuses a percent outside it; the type bounds only a percent."};
// prettier-ignore
function validate1836(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionAutoCompactUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1836.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.percent === undefined) && (missing0 = "percent"))){validate1836.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "percent"))){validate1836.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1836.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1836.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.percent !== undefined){let data1: any = data.percent;const _errs6: any = errors;if((!((typeof data1 == "number") && (isFinite(data1)))) && (data1 !== null)){validate1836.errors = [{instancePath:instancePath+"/percent",schemaPath:"#/properties/percent/type",keyword:"type",params:{type: schema3664.properties.percent.type}}];return false;}if(errors === _errs6){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 100 || isNaN(data1)){validate1836.errors = [{instancePath:instancePath+"/percent",schemaPath:"#/properties/percent/maximum",keyword:"maximum",params:{comparison: "<=", limit: 100}}];return false;}else {if(data1 <= 0 || isNaN(data1)){validate1836.errors = [{instancePath:instancePath+"/percent",schemaPath:"#/properties/percent/exclusiveMinimum",keyword:"exclusiveMinimum",params:{comparison: ">", limit: 0}}];return false;}}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1836.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1836.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1836.errors = null as any[] | null;
// prettier-ignore
validate1836.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1837(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionAutoCompactUpdateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1837.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.percent === undefined) && (missing0 = "percent"))) || ((data.sessionOverride === undefined) && (missing0 = "sessionOverride"))){validate1837.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "percent")) || (key0 === "sessionOverride"))){validate1837.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1837.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1837.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.percent !== undefined){let data1: any = data.percent;const _errs6: any = errors;if(errors === _errs6){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 100 || isNaN(data1)){validate1837.errors = [{instancePath:instancePath+"/percent",schemaPath:"#/properties/percent/maximum",keyword:"maximum",params:{comparison: "<=", limit: 100}}];return false;}else {if(data1 <= 0 || isNaN(data1)){validate1837.errors = [{instancePath:instancePath+"/percent",schemaPath:"#/properties/percent/exclusiveMinimum",keyword:"exclusiveMinimum",params:{comparison: ">", limit: 0}}];return false;}}}else {validate1837.errors = [{instancePath:instancePath+"/percent",schemaPath:"#/properties/percent/type",keyword:"type",params:{type: "number"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.sessionOverride !== undefined){const _errs8: any = errors;if(typeof data.sessionOverride !== "boolean"){validate1837.errors = [{instancePath:instancePath+"/sessionOverride",schemaPath:"#/properties/sessionOverride/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}}}}}}else {validate1837.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1837.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1837.errors = null as any[] | null;
// prettier-ignore
validate1837.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1101: any = {"description":"What a review covers: the working tree, the staged set, or the branch against its base.","type":"string","enum":["workingTree","staged","branch"]};
// prettier-ignore
const pattern222 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$", "u");
// prettier-ignore
function validate1838(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionCodeReviewStartRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1838.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.clientIdempotencyKey === undefined) && (missing0 = "clientIdempotencyKey"))) || ((data.target === undefined) && (missing0 = "target"))){validate1838.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "clientIdempotencyKey")) || (key0 === "target"))){validate1838.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1838.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1838.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.clientIdempotencyKey !== undefined){let data1: any = data.clientIdempotencyKey;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(!pattern222.test(data1)){validate1838.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}}];return false;}}else {validate1838.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.target !== undefined){let data2: any = data.target;const _errs8: any = errors;if(typeof data2 !== "string"){validate1838.errors = [{instancePath:instancePath+"/target",schemaPath:"#/$defs/SessionReviewTarget/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data2 === "workingTree") || (data2 === "staged")) || (data2 === "branch"))){validate1838.errors = [{instancePath:instancePath+"/target",schemaPath:"#/$defs/SessionReviewTarget/enum",keyword:"enum",params:{allowedValues: schema1101.enum}}];return false;}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}}}}}}else {validate1838.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1838.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1838.errors = null as any[] | null;
// prettier-ignore
validate1838.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema3671: any = {"type":"object","additionalProperties":false,"properties":{"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"maxStepsPerTurn":{"type":["integer","null"],"minimum":1,"maximum":9007199254740991,"description":"The bound, or `null` for the machine's own value."}},"required":["sessionId","maxStepsPerTurn"],"description":"Sets or clears this session's own bound on how many steps one turn may take, from its next\nturn. `null` returns the session to the machine's own value; a bound below one is refused."};
// prettier-ignore
function validate1839(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionMaxStepsUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1839.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.maxStepsPerTurn === undefined) && (missing0 = "maxStepsPerTurn"))){validate1839.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "maxStepsPerTurn"))){validate1839.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1839.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1839.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.maxStepsPerTurn !== undefined){let data1: any = data.maxStepsPerTurn;const _errs6: any = errors;if((!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))) && (data1 !== null)){validate1839.errors = [{instancePath:instancePath+"/maxStepsPerTurn",schemaPath:"#/properties/maxStepsPerTurn/type",keyword:"type",params:{type: schema3671.properties.maxStepsPerTurn.type}}];return false;}if(errors === _errs6){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validate1839.errors = [{instancePath:instancePath+"/maxStepsPerTurn",schemaPath:"#/properties/maxStepsPerTurn/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 1 || isNaN(data1)){validate1839.errors = [{instancePath:instancePath+"/maxStepsPerTurn",schemaPath:"#/properties/maxStepsPerTurn/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1839.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1839.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1839.errors = null as any[] | null;
// prettier-ignore
validate1839.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1840(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionMaxStepsUpdateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1840.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validate1840.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "maxStepsPerTurn"))){validate1840.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1840.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1840.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.maxStepsPerTurn !== undefined){let data1: any = data.maxStepsPerTurn;const _errs6: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validate1840.errors = [{instancePath:instancePath+"/maxStepsPerTurn",schemaPath:"#/properties/maxStepsPerTurn/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs6){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validate1840.errors = [{instancePath:instancePath+"/maxStepsPerTurn",schemaPath:"#/properties/maxStepsPerTurn/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 1 || isNaN(data1)){validate1840.errors = [{instancePath:instancePath+"/maxStepsPerTurn",schemaPath:"#/properties/maxStepsPerTurn/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1840.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1840.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1840.errors = null as any[] | null;
// prettier-ignore
validate1840.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1841(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionMcpServerEnabledUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1841.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.serverName === undefined) && (missing0 = "serverName"))) || ((data.enabled === undefined) && (missing0 = "enabled"))){validate1841.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "serverName")) || (key0 === "enabled"))){validate1841.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1841.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1841.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.serverName !== undefined){let data1: any = data.serverName;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) > 128){validate1841.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data1) < 1){validate1841.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data1)){validate1841.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1841.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.enabled !== undefined){const _errs8: any = errors;if(typeof data.enabled !== "boolean"){validate1841.errors = [{instancePath:instancePath+"/enabled",schemaPath:"#/properties/enabled/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}}}}}}else {validate1841.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1841.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1841.errors = null as any[] | null;
// prettier-ignore
validate1841.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1842(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionMcpServerEnabledUpdateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1842.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.serverName === undefined) && (missing0 = "serverName"))) || ((data.enabled === undefined) && (missing0 = "enabled"))){validate1842.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "serverName")) || (key0 === "enabled"))){validate1842.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1842.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1842.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.serverName !== undefined){let data1: any = data.serverName;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) > 128){validate1842.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data1) < 1){validate1842.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data1)){validate1842.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1842.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.enabled !== undefined){const _errs8: any = errors;if(typeof data.enabled !== "boolean"){validate1842.errors = [{instancePath:instancePath+"/enabled",schemaPath:"#/properties/enabled/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}}}}}}else {validate1842.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1842.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1842.errors = null as any[] | null;
// prettier-ignore
validate1842.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema2031: any = {"description":"A server's connection state; it says nothing about which of its tools a session can see.","type":"string","enum":["failed","needsAuth","unknown","starting","connected"]};
// prettier-ignore
function validate1844(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1844.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.serverName === undefined) && (missing0 = "serverName")) || ((data.status === undefined) && (missing0 = "status"))) || ((data.enabled === undefined) && (missing0 = "enabled"))) || ((data.pendingUntilNextTurn === undefined) && (missing0 = "pendingUntilNextTurn"))){validate1844.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "serverName") || (key0 === "status")) || (key0 === "reason")) || (key0 === "enabled")) || (key0 === "pendingUntilNextTurn"))){validate1844.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.serverName !== undefined){let data0: any = data.serverName;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 128){validate1844.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data0) < 1){validate1844.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data0)){validate1844.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1844.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.status !== undefined){let data1: any = data.status;const _errs4: any = errors;if(typeof data1 !== "string"){validate1844.errors = [{instancePath:instancePath+"/status",schemaPath:"sidekicks-contracts:mcp/server#/$defs/McpServerStatus/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((((data1 === "failed") || (data1 === "needsAuth")) || (data1 === "unknown")) || (data1 === "starting")) || (data1 === "connected"))){validate1844.errors = [{instancePath:instancePath+"/status",schemaPath:"sidekicks-contracts:mcp/server#/$defs/McpServerStatus/enum",keyword:"enum",params:{allowedValues: schema2031.enum}}];return false;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.reason !== undefined){let data2: any = data.reason;const _errs7: any = errors;if(errors === _errs7){if(typeof data2 === "string"){if(func1(data2) < 1){validate1844.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/properties/reason/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1844.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.enabled !== undefined){const _errs9: any = errors;if(typeof data.enabled !== "boolean"){validate1844.errors = [{instancePath:instancePath+"/enabled",schemaPath:"#/properties/enabled/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.pendingUntilNextTurn !== undefined){const _errs11: any = errors;if(typeof data.pendingUntilNextTurn !== "boolean"){validate1844.errors = [{instancePath:instancePath+"/pendingUntilNextTurn",schemaPath:"#/properties/pendingUntilNextTurn/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs11 === errors;}else {var valid0: any = true;}}}}}}}}else {validate1844.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1844.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1844.errors = null as any[] | null;
// prettier-ignore
validate1844.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1843(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionMcpServerList {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1843.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.servers === undefined) && (missing0 = "servers"))){validate1843.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "servers"))){validate1843.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1843.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1843.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.servers !== undefined){let data1: any = data.servers;const _errs6: any = errors;if(errors === _errs6){if(Array.isArray(data1)){var valid2: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){const _errs8: any = errors;if(!(validate1844.call(this, data1[i0], {instancePath:instancePath+"/servers/" + i0,parentData:data1,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1844.errors : vErrors.concat(validate1844.errors);errors = vErrors.length;}var valid2: any = _errs8 === errors;if(!valid2){break;}}}else {validate1843.errors = [{instancePath:instancePath+"/servers",schemaPath:"#/properties/servers/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1843.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1843.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1843.errors = null as any[] | null;
// prettier-ignore
validate1843.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1113: any = {"description":"Whether the session's next turns plan or build: the composer's mode control.","type":"string","enum":["build","plan"]};
// prettier-ignore
function validate1846(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionModeUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1846.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.mode === undefined) && (missing0 = "mode"))){validate1846.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "mode"))){validate1846.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1846.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1846.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.mode !== undefined){let data1: any = data.mode;const _errs6: any = errors;if(typeof data1 !== "string"){validate1846.errors = [{instancePath:instancePath+"/mode",schemaPath:"#/$defs/SessionMode/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data1 === "build") || (data1 === "plan"))){validate1846.errors = [{instancePath:instancePath+"/mode",schemaPath:"#/$defs/SessionMode/enum",keyword:"enum",params:{allowedValues: schema1113.enum}}];return false;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1846.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1846.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1846.errors = null as any[] | null;
// prettier-ignore
validate1846.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1847(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionModeUpdateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1847.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.mode === undefined) && (missing0 = "mode"))){validate1847.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "mode"))){validate1847.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1847.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1847.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.mode !== undefined){let data1: any = data.mode;const _errs6: any = errors;if(typeof data1 !== "string"){validate1847.errors = [{instancePath:instancePath+"/mode",schemaPath:"#/$defs/SessionMode/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data1 === "build") || (data1 === "plan"))){validate1847.errors = [{instancePath:instancePath+"/mode",schemaPath:"#/$defs/SessionMode/enum",keyword:"enum",params:{allowedValues: schema1113.enum}}];return false;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1847.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1847.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1847.errors = null as any[] | null;
// prettier-ignore
validate1847.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1848(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionPermissionLevelUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1848.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.level === undefined) && (missing0 = "level"))){validate1848.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "level"))){validate1848.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1848.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1848.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.level !== undefined){let data1: any = data.level;const _errs6: any = errors;if(typeof data1 !== "string"){validate1848.errors = [{instancePath:instancePath+"/level",schemaPath:"#/$defs/PermissionLevel/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((((data1 === "readonly") || (data1 === "ask")) || (data1 === "reviewed")) || (data1 === "sandboxed")) || (data1 === "yolo"))){validate1848.errors = [{instancePath:instancePath+"/level",schemaPath:"#/$defs/PermissionLevel/enum",keyword:"enum",params:{allowedValues: schema1110.enum}}];return false;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1848.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1848.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1848.errors = null as any[] | null;
// prettier-ignore
validate1848.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1849(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionPermissionLevelUpdateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1849.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.level === undefined) && (missing0 = "level"))){validate1849.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "level"))){validate1849.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1849.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1849.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.level !== undefined){let data1: any = data.level;const _errs6: any = errors;if(typeof data1 !== "string"){validate1849.errors = [{instancePath:instancePath+"/level",schemaPath:"#/$defs/PermissionLevel/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((((data1 === "readonly") || (data1 === "ask")) || (data1 === "reviewed")) || (data1 === "sandboxed")) || (data1 === "yolo"))){validate1849.errors = [{instancePath:instancePath+"/level",schemaPath:"#/$defs/PermissionLevel/enum",keyword:"enum",params:{allowedValues: schema1110.enum}}];return false;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1849.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1849.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1849.errors = null as any[] | null;
// prettier-ignore
validate1849.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema2843: any = {"oneOf":[{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"command"},"name":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":128,"description":"The word the person types."},"description":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":16384,"description":"What it does, absent when the provider publishes none."},"argumentHint":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":16384,"description":"The provider's hint for what follows the word, where it publishes one."},"scope":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":128,"description":"The scope the provider declares, where it declares one."},"enabled":{"type":"boolean","description":"Whether it is enabled, where the provider draws that distinction."},"binding":{"$ref":"#/$defs/ProviderCommandBinding","description":"The binding the entry was read under."},"server":{"not":{},"tsType":"never","description":"Only a prompt names a server."},"title":{"not":{},"tsType":"never","description":"Only a prompt carries a title."}},"required":["kind","name","binding"],"description":"A provider's command."},{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"skill"},"name":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":128,"description":"The word the person types."},"description":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":16384,"description":"What it does, absent when the provider publishes none."},"argumentHint":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":16384,"description":"The provider's hint for what follows the word, where it publishes one."},"scope":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":128,"description":"The scope the provider declares, where it declares one."},"enabled":{"type":"boolean","description":"Whether it is enabled, where the provider draws that distinction."},"binding":{"$ref":"#/$defs/ProviderCommandBinding","description":"The binding the entry was read under."},"server":{"not":{},"tsType":"never","description":"Only a prompt names a server."},"title":{"not":{},"tsType":"never","description":"Only a prompt carries a title."}},"required":["kind","name","binding"],"description":"A skill."},{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"prompt"},"name":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":128,"description":"The word the person types."},"description":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":16384,"description":"What it does, absent when the provider publishes none."},"argumentHint":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":16384,"description":"The provider's hint for what follows the word, where it publishes one."},"scope":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":128,"description":"The scope the provider declares, where it declares one."},"enabled":{"type":"boolean","description":"Whether it is enabled, where the provider draws that distinction."},"binding":{"$ref":"#/$defs/ProviderCommandBinding","description":"The binding the entry was read under."},"server":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":128,"description":"The tool server that publishes the prompt."},"title":{"type":"string","minLength":1,"description":"The prompt's title for people, where the server gives one."}},"required":["kind","name","binding","server"],"description":"A working tool server's prompt, grouped under the server that publishes it."}],"description":"One command, skill or tool server prompt as the provider listed it, told apart by\n`kind`: a disabled entry is returned, not dropped, and `binding` is its routing key.\n`server` is present exactly on a prompt, and `title` only there.","discriminator":{"propertyName":"kind"},"type":"object","unevaluatedProperties":false};
// prettier-ignore
const func2 = Object.prototype.hasOwnProperty;
// prettier-ignore
function validate1504(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1504.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.providerName === undefined) && (missing0 = "providerName")) || ((data.providerAccountId === undefined) && (missing0 = "providerAccountId"))){validate1504.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "providerName") || (key0 === "providerAccountId"))){validate1504.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.providerName !== undefined){let data0: any = data.providerName;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern16.test(data0)){validate1504.errors = [{instancePath:instancePath+"/providerName",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate1504.errors = [{instancePath:instancePath+"/providerName",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.providerAccountId !== undefined){let data1: any = data.providerAccountId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) > 256){validate1504.errors = [{instancePath:instancePath+"/providerAccountId",schemaPath:"sidekicks-contracts:provider/account/record#/$defs/ProviderAccountId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validate1504.errors = [{instancePath:instancePath+"/providerAccountId",schemaPath:"sidekicks-contracts:provider/account/record#/$defs/ProviderAccountId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1504.errors = [{instancePath:instancePath+"/providerAccountId",schemaPath:"sidekicks-contracts:provider/account/record#/$defs/ProviderAccountId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1504.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1504.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1504.errors = null as any[] | null;
// prettier-ignore
validate1504.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1503(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1503.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "command"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.kind === undefined) && (missing0 = "kind")) || ((data.name === undefined) && (missing0 = "name"))) || ((data.binding === undefined) && (missing0 = "binding"))){validate1503.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!(func2.call(schema2843.oneOf[0].properties, key0))){validate1503.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs5: any = errors;if(typeof data0 !== "string"){validate1503.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("command" !== data0){validate1503.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "command"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.name !== undefined){let data1: any = data.name;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) > 128){validate1503.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/0/properties/name/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data1) < 1){validate1503.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/0/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data1)){validate1503.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/0/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1503.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/0/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.description !== undefined){let data2: any = data.description;const _errs9: any = errors;if(errors === _errs9){if(typeof data2 === "string"){if(func1(data2) > 16384){validate1503.errors = [{instancePath:instancePath+"/description",schemaPath:"#/oneOf/0/properties/description/maxLength",keyword:"maxLength",params:{limit: 16384}}];return false;}else {if(func1(data2) < 1){validate1503.errors = [{instancePath:instancePath+"/description",schemaPath:"#/oneOf/0/properties/description/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data2)){validate1503.errors = [{instancePath:instancePath+"/description",schemaPath:"#/oneOf/0/properties/description/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1503.errors = [{instancePath:instancePath+"/description",schemaPath:"#/oneOf/0/properties/description/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs9 === errors;}else {var valid2: any = true;}if(valid2){if(data.argumentHint !== undefined){let data3: any = data.argumentHint;const _errs11: any = errors;if(errors === _errs11){if(typeof data3 === "string"){if(func1(data3) > 16384){validate1503.errors = [{instancePath:instancePath+"/argumentHint",schemaPath:"#/oneOf/0/properties/argumentHint/maxLength",keyword:"maxLength",params:{limit: 16384}}];return false;}else {if(func1(data3) < 1){validate1503.errors = [{instancePath:instancePath+"/argumentHint",schemaPath:"#/oneOf/0/properties/argumentHint/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data3)){validate1503.errors = [{instancePath:instancePath+"/argumentHint",schemaPath:"#/oneOf/0/properties/argumentHint/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1503.errors = [{instancePath:instancePath+"/argumentHint",schemaPath:"#/oneOf/0/properties/argumentHint/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs11 === errors;}else {var valid2: any = true;}if(valid2){if(data.scope !== undefined){let data4: any = data.scope;const _errs13: any = errors;if(errors === _errs13){if(typeof data4 === "string"){if(func1(data4) > 128){validate1503.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/oneOf/0/properties/scope/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data4) < 1){validate1503.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/oneOf/0/properties/scope/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data4)){validate1503.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/oneOf/0/properties/scope/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1503.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/oneOf/0/properties/scope/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs13 === errors;}else {var valid2: any = true;}if(valid2){if(data.enabled !== undefined){const _errs15: any = errors;if(typeof data.enabled !== "boolean"){validate1503.errors = [{instancePath:instancePath+"/enabled",schemaPath:"#/oneOf/0/properties/enabled/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid2: any = _errs15 === errors;}else {var valid2: any = true;}if(valid2){if(data.binding !== undefined){const _errs17: any = errors;if(!(validate1504.call(this, data.binding, {instancePath:instancePath+"/binding",parentData:data,parentDataProperty:"binding",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1504.errors : vErrors.concat(validate1504.errors);errors = vErrors.length;}var valid2: any = _errs17 === errors;}else {var valid2: any = true;}if(valid2){if(data.server !== undefined){const _errs18: any = errors;validate1503.errors = [{instancePath:instancePath+"/server",schemaPath:"#/oneOf/0/properties/server/not",keyword:"not",params:{}}];return false;var valid2: any = _errs18 === errors;}else {var valid2: any = true;}if(valid2){if(data.title !== undefined){const _errs21: any = errors;validate1503.errors = [{instancePath:instancePath+"/title",schemaPath:"#/oneOf/0/properties/title/not",keyword:"not",params:{}}];return false;var valid2: any = _errs21 === errors;}else {var valid2: any = true;}}}}}}}}}}}}else {validate1503.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "skill"){const _errs24: any = errors;if(errors === _errs24){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((data.kind === undefined) && (missing1 = "kind")) || ((data.name === undefined) && (missing1 = "name"))) || ((data.binding === undefined) && (missing1 = "binding"))){validate1503.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs26: any = errors;for(const key1 in data){if(!(func2.call(schema2843.oneOf[1].properties, key1))){validate1503.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs26 === errors){if(data.kind !== undefined){let data9: any = data.kind;const _errs27: any = errors;if(typeof data9 !== "string"){validate1503.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("skill" !== data9){validate1503.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "skill"}}];return false;}var valid4: any = _errs27 === errors;}else {var valid4: any = true;}if(valid4){if(data.name !== undefined){let data10: any = data.name;const _errs29: any = errors;if(errors === _errs29){if(typeof data10 === "string"){if(func1(data10) > 128){validate1503.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/1/properties/name/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data10) < 1){validate1503.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/1/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data10)){validate1503.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/1/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1503.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/1/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs29 === errors;}else {var valid4: any = true;}if(valid4){if(data.description !== undefined){let data11: any = data.description;const _errs31: any = errors;if(errors === _errs31){if(typeof data11 === "string"){if(func1(data11) > 16384){validate1503.errors = [{instancePath:instancePath+"/description",schemaPath:"#/oneOf/1/properties/description/maxLength",keyword:"maxLength",params:{limit: 16384}}];return false;}else {if(func1(data11) < 1){validate1503.errors = [{instancePath:instancePath+"/description",schemaPath:"#/oneOf/1/properties/description/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data11)){validate1503.errors = [{instancePath:instancePath+"/description",schemaPath:"#/oneOf/1/properties/description/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1503.errors = [{instancePath:instancePath+"/description",schemaPath:"#/oneOf/1/properties/description/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs31 === errors;}else {var valid4: any = true;}if(valid4){if(data.argumentHint !== undefined){let data12: any = data.argumentHint;const _errs33: any = errors;if(errors === _errs33){if(typeof data12 === "string"){if(func1(data12) > 16384){validate1503.errors = [{instancePath:instancePath+"/argumentHint",schemaPath:"#/oneOf/1/properties/argumentHint/maxLength",keyword:"maxLength",params:{limit: 16384}}];return false;}else {if(func1(data12) < 1){validate1503.errors = [{instancePath:instancePath+"/argumentHint",schemaPath:"#/oneOf/1/properties/argumentHint/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data12)){validate1503.errors = [{instancePath:instancePath+"/argumentHint",schemaPath:"#/oneOf/1/properties/argumentHint/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1503.errors = [{instancePath:instancePath+"/argumentHint",schemaPath:"#/oneOf/1/properties/argumentHint/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs33 === errors;}else {var valid4: any = true;}if(valid4){if(data.scope !== undefined){let data13: any = data.scope;const _errs35: any = errors;if(errors === _errs35){if(typeof data13 === "string"){if(func1(data13) > 128){validate1503.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/oneOf/1/properties/scope/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data13) < 1){validate1503.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/oneOf/1/properties/scope/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data13)){validate1503.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/oneOf/1/properties/scope/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1503.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/oneOf/1/properties/scope/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs35 === errors;}else {var valid4: any = true;}if(valid4){if(data.enabled !== undefined){const _errs37: any = errors;if(typeof data.enabled !== "boolean"){validate1503.errors = [{instancePath:instancePath+"/enabled",schemaPath:"#/oneOf/1/properties/enabled/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid4: any = _errs37 === errors;}else {var valid4: any = true;}if(valid4){if(data.binding !== undefined){const _errs39: any = errors;if(!(validate1504.call(this, data.binding, {instancePath:instancePath+"/binding",parentData:data,parentDataProperty:"binding",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1504.errors : vErrors.concat(validate1504.errors);errors = vErrors.length;}var valid4: any = _errs39 === errors;}else {var valid4: any = true;}if(valid4){if(data.server !== undefined){const _errs40: any = errors;validate1503.errors = [{instancePath:instancePath+"/server",schemaPath:"#/oneOf/1/properties/server/not",keyword:"not",params:{}}];return false;var valid4: any = _errs40 === errors;}else {var valid4: any = true;}if(valid4){if(data.title !== undefined){const _errs43: any = errors;validate1503.errors = [{instancePath:instancePath+"/title",schemaPath:"#/oneOf/1/properties/title/not",keyword:"not",params:{}}];return false;var valid4: any = _errs43 === errors;}else {var valid4: any = true;}}}}}}}}}}}}else {validate1503.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs24 === errors;if(props0 !== true){props0 = true;}valid0 = valid3;}else if(tag0 === "prompt"){const _errs46: any = errors;if(errors === _errs46){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if(((((data.kind === undefined) && (missing2 = "kind")) || ((data.name === undefined) && (missing2 = "name"))) || ((data.binding === undefined) && (missing2 = "binding"))) || ((data.server === undefined) && (missing2 = "server"))){validate1503.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs48: any = errors;for(const key2 in data){if(!(func2.call(schema2843.oneOf[2].properties, key2))){validate1503.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs48 === errors){if(data.kind !== undefined){let data18: any = data.kind;const _errs49: any = errors;if(typeof data18 !== "string"){validate1503.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("prompt" !== data18){validate1503.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/const",keyword:"const",params:{allowedValue: "prompt"}}];return false;}var valid6: any = _errs49 === errors;}else {var valid6: any = true;}if(valid6){if(data.name !== undefined){let data19: any = data.name;const _errs51: any = errors;if(errors === _errs51){if(typeof data19 === "string"){if(func1(data19) > 128){validate1503.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/2/properties/name/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data19) < 1){validate1503.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/2/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data19)){validate1503.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/2/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1503.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/2/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid6: any = _errs51 === errors;}else {var valid6: any = true;}if(valid6){if(data.description !== undefined){let data20: any = data.description;const _errs53: any = errors;if(errors === _errs53){if(typeof data20 === "string"){if(func1(data20) > 16384){validate1503.errors = [{instancePath:instancePath+"/description",schemaPath:"#/oneOf/2/properties/description/maxLength",keyword:"maxLength",params:{limit: 16384}}];return false;}else {if(func1(data20) < 1){validate1503.errors = [{instancePath:instancePath+"/description",schemaPath:"#/oneOf/2/properties/description/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data20)){validate1503.errors = [{instancePath:instancePath+"/description",schemaPath:"#/oneOf/2/properties/description/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1503.errors = [{instancePath:instancePath+"/description",schemaPath:"#/oneOf/2/properties/description/type",keyword:"type",params:{type: "string"}}];return false;}}var valid6: any = _errs53 === errors;}else {var valid6: any = true;}if(valid6){if(data.argumentHint !== undefined){let data21: any = data.argumentHint;const _errs55: any = errors;if(errors === _errs55){if(typeof data21 === "string"){if(func1(data21) > 16384){validate1503.errors = [{instancePath:instancePath+"/argumentHint",schemaPath:"#/oneOf/2/properties/argumentHint/maxLength",keyword:"maxLength",params:{limit: 16384}}];return false;}else {if(func1(data21) < 1){validate1503.errors = [{instancePath:instancePath+"/argumentHint",schemaPath:"#/oneOf/2/properties/argumentHint/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data21)){validate1503.errors = [{instancePath:instancePath+"/argumentHint",schemaPath:"#/oneOf/2/properties/argumentHint/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1503.errors = [{instancePath:instancePath+"/argumentHint",schemaPath:"#/oneOf/2/properties/argumentHint/type",keyword:"type",params:{type: "string"}}];return false;}}var valid6: any = _errs55 === errors;}else {var valid6: any = true;}if(valid6){if(data.scope !== undefined){let data22: any = data.scope;const _errs57: any = errors;if(errors === _errs57){if(typeof data22 === "string"){if(func1(data22) > 128){validate1503.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/oneOf/2/properties/scope/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data22) < 1){validate1503.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/oneOf/2/properties/scope/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data22)){validate1503.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/oneOf/2/properties/scope/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1503.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/oneOf/2/properties/scope/type",keyword:"type",params:{type: "string"}}];return false;}}var valid6: any = _errs57 === errors;}else {var valid6: any = true;}if(valid6){if(data.enabled !== undefined){const _errs59: any = errors;if(typeof data.enabled !== "boolean"){validate1503.errors = [{instancePath:instancePath+"/enabled",schemaPath:"#/oneOf/2/properties/enabled/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid6: any = _errs59 === errors;}else {var valid6: any = true;}if(valid6){if(data.binding !== undefined){const _errs61: any = errors;if(!(validate1504.call(this, data.binding, {instancePath:instancePath+"/binding",parentData:data,parentDataProperty:"binding",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1504.errors : vErrors.concat(validate1504.errors);errors = vErrors.length;}var valid6: any = _errs61 === errors;}else {var valid6: any = true;}if(valid6){if(data.server !== undefined){let data25: any = data.server;const _errs62: any = errors;if(errors === _errs62){if(typeof data25 === "string"){if(func1(data25) > 128){validate1503.errors = [{instancePath:instancePath+"/server",schemaPath:"#/oneOf/2/properties/server/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data25) < 1){validate1503.errors = [{instancePath:instancePath+"/server",schemaPath:"#/oneOf/2/properties/server/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data25)){validate1503.errors = [{instancePath:instancePath+"/server",schemaPath:"#/oneOf/2/properties/server/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1503.errors = [{instancePath:instancePath+"/server",schemaPath:"#/oneOf/2/properties/server/type",keyword:"type",params:{type: "string"}}];return false;}}var valid6: any = _errs62 === errors;}else {var valid6: any = true;}if(valid6){if(data.title !== undefined){let data26: any = data.title;const _errs64: any = errors;if(errors === _errs64){if(typeof data26 === "string"){if(func1(data26) < 1){validate1503.errors = [{instancePath:instancePath+"/title",schemaPath:"#/oneOf/2/properties/title/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1503.errors = [{instancePath:instancePath+"/title",schemaPath:"#/oneOf/2/properties/title/type",keyword:"type",params:{type: "string"}}];return false;}}var valid6: any = _errs64 === errors;}else {var valid6: any = true;}}}}}}}}}}}}else {validate1503.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}var valid5: any = _errs46 === errors;if(props0 !== true){props0 = true;}valid0 = valid5;}else {validate1503.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validate1503.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key3 in data){if(!props0 || !props0[key3]){validate1503.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key3}}];return false;break;}}}}}else {validate1503.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1503.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1503.errors = null as any[] | null;
// prettier-ignore
validate1503.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1850(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionProviderCommandList {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1850.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.commands === undefined) && (missing0 = "commands"))) || ((data.serverPrompts === undefined) && (missing0 = "serverPrompts"))){validate1850.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "commands")) || (key0 === "serverPrompts"))){validate1850.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1850.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1850.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.commands !== undefined){let data1: any = data.commands;const _errs6: any = errors;if(errors === _errs6){if(Array.isArray(data1)){var valid2: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){const _errs8: any = errors;if(!(validate1503.call(this, data1[i0], {instancePath:instancePath+"/commands/" + i0,parentData:data1,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1503.errors : vErrors.concat(validate1503.errors);errors = vErrors.length;}var valid2: any = _errs8 === errors;if(!valid2){break;}}}else {validate1850.errors = [{instancePath:instancePath+"/commands",schemaPath:"#/properties/commands/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.serverPrompts !== undefined){let data3: any = data.serverPrompts;const _errs9: any = errors;if(errors === _errs9){if(Array.isArray(data3)){var valid3: any = true;const len1: any = data3.length;for(let i1=0; i1<len1; i1++){let data4: any = data3[i1];const _errs11: any = errors;const _errs12: any = errors;if(errors === _errs12){if(data4 && typeof data4 == "object" && !Array.isArray(data4)){let missing1: any;if(((data4.serverName === undefined) && (missing1 = "serverName")) || ((data4.name === undefined) && (missing1 = "name"))){validate1850.errors = [{instancePath:instancePath+"/serverPrompts/" + i1,schemaPath:"#/$defs/SessionServerPrompt/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs14: any = errors;for(const key1 in data4){if(!((((key1 === "serverName") || (key1 === "name")) || (key1 === "title")) || (key1 === "description"))){validate1850.errors = [{instancePath:instancePath+"/serverPrompts/" + i1,schemaPath:"#/$defs/SessionServerPrompt/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs14 === errors){if(data4.serverName !== undefined){let data5: any = data4.serverName;const _errs15: any = errors;if(errors === _errs15){if(typeof data5 === "string"){if(func1(data5) > 128){validate1850.errors = [{instancePath:instancePath+"/serverPrompts/" + i1+"/serverName",schemaPath:"#/$defs/SessionServerPrompt/properties/serverName/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data5) < 1){validate1850.errors = [{instancePath:instancePath+"/serverPrompts/" + i1+"/serverName",schemaPath:"#/$defs/SessionServerPrompt/properties/serverName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data5)){validate1850.errors = [{instancePath:instancePath+"/serverPrompts/" + i1+"/serverName",schemaPath:"#/$defs/SessionServerPrompt/properties/serverName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1850.errors = [{instancePath:instancePath+"/serverPrompts/" + i1+"/serverName",schemaPath:"#/$defs/SessionServerPrompt/properties/serverName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs15 === errors;}else {var valid5: any = true;}if(valid5){if(data4.name !== undefined){let data6: any = data4.name;const _errs17: any = errors;if(errors === _errs17){if(typeof data6 === "string"){if(func1(data6) < 1){validate1850.errors = [{instancePath:instancePath+"/serverPrompts/" + i1+"/name",schemaPath:"#/$defs/SessionServerPrompt/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1850.errors = [{instancePath:instancePath+"/serverPrompts/" + i1+"/name",schemaPath:"#/$defs/SessionServerPrompt/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs17 === errors;}else {var valid5: any = true;}if(valid5){if(data4.title !== undefined){let data7: any = data4.title;const _errs19: any = errors;if(errors === _errs19){if(typeof data7 === "string"){if(func1(data7) < 1){validate1850.errors = [{instancePath:instancePath+"/serverPrompts/" + i1+"/title",schemaPath:"#/$defs/SessionServerPrompt/properties/title/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1850.errors = [{instancePath:instancePath+"/serverPrompts/" + i1+"/title",schemaPath:"#/$defs/SessionServerPrompt/properties/title/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs19 === errors;}else {var valid5: any = true;}if(valid5){if(data4.description !== undefined){let data8: any = data4.description;const _errs21: any = errors;if(errors === _errs21){if(typeof data8 === "string"){if(func1(data8) < 1){validate1850.errors = [{instancePath:instancePath+"/serverPrompts/" + i1+"/description",schemaPath:"#/$defs/SessionServerPrompt/properties/description/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1850.errors = [{instancePath:instancePath+"/serverPrompts/" + i1+"/description",schemaPath:"#/$defs/SessionServerPrompt/properties/description/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs21 === errors;}else {var valid5: any = true;}}}}}}}else {validate1850.errors = [{instancePath:instancePath+"/serverPrompts/" + i1,schemaPath:"#/$defs/SessionServerPrompt/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs11 === errors;if(!valid3){break;}}}else {validate1850.errors = [{instancePath:instancePath+"/serverPrompts",schemaPath:"#/properties/serverPrompts/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}}}}}}else {validate1850.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1850.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1850.errors = null as any[] | null;
// prettier-ignore
validate1850.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1852(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionSideQuestionAskRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1852.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.question === undefined) && (missing0 = "question"))){validate1852.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "question"))){validate1852.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1852.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1852.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.question !== undefined){let data1: any = data.question;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) < 1){validate1852.errors = [{instancePath:instancePath+"/question",schemaPath:"#/$defs/SideQuestionText/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data1)){validate1852.errors = [{instancePath:instancePath+"/question",schemaPath:"#/$defs/SideQuestionText/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate1852.errors = [{instancePath:instancePath+"/question",schemaPath:"#/$defs/SideQuestionText/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1852.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1852.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1852.errors = null as any[] | null;
// prettier-ignore
validate1852.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1853(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionSideQuestionAskResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1853.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.sideQuestionId === undefined) && (missing0 = "sideQuestionId"))){validate1853.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "sideQuestionId"))){validate1853.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1853.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1853.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.sideQuestionId !== undefined){let data1: any = data.sideQuestionId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate1853.errors = [{instancePath:instancePath+"/sideQuestionId",schemaPath:"#/$defs/SideQuestionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1853.errors = [{instancePath:instancePath+"/sideQuestionId",schemaPath:"#/$defs/SideQuestionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1853.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1853.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1853.errors = null as any[] | null;
// prettier-ignore
validate1853.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1854(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionSpendLimitUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1854.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.spendLimitUsdMicros === undefined) && (missing0 = "spendLimitUsdMicros"))){validate1854.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "spendLimitUsdMicros"))){validate1854.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1854.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1854.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.spendLimitUsdMicros !== undefined){let data1: any = data.spendLimitUsdMicros;const _errs6: any = errors;const _errs7: any = errors;let valid2: any = false;const _errs8: any = errors;const _errs9: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){const err0: any = {instancePath:instancePath+"/spendLimitUsdMicros",schemaPath:"sidekicks-contracts:session/cost#/$defs/UsdMicros/type",keyword:"type",params:{type: "integer"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}if(errors === _errs9){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){const err1: any = {instancePath:instancePath+"/spendLimitUsdMicros",schemaPath:"sidekicks-contracts:session/cost#/$defs/UsdMicros/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}else {if(data1 < 0 || isNaN(data1)){const err2: any = {instancePath:instancePath+"/spendLimitUsdMicros",schemaPath:"sidekicks-contracts:session/cost#/$defs/UsdMicros/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}}}}var _valid0: any = _errs8 === errors;valid2 = valid2 || _valid0;const _errs11: any = errors;if(data1 !== null){const err3: any = {instancePath:instancePath+"/spendLimitUsdMicros",schemaPath:"#/properties/spendLimitUsdMicros/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}var _valid0: any = _errs11 === errors;valid2 = valid2 || _valid0;if(!valid2){const err4: any = {instancePath:instancePath+"/spendLimitUsdMicros",schemaPath:"#/properties/spendLimitUsdMicros/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;validate1854.errors = vErrors;return false;}else {errors = _errs7;if(vErrors !== null){if(_errs7){vErrors.length = _errs7;}else {vErrors = null;}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1854.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1854.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1854.errors = null as any[] | null;
// prettier-ignore
validate1854.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1855(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionTokensPerRunUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1855.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.tokensPerRun === undefined) && (missing0 = "tokensPerRun"))){validate1855.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "tokensPerRun"))){validate1855.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1855.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1855.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.tokensPerRun !== undefined){let data1: any = data.tokensPerRun;const _errs6: any = errors;const _errs7: any = errors;let valid2: any = false;const _errs8: any = errors;const _errs9: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){const err0: any = {instancePath:instancePath+"/tokensPerRun",schemaPath:"sidekicks-contracts:session/cost#/$defs/TokensPerRun/type",keyword:"type",params:{type: "integer"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}if(errors === _errs9){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){const err1: any = {instancePath:instancePath+"/tokensPerRun",schemaPath:"sidekicks-contracts:session/cost#/$defs/TokensPerRun/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}else {if(data1 < 1 || isNaN(data1)){const err2: any = {instancePath:instancePath+"/tokensPerRun",schemaPath:"sidekicks-contracts:session/cost#/$defs/TokensPerRun/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}}}}var _valid0: any = _errs8 === errors;valid2 = valid2 || _valid0;const _errs11: any = errors;if(data1 !== null){const err3: any = {instancePath:instancePath+"/tokensPerRun",schemaPath:"#/properties/tokensPerRun/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}var _valid0: any = _errs11 === errors;valid2 = valid2 || _valid0;if(!valid2){const err4: any = {instancePath:instancePath+"/tokensPerRun",schemaPath:"#/properties/tokensPerRun/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;validate1855.errors = vErrors;return false;}else {errors = _errs7;if(vErrors !== null){if(_errs7){vErrors.length = _errs7;}else {vErrors = null;}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1855.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1855.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1855.errors = null as any[] | null;
// prettier-ignore
validate1855.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1856(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SideQuestionId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1856.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern4.test(data)){validate1856.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1856.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validate1856.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1856.errors = null as any[] | null;
// prettier-ignore
validate1856.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1857(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SideQuestionText {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1857.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) < 1){validate1857.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data)){validate1857.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate1857.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validate1857.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1857.errors = null as any[] | null;
// prettier-ignore
validate1857.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link McpResourceListRequest}. */
export const validateMcpResourceListRequest: SchemaCheck<McpResourceListRequest> = validate1826;
/** Checks that a value is a {@link McpResourceListResponse}. */
export const validateMcpResourceListResponse: SchemaCheck<McpResourceListResponse> = validate1827;
/** Checks that a value is a {@link PermissionLevel}. */
export const validatePermissionLevel: SchemaCheck<PermissionLevel> = validate1828;
/** Checks that a value is a {@link ProviderTerminalSessionListResponse}. */
export const validateProviderTerminalSessionListResponse: SchemaCheck<ProviderTerminalSessionListResponse> =
  validate1829;
/** Checks that a value is a {@link SessionAcknowledgment}. */
export const validateSessionAcknowledgment: SchemaCheck<SessionAcknowledgment> = validate1834;
/** Checks that a value is a {@link SessionAddressedRequest}. */
export const validateSessionAddressedRequest: SchemaCheck<SessionAddressedRequest> = validate1835;
/** Checks that a value is a {@link SessionAutoCompactUpdateRequest}. */
export const validateSessionAutoCompactUpdateRequest: SchemaCheck<SessionAutoCompactUpdateRequest> =
  validate1836;
/** Checks that a value is a {@link SessionAutoCompactUpdateResponse}. */
export const validateSessionAutoCompactUpdateResponse: SchemaCheck<SessionAutoCompactUpdateResponse> =
  validate1837;
/** Checks that a value is a {@link SessionCodeReviewStartRequest}. */
export const validateSessionCodeReviewStartRequest: SchemaCheck<SessionCodeReviewStartRequest> =
  validate1838;
/** Checks that a value is a {@link SessionMaxStepsUpdateRequest}. */
export const validateSessionMaxStepsUpdateRequest: SchemaCheck<SessionMaxStepsUpdateRequest> =
  validate1839;
/** Checks that a value is a {@link SessionMaxStepsUpdateResponse}. */
export const validateSessionMaxStepsUpdateResponse: SchemaCheck<SessionMaxStepsUpdateResponse> =
  validate1840;
/** Checks that a value is a {@link SessionMcpServerEnabledUpdateRequest}. */
export const validateSessionMcpServerEnabledUpdateRequest: SchemaCheck<SessionMcpServerEnabledUpdateRequest> =
  validate1841;
/** Checks that a value is a {@link SessionMcpServerEnabledUpdateResponse}. */
export const validateSessionMcpServerEnabledUpdateResponse: SchemaCheck<SessionMcpServerEnabledUpdateResponse> =
  validate1842;
/** Checks that a value is a {@link SessionMcpServerList}. */
export const validateSessionMcpServerList: SchemaCheck<SessionMcpServerList> = validate1843;
/** Checks that a value is a {@link SessionModeUpdateRequest}. */
export const validateSessionModeUpdateRequest: SchemaCheck<SessionModeUpdateRequest> = validate1846;
/** Checks that a value is a {@link SessionModeUpdateResponse}. */
export const validateSessionModeUpdateResponse: SchemaCheck<SessionModeUpdateResponse> =
  validate1847;
/** Checks that a value is a {@link SessionPermissionLevelUpdateRequest}. */
export const validateSessionPermissionLevelUpdateRequest: SchemaCheck<SessionPermissionLevelUpdateRequest> =
  validate1848;
/** Checks that a value is a {@link SessionPermissionLevelUpdateResponse}. */
export const validateSessionPermissionLevelUpdateResponse: SchemaCheck<SessionPermissionLevelUpdateResponse> =
  validate1849;
/** Checks that a value is a {@link SessionProviderCommandList}. */
export const validateSessionProviderCommandList: SchemaCheck<SessionProviderCommandList> =
  validate1850;
/** Checks that a value is a {@link SessionSideQuestionAskRequest}. */
export const validateSessionSideQuestionAskRequest: SchemaCheck<SessionSideQuestionAskRequest> =
  validate1852;
/** Checks that a value is a {@link SessionSideQuestionAskResponse}. */
export const validateSessionSideQuestionAskResponse: SchemaCheck<SessionSideQuestionAskResponse> =
  validate1853;
/** Checks that a value is a {@link SessionSpendLimitUpdateRequest}. */
export const validateSessionSpendLimitUpdateRequest: SchemaCheck<SessionSpendLimitUpdateRequest> =
  validate1854;
/** Checks that a value is a {@link SessionTokensPerRunUpdateRequest}. */
export const validateSessionTokensPerRunUpdateRequest: SchemaCheck<SessionTokensPerRunUpdateRequest> =
  validate1855;
/** Checks that a value is a {@link SideQuestionId}. */
export const validateSideQuestionId: SchemaCheck<SideQuestionId> = validate1856;
/** Checks that a value is a {@link SideQuestionText}. */
export const validateSideQuestionText: SchemaCheck<SideQuestionText> = validate1857;

/** The methods of {@link SESSION_CONTROL_METHOD_DESCRIPTORS}, each with its checks. */
export interface SessionControlMethodDescriptors {
  readonly "session.permissionLevel.update": {
    readonly method: "session.permissionLevel.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionPermissionLevelUpdateRequest>;
    readonly responseCheck: SchemaCheck<SessionPermissionLevelUpdateResponse>;
  };
  readonly "session.mode.update": {
    readonly method: "session.mode.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionModeUpdateRequest>;
    readonly responseCheck: SchemaCheck<SessionModeUpdateResponse>;
  };
  readonly "session.autoCompact.update": {
    readonly method: "session.autoCompact.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionAutoCompactUpdateRequest>;
    readonly responseCheck: SchemaCheck<SessionAutoCompactUpdateResponse>;
  };
  readonly "session.mcpServer.subscribe": {
    readonly method: "session.mcpServer.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<SessionAddressedRequest>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<SessionMcpServerList>;
  };
  readonly "session.mcpServer.enabled.update": {
    readonly method: "session.mcpServer.enabled.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionMcpServerEnabledUpdateRequest>;
    readonly responseCheck: SchemaCheck<SessionMcpServerEnabledUpdateResponse>;
  };
  readonly "mcp.resource.list": {
    readonly method: "mcp.resource.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<McpResourceListRequest>;
    readonly responseCheck: SchemaCheck<McpResourceListResponse>;
  };
  readonly "session.providerCommand.subscribe": {
    readonly method: "session.providerCommand.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<SessionAddressedRequest>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<SessionProviderCommandList>;
  };
  readonly "session.sideQuestion.ask": {
    readonly method: "session.sideQuestion.ask";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionSideQuestionAskRequest>;
    readonly responseCheck: SchemaCheck<SessionSideQuestionAskResponse>;
  };
  readonly "session.codeReview.start": {
    readonly method: "session.codeReview.start";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionCodeReviewStartRequest>;
    readonly responseCheck: SchemaCheck<AgentQueueItemCreateResponse>;
  };
  readonly "session.definition.reload": {
    readonly method: "session.definition.reload";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionAddressedRequest>;
    readonly responseCheck: SchemaCheck<SessionAcknowledgment>;
  };
  readonly "session.maxSteps.update": {
    readonly method: "session.maxSteps.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionMaxStepsUpdateRequest>;
    readonly responseCheck: SchemaCheck<SessionMaxStepsUpdateResponse>;
  };
  readonly "session.spendLimit.update": {
    readonly method: "session.spendLimit.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionSpendLimitUpdateRequest>;
    readonly responseCheck: SchemaCheck<SessionBudgetState>;
  };
  readonly "session.tokensPerRun.update": {
    readonly method: "session.tokensPerRun.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionTokensPerRunUpdateRequest>;
    readonly responseCheck: SchemaCheck<SessionBudgetState>;
  };
  readonly "provider.terminalSession.list": {
    readonly method: "provider.terminalSession.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<ProviderTerminalSessionListResponse>;
  };
}
/** The session-control methods' wire contract: name, procedure type and types. */
export const SESSION_CONTROL_METHOD_DESCRIPTORS: SessionControlMethodDescriptors = Object.freeze({
  "session.permissionLevel.update": Object.freeze({
    method: "session.permissionLevel.update",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateSessionPermissionLevelUpdateRequest,
    responseCheck: validateSessionPermissionLevelUpdateResponse,
  }),
  "session.mode.update": Object.freeze({
    method: "session.mode.update",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateSessionModeUpdateRequest,
    responseCheck: validateSessionModeUpdateResponse,
  }),
  "session.autoCompact.update": Object.freeze({
    method: "session.autoCompact.update",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateSessionAutoCompactUpdateRequest,
    responseCheck: validateSessionAutoCompactUpdateResponse,
  }),
  "session.mcpServer.subscribe": Object.freeze({
    method: "session.mcpServer.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestCheck: validateSessionAddressedRequest,
    responseCheck: validateSubscribeAcknowledgmentResponse,
    emissionCheck: validateSessionMcpServerList,
  }),
  "session.mcpServer.enabled.update": Object.freeze({
    method: "session.mcpServer.enabled.update",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateSessionMcpServerEnabledUpdateRequest,
    responseCheck: validateSessionMcpServerEnabledUpdateResponse,
  }),
  "mcp.resource.list": Object.freeze({
    method: "mcp.resource.list",
    procedureType: "query",
    mutating: false,
    requestCheck: validateMcpResourceListRequest,
    responseCheck: validateMcpResourceListResponse,
  }),
  "session.providerCommand.subscribe": Object.freeze({
    method: "session.providerCommand.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestCheck: validateSessionAddressedRequest,
    responseCheck: validateSubscribeAcknowledgmentResponse,
    emissionCheck: validateSessionProviderCommandList,
  }),
  "session.sideQuestion.ask": Object.freeze({
    method: "session.sideQuestion.ask",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateSessionSideQuestionAskRequest,
    responseCheck: validateSessionSideQuestionAskResponse,
  }),
  "session.codeReview.start": Object.freeze({
    method: "session.codeReview.start",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateSessionCodeReviewStartRequest,
    responseCheck: validateAgentQueueItemCreateResponse,
  }),
  "session.definition.reload": Object.freeze({
    method: "session.definition.reload",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateSessionAddressedRequest,
    responseCheck: validateSessionAcknowledgment,
  }),
  "session.maxSteps.update": Object.freeze({
    method: "session.maxSteps.update",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateSessionMaxStepsUpdateRequest,
    responseCheck: validateSessionMaxStepsUpdateResponse,
  }),
  "session.spendLimit.update": Object.freeze({
    method: "session.spendLimit.update",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateSessionSpendLimitUpdateRequest,
    responseCheck: validateSessionBudgetState,
  }),
  "session.tokensPerRun.update": Object.freeze({
    method: "session.tokensPerRun.update",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateSessionTokensPerRunUpdateRequest,
    responseCheck: validateSessionBudgetState,
  }),
  "provider.terminalSession.list": Object.freeze({
    method: "provider.terminalSession.list",
    procedureType: "query",
    mutating: false,
    requestCheck: validateEmptyPayload,
    responseCheck: validateProviderTerminalSessionListResponse,
  }),
});
