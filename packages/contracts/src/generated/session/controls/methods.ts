// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A session's own controls and the reads behind its composer chips. Every method names the session it acts on, and every setting it changes belongs to that session alone.

import { type CompiledSchemaCheck, type SchemaCheck, ucs2length } from "../../../schema-check.js";
import {
  type SubscribeAcknowledgmentResponse,
  validateSubscribeAcknowledgmentResponse,
} from "../../jsonrpc/streaming.js";
import { type McpServerStatus, validateMcpServerStatus } from "../../mcp/server.js";
import { type EmptyPayload, validateEmptyPayload } from "../../method-descriptor.js";
import {
  type ProviderCommandEntry,
  validateProviderCommandEntry,
} from "../../provider/driver/commands.js";
import { type ProviderId, validateProviderId } from "../../provider/id.js";
import {
  type AgentQueueItemCreateResponse,
  validateAgentQueueItemCreateResponse,
} from "../../run/queue.js";
import {
  type SessionBudgetState,
  type TokensPerRun,
  type UsdMicros,
  validateSessionBudgetState,
  validateTokensPerRun,
  validateUsdMicros,
} from "../cost.js";
import { type SessionId, validateSessionId } from "../id.js";

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
   * Its title, where the server gives one.
   */
  title?: string;
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
   * Its title, where the server gives one.
   */
  title?: string;
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
const pattern3 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
/** Checks that a value is a {@link SessionAddressedRequest}. */
// prettier-ignore
export const validateSessionAddressedRequest: CompiledSchemaCheck<SessionAddressedRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionAddressedRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionAddressedRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validateSessionAddressedRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "sessionId")){validateSessionAddressedRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}}}}}else {validateSessionAddressedRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionAddressedRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionAddressedRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionAcknowledgment}. */
// prettier-ignore
export const validateSessionAcknowledgment: CompiledSchemaCheck<SessionAcknowledgment> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionAcknowledgment {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionAcknowledgment.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validateSessionAcknowledgment.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "sessionId")){validateSessionAcknowledgment.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}}}}}else {validateSessionAcknowledgment.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionAcknowledgment.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionAcknowledgment.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema441: any = {"description":"The five permission levels, most careful first, the same five words on every provider. Only\nthe first three ever ask the person; at `sandboxed` and `yolo` the daemon answers every ask\nitself. Plan is not a level: it is the session's mode.","type":"string","enum":["readonly","ask","reviewed","sandboxed","yolo"]};
/** Checks that a value is a {@link PermissionLevel}. */
// prettier-ignore
export const validatePermissionLevel: CompiledSchemaCheck<PermissionLevel> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PermissionLevel {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePermissionLevel.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validatePermissionLevel.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((((data === "readonly") || (data === "ask")) || (data === "reviewed")) || (data === "sandboxed")) || (data === "yolo"))){validatePermissionLevel.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema441.enum}}];return false;}validatePermissionLevel.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePermissionLevel.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionPermissionLevelUpdateRequest}. */
// prettier-ignore
export const validateSessionPermissionLevelUpdateRequest: CompiledSchemaCheck<SessionPermissionLevelUpdateRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionPermissionLevelUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionPermissionLevelUpdateRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.level === undefined) && (missing0 = "level"))){validateSessionPermissionLevelUpdateRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "level"))){validateSessionPermissionLevelUpdateRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.level !== undefined){const _errs3: any = errors;if(!(validatePermissionLevel.call(this, data.level, {instancePath:instancePath+"/level",parentData:data,parentDataProperty:"level",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePermissionLevel.errors : vErrors.concat(validatePermissionLevel.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateSessionPermissionLevelUpdateRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionPermissionLevelUpdateRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionPermissionLevelUpdateRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionPermissionLevelUpdateResponse}. */
// prettier-ignore
export const validateSessionPermissionLevelUpdateResponse: CompiledSchemaCheck<SessionPermissionLevelUpdateResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionPermissionLevelUpdateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionPermissionLevelUpdateResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.level === undefined) && (missing0 = "level"))){validateSessionPermissionLevelUpdateResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "level"))){validateSessionPermissionLevelUpdateResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.level !== undefined){const _errs3: any = errors;if(!(validatePermissionLevel.call(this, data.level, {instancePath:instancePath+"/level",parentData:data,parentDataProperty:"level",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePermissionLevel.errors : vErrors.concat(validatePermissionLevel.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateSessionPermissionLevelUpdateResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionPermissionLevelUpdateResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionPermissionLevelUpdateResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema442: any = {"description":"Whether the session's next turns plan or build: the composer's mode control.","type":"string","enum":["build","plan"]};
/** Checks that a value is a {@link SessionMode}. */
// prettier-ignore
export const validateSessionMode: CompiledSchemaCheck<SessionMode> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionMode {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionMode.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateSessionMode.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data === "build") || (data === "plan"))){validateSessionMode.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema442.enum}}];return false;}validateSessionMode.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionMode.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionModeUpdateRequest}. */
// prettier-ignore
export const validateSessionModeUpdateRequest: CompiledSchemaCheck<SessionModeUpdateRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionModeUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionModeUpdateRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.mode === undefined) && (missing0 = "mode"))){validateSessionModeUpdateRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "mode"))){validateSessionModeUpdateRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.mode !== undefined){const _errs3: any = errors;if(!(validateSessionMode.call(this, data.mode, {instancePath:instancePath+"/mode",parentData:data,parentDataProperty:"mode",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionMode.errors : vErrors.concat(validateSessionMode.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateSessionModeUpdateRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionModeUpdateRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionModeUpdateRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionModeUpdateResponse}. */
// prettier-ignore
export const validateSessionModeUpdateResponse: CompiledSchemaCheck<SessionModeUpdateResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionModeUpdateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionModeUpdateResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.mode === undefined) && (missing0 = "mode"))){validateSessionModeUpdateResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "mode"))){validateSessionModeUpdateResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.mode !== undefined){const _errs3: any = errors;if(!(validateSessionMode.call(this, data.mode, {instancePath:instancePath+"/mode",parentData:data,parentDataProperty:"mode",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionMode.errors : vErrors.concat(validateSessionMode.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateSessionModeUpdateResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionModeUpdateResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionModeUpdateResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1140: any = {"type":"object","additionalProperties":false,"properties":{"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"percent":{"type":["number","null"],"exclusiveMinimum":0,"maximum":100,"description":"The bound, or `null` for the Settings default."}},"required":["sessionId","percent"],"description":"Sets this session's own auto-compact bound from its next turn, as a percent of the window;\n`null` returns the session to the Settings default. The accepted range comes from the provider's\nlive figures, so the daemon refuses a percent outside it; the type bounds only a percent."};
/** Checks that a value is a {@link SessionAutoCompactUpdateRequest}. */
// prettier-ignore
export const validateSessionAutoCompactUpdateRequest: CompiledSchemaCheck<SessionAutoCompactUpdateRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionAutoCompactUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionAutoCompactUpdateRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.percent === undefined) && (missing0 = "percent"))){validateSessionAutoCompactUpdateRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "percent"))){validateSessionAutoCompactUpdateRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.percent !== undefined){let data1: any = data.percent;const _errs3: any = errors;if((!((typeof data1 == "number") && (isFinite(data1)))) && (data1 !== null)){validateSessionAutoCompactUpdateRequest.errors = [{instancePath:instancePath+"/percent",schemaPath:"#/properties/percent/type",keyword:"type",params:{type: schema1140.properties.percent.type}}];return false;}if(errors === _errs3){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 100 || isNaN(data1)){validateSessionAutoCompactUpdateRequest.errors = [{instancePath:instancePath+"/percent",schemaPath:"#/properties/percent/maximum",keyword:"maximum",params:{comparison: "<=", limit: 100}}];return false;}else {if(data1 <= 0 || isNaN(data1)){validateSessionAutoCompactUpdateRequest.errors = [{instancePath:instancePath+"/percent",schemaPath:"#/properties/percent/exclusiveMinimum",keyword:"exclusiveMinimum",params:{comparison: ">", limit: 0}}];return false;}}}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateSessionAutoCompactUpdateRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionAutoCompactUpdateRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionAutoCompactUpdateRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionAutoCompactUpdateResponse}. */
// prettier-ignore
export const validateSessionAutoCompactUpdateResponse: CompiledSchemaCheck<SessionAutoCompactUpdateResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionAutoCompactUpdateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionAutoCompactUpdateResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.percent === undefined) && (missing0 = "percent"))) || ((data.sessionOverride === undefined) && (missing0 = "sessionOverride"))){validateSessionAutoCompactUpdateResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "percent")) || (key0 === "sessionOverride"))){validateSessionAutoCompactUpdateResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.percent !== undefined){let data1: any = data.percent;const _errs3: any = errors;if(errors === _errs3){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 100 || isNaN(data1)){validateSessionAutoCompactUpdateResponse.errors = [{instancePath:instancePath+"/percent",schemaPath:"#/properties/percent/maximum",keyword:"maximum",params:{comparison: "<=", limit: 100}}];return false;}else {if(data1 <= 0 || isNaN(data1)){validateSessionAutoCompactUpdateResponse.errors = [{instancePath:instancePath+"/percent",schemaPath:"#/properties/percent/exclusiveMinimum",keyword:"exclusiveMinimum",params:{comparison: ">", limit: 0}}];return false;}}}else {validateSessionAutoCompactUpdateResponse.errors = [{instancePath:instancePath+"/percent",schemaPath:"#/properties/percent/type",keyword:"type",params:{type: "number"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.sessionOverride !== undefined){const _errs5: any = errors;if(typeof data.sessionOverride !== "boolean"){validateSessionAutoCompactUpdateResponse.errors = [{instancePath:instancePath+"/sessionOverride",schemaPath:"#/properties/sessionOverride/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}}else {validateSessionAutoCompactUpdateResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionAutoCompactUpdateResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionAutoCompactUpdateResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern5 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
/** Checks that a value is a {@link SessionMcpServer}. */
// prettier-ignore
export const validateSessionMcpServer: CompiledSchemaCheck<SessionMcpServer> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionMcpServer {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionMcpServer.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.serverName === undefined) && (missing0 = "serverName")) || ((data.status === undefined) && (missing0 = "status"))) || ((data.enabled === undefined) && (missing0 = "enabled"))) || ((data.pendingUntilNextTurn === undefined) && (missing0 = "pendingUntilNextTurn"))){validateSessionMcpServer.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "serverName") || (key0 === "status")) || (key0 === "reason")) || (key0 === "enabled")) || (key0 === "pendingUntilNextTurn"))){validateSessionMcpServer.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.serverName !== undefined){let data0: any = data.serverName;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 128){validateSessionMcpServer.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data0) < 1){validateSessionMcpServer.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data0)){validateSessionMcpServer.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateSessionMcpServer.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.status !== undefined){const _errs4: any = errors;if(!(validateMcpServerStatus.call(this, data.status, {instancePath:instancePath+"/status",parentData:data,parentDataProperty:"status",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateMcpServerStatus.errors : vErrors.concat(validateMcpServerStatus.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.reason !== undefined){let data2: any = data.reason;const _errs5: any = errors;if(errors === _errs5){if(typeof data2 === "string"){if(func1(data2) < 1){validateSessionMcpServer.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/properties/reason/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateSessionMcpServer.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.enabled !== undefined){const _errs7: any = errors;if(typeof data.enabled !== "boolean"){validateSessionMcpServer.errors = [{instancePath:instancePath+"/enabled",schemaPath:"#/properties/enabled/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.pendingUntilNextTurn !== undefined){const _errs9: any = errors;if(typeof data.pendingUntilNextTurn !== "boolean"){validateSessionMcpServer.errors = [{instancePath:instancePath+"/pendingUntilNextTurn",schemaPath:"#/properties/pendingUntilNextTurn/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}}}}}}}}else {validateSessionMcpServer.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionMcpServer.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionMcpServer.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionMcpServerList}. */
// prettier-ignore
export const validateSessionMcpServerList: CompiledSchemaCheck<SessionMcpServerList> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionMcpServerList {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionMcpServerList.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.servers === undefined) && (missing0 = "servers"))){validateSessionMcpServerList.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "servers"))){validateSessionMcpServerList.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.servers !== undefined){let data1: any = data.servers;const _errs3: any = errors;if(errors === _errs3){if(Array.isArray(data1)){var valid1: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){const _errs5: any = errors;if(!(validateSessionMcpServer.call(this, data1[i0], {instancePath:instancePath+"/servers/" + i0,parentData:data1,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionMcpServer.errors : vErrors.concat(validateSessionMcpServer.errors);errors = vErrors.length;}var valid1: any = _errs5 === errors;if(!valid1){break;}}}else {validateSessionMcpServerList.errors = [{instancePath:instancePath+"/servers",schemaPath:"#/properties/servers/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateSessionMcpServerList.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionMcpServerList.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionMcpServerList.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionMcpServerEnabledUpdateRequest}. */
// prettier-ignore
export const validateSessionMcpServerEnabledUpdateRequest: CompiledSchemaCheck<SessionMcpServerEnabledUpdateRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionMcpServerEnabledUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionMcpServerEnabledUpdateRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.serverName === undefined) && (missing0 = "serverName"))) || ((data.enabled === undefined) && (missing0 = "enabled"))){validateSessionMcpServerEnabledUpdateRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "serverName")) || (key0 === "enabled"))){validateSessionMcpServerEnabledUpdateRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.serverName !== undefined){let data1: any = data.serverName;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 128){validateSessionMcpServerEnabledUpdateRequest.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data1) < 1){validateSessionMcpServerEnabledUpdateRequest.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data1)){validateSessionMcpServerEnabledUpdateRequest.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateSessionMcpServerEnabledUpdateRequest.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.enabled !== undefined){const _errs5: any = errors;if(typeof data.enabled !== "boolean"){validateSessionMcpServerEnabledUpdateRequest.errors = [{instancePath:instancePath+"/enabled",schemaPath:"#/properties/enabled/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}}else {validateSessionMcpServerEnabledUpdateRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionMcpServerEnabledUpdateRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionMcpServerEnabledUpdateRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionMcpServerEnabledUpdateResponse}. */
// prettier-ignore
export const validateSessionMcpServerEnabledUpdateResponse: CompiledSchemaCheck<SessionMcpServerEnabledUpdateResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionMcpServerEnabledUpdateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionMcpServerEnabledUpdateResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.serverName === undefined) && (missing0 = "serverName"))) || ((data.enabled === undefined) && (missing0 = "enabled"))){validateSessionMcpServerEnabledUpdateResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "serverName")) || (key0 === "enabled"))){validateSessionMcpServerEnabledUpdateResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.serverName !== undefined){let data1: any = data.serverName;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 128){validateSessionMcpServerEnabledUpdateResponse.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data1) < 1){validateSessionMcpServerEnabledUpdateResponse.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data1)){validateSessionMcpServerEnabledUpdateResponse.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateSessionMcpServerEnabledUpdateResponse.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.enabled !== undefined){const _errs5: any = errors;if(typeof data.enabled !== "boolean"){validateSessionMcpServerEnabledUpdateResponse.errors = [{instancePath:instancePath+"/enabled",schemaPath:"#/properties/enabled/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}}else {validateSessionMcpServerEnabledUpdateResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionMcpServerEnabledUpdateResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionMcpServerEnabledUpdateResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link McpResourceListRequest}. */
// prettier-ignore
export const validateMcpResourceListRequest: CompiledSchemaCheck<McpResourceListRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is McpResourceListRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateMcpResourceListRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.serverName === undefined) && (missing0 = "serverName"))){validateMcpResourceListRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "serverName"))){validateMcpResourceListRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.serverName !== undefined){let data1: any = data.serverName;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 128){validateMcpResourceListRequest.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data1) < 1){validateMcpResourceListRequest.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data1)){validateMcpResourceListRequest.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateMcpResourceListRequest.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateMcpResourceListRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateMcpResourceListRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateMcpResourceListRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionMcpResource}. */
// prettier-ignore
export const validateSessionMcpResource: CompiledSchemaCheck<SessionMcpResource> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionMcpResource {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionMcpResource.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.uri === undefined) && (missing0 = "uri")) || ((data.name === undefined) && (missing0 = "name"))){validateSessionMcpResource.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((key0 === "uri") || (key0 === "name")) || (key0 === "title")) || (key0 === "description")) || (key0 === "mimeType")) || (key0 === "size"))){validateSessionMcpResource.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.uri !== undefined){let data0: any = data.uri;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) < 1){validateSessionMcpResource.errors = [{instancePath:instancePath+"/uri",schemaPath:"#/properties/uri/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateSessionMcpResource.errors = [{instancePath:instancePath+"/uri",schemaPath:"#/properties/uri/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data1: any = data.name;const _errs4: any = errors;if(errors === _errs4){if(typeof data1 === "string"){if(func1(data1) < 1){validateSessionMcpResource.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateSessionMcpResource.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.title !== undefined){let data2: any = data.title;const _errs6: any = errors;if(errors === _errs6){if(typeof data2 === "string"){if(func1(data2) < 1){validateSessionMcpResource.errors = [{instancePath:instancePath+"/title",schemaPath:"#/properties/title/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateSessionMcpResource.errors = [{instancePath:instancePath+"/title",schemaPath:"#/properties/title/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.description !== undefined){let data3: any = data.description;const _errs8: any = errors;if(errors === _errs8){if(typeof data3 === "string"){if(func1(data3) < 1){validateSessionMcpResource.errors = [{instancePath:instancePath+"/description",schemaPath:"#/properties/description/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateSessionMcpResource.errors = [{instancePath:instancePath+"/description",schemaPath:"#/properties/description/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.mimeType !== undefined){let data4: any = data.mimeType;const _errs10: any = errors;if(errors === _errs10){if(typeof data4 === "string"){if(func1(data4) < 1){validateSessionMcpResource.errors = [{instancePath:instancePath+"/mimeType",schemaPath:"#/properties/mimeType/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateSessionMcpResource.errors = [{instancePath:instancePath+"/mimeType",schemaPath:"#/properties/mimeType/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.size !== undefined){let data5: any = data.size;const _errs12: any = errors;if(!(((typeof data5 == "number") && (!(data5 % 1) && !isNaN(data5))) && (isFinite(data5)))){validateSessionMcpResource.errors = [{instancePath:instancePath+"/size",schemaPath:"#/properties/size/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs12){if((typeof data5 == "number") && (isFinite(data5))){if(data5 > 9007199254740991 || isNaN(data5)){validateSessionMcpResource.errors = [{instancePath:instancePath+"/size",schemaPath:"#/properties/size/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data5 < 0 || isNaN(data5)){validateSessionMcpResource.errors = [{instancePath:instancePath+"/size",schemaPath:"#/properties/size/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}}}}}}}}}else {validateSessionMcpResource.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionMcpResource.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionMcpResource.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link McpResourceListResponse}. */
// prettier-ignore
export const validateMcpResourceListResponse: CompiledSchemaCheck<McpResourceListResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is McpResourceListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateMcpResourceListResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.serverName === undefined) && (missing0 = "serverName"))) || ((data.resources === undefined) && (missing0 = "resources"))) || ((data.complete === undefined) && (missing0 = "complete"))){validateMcpResourceListResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "sessionId") || (key0 === "serverName")) || (key0 === "resources")) || (key0 === "complete"))){validateMcpResourceListResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.serverName !== undefined){let data1: any = data.serverName;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 128){validateMcpResourceListResponse.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data1) < 1){validateMcpResourceListResponse.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data1)){validateMcpResourceListResponse.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateMcpResourceListResponse.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.resources !== undefined){let data2: any = data.resources;const _errs5: any = errors;if(errors === _errs5){if(Array.isArray(data2)){var valid1: any = true;const len0: any = data2.length;for(let i0=0; i0<len0; i0++){const _errs7: any = errors;if(!(validateSessionMcpResource.call(this, data2[i0], {instancePath:instancePath+"/resources/" + i0,parentData:data2,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionMcpResource.errors : vErrors.concat(validateSessionMcpResource.errors);errors = vErrors.length;}var valid1: any = _errs7 === errors;if(!valid1){break;}}}else {validateMcpResourceListResponse.errors = [{instancePath:instancePath+"/resources",schemaPath:"#/properties/resources/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.complete !== undefined){const _errs8: any = errors;if(typeof data.complete !== "boolean"){validateMcpResourceListResponse.errors = [{instancePath:instancePath+"/complete",schemaPath:"#/properties/complete/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}}}}}}}else {validateMcpResourceListResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateMcpResourceListResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateMcpResourceListResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionServerPrompt}. */
// prettier-ignore
export const validateSessionServerPrompt: CompiledSchemaCheck<SessionServerPrompt> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionServerPrompt {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionServerPrompt.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.serverName === undefined) && (missing0 = "serverName")) || ((data.name === undefined) && (missing0 = "name"))){validateSessionServerPrompt.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "serverName") || (key0 === "name")) || (key0 === "title")) || (key0 === "description"))){validateSessionServerPrompt.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.serverName !== undefined){let data0: any = data.serverName;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 128){validateSessionServerPrompt.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data0) < 1){validateSessionServerPrompt.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data0)){validateSessionServerPrompt.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateSessionServerPrompt.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data1: any = data.name;const _errs4: any = errors;if(errors === _errs4){if(typeof data1 === "string"){if(func1(data1) < 1){validateSessionServerPrompt.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateSessionServerPrompt.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.title !== undefined){let data2: any = data.title;const _errs6: any = errors;if(errors === _errs6){if(typeof data2 === "string"){if(func1(data2) < 1){validateSessionServerPrompt.errors = [{instancePath:instancePath+"/title",schemaPath:"#/properties/title/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateSessionServerPrompt.errors = [{instancePath:instancePath+"/title",schemaPath:"#/properties/title/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.description !== undefined){let data3: any = data.description;const _errs8: any = errors;if(errors === _errs8){if(typeof data3 === "string"){if(func1(data3) < 1){validateSessionServerPrompt.errors = [{instancePath:instancePath+"/description",schemaPath:"#/properties/description/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateSessionServerPrompt.errors = [{instancePath:instancePath+"/description",schemaPath:"#/properties/description/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}}}}}}}else {validateSessionServerPrompt.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionServerPrompt.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionServerPrompt.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionProviderCommandList}. */
// prettier-ignore
export const validateSessionProviderCommandList: CompiledSchemaCheck<SessionProviderCommandList> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionProviderCommandList {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionProviderCommandList.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.commands === undefined) && (missing0 = "commands"))) || ((data.serverPrompts === undefined) && (missing0 = "serverPrompts"))){validateSessionProviderCommandList.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "commands")) || (key0 === "serverPrompts"))){validateSessionProviderCommandList.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.commands !== undefined){let data1: any = data.commands;const _errs3: any = errors;if(errors === _errs3){if(Array.isArray(data1)){var valid1: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){const _errs5: any = errors;if(!(validateProviderCommandEntry.call(this, data1[i0], {instancePath:instancePath+"/commands/" + i0,parentData:data1,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderCommandEntry.errors : vErrors.concat(validateProviderCommandEntry.errors);errors = vErrors.length;}var valid1: any = _errs5 === errors;if(!valid1){break;}}}else {validateSessionProviderCommandList.errors = [{instancePath:instancePath+"/commands",schemaPath:"#/properties/commands/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.serverPrompts !== undefined){let data3: any = data.serverPrompts;const _errs6: any = errors;if(errors === _errs6){if(Array.isArray(data3)){var valid2: any = true;const len1: any = data3.length;for(let i1=0; i1<len1; i1++){const _errs8: any = errors;if(!(validateSessionServerPrompt.call(this, data3[i1], {instancePath:instancePath+"/serverPrompts/" + i1,parentData:data3,parentDataProperty:i1,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionServerPrompt.errors : vErrors.concat(validateSessionServerPrompt.errors);errors = vErrors.length;}var valid2: any = _errs8 === errors;if(!valid2){break;}}}else {validateSessionProviderCommandList.errors = [{instancePath:instancePath+"/serverPrompts",schemaPath:"#/properties/serverPrompts/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}else {validateSessionProviderCommandList.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionProviderCommandList.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionProviderCommandList.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SideQuestionId}. */
// prettier-ignore
export const validateSideQuestionId: CompiledSchemaCheck<SideQuestionId> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SideQuestionId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSideQuestionId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern3.test(data)){validateSideQuestionId.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validateSideQuestionId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateSideQuestionId.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSideQuestionId.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SideQuestionText}. */
// prettier-ignore
export const validateSideQuestionText: CompiledSchemaCheck<SideQuestionText> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SideQuestionText {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSideQuestionText.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) < 1){validateSideQuestionText.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data)){validateSideQuestionText.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validateSideQuestionText.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateSideQuestionText.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSideQuestionText.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionSideQuestionAskRequest}. */
// prettier-ignore
export const validateSessionSideQuestionAskRequest: CompiledSchemaCheck<SessionSideQuestionAskRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionSideQuestionAskRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionSideQuestionAskRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.question === undefined) && (missing0 = "question"))){validateSessionSideQuestionAskRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "question"))){validateSessionSideQuestionAskRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.question !== undefined){const _errs3: any = errors;if(!(validateSideQuestionText.call(this, data.question, {instancePath:instancePath+"/question",parentData:data,parentDataProperty:"question",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSideQuestionText.errors : vErrors.concat(validateSideQuestionText.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateSessionSideQuestionAskRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionSideQuestionAskRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionSideQuestionAskRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionSideQuestionAskResponse}. */
// prettier-ignore
export const validateSessionSideQuestionAskResponse: CompiledSchemaCheck<SessionSideQuestionAskResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionSideQuestionAskResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionSideQuestionAskResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.sideQuestionId === undefined) && (missing0 = "sideQuestionId"))){validateSessionSideQuestionAskResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "sideQuestionId"))){validateSessionSideQuestionAskResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.sideQuestionId !== undefined){const _errs3: any = errors;if(!(validateSideQuestionId.call(this, data.sideQuestionId, {instancePath:instancePath+"/sideQuestionId",parentData:data,parentDataProperty:"sideQuestionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSideQuestionId.errors : vErrors.concat(validateSideQuestionId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateSessionSideQuestionAskResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionSideQuestionAskResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionSideQuestionAskResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema439: any = {"description":"What a review covers: the working tree, the staged set, or the branch against its base.","type":"string","enum":["workingTree","staged","branch"]};
/** Checks that a value is a {@link SessionReviewTarget}. */
// prettier-ignore
export const validateSessionReviewTarget: CompiledSchemaCheck<SessionReviewTarget> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionReviewTarget {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionReviewTarget.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateSessionReviewTarget.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data === "workingTree") || (data === "staged")) || (data === "branch"))){validateSessionReviewTarget.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema439.enum}}];return false;}validateSessionReviewTarget.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionReviewTarget.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern88 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$", "u");
/** Checks that a value is a {@link SessionCodeReviewStartRequest}. */
// prettier-ignore
export const validateSessionCodeReviewStartRequest: CompiledSchemaCheck<SessionCodeReviewStartRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionCodeReviewStartRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionCodeReviewStartRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.clientIdempotencyKey === undefined) && (missing0 = "clientIdempotencyKey"))) || ((data.target === undefined) && (missing0 = "target"))){validateSessionCodeReviewStartRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "clientIdempotencyKey")) || (key0 === "target"))){validateSessionCodeReviewStartRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.clientIdempotencyKey !== undefined){let data1: any = data.clientIdempotencyKey;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(!pattern88.test(data1)){validateSessionCodeReviewStartRequest.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}}];return false;}}else {validateSessionCodeReviewStartRequest.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.target !== undefined){const _errs5: any = errors;if(!(validateSessionReviewTarget.call(this, data.target, {instancePath:instancePath+"/target",parentData:data,parentDataProperty:"target",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionReviewTarget.errors : vErrors.concat(validateSessionReviewTarget.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}}else {validateSessionCodeReviewStartRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionCodeReviewStartRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionCodeReviewStartRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1143: any = {"type":"object","additionalProperties":false,"properties":{"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"maxStepsPerTurn":{"type":["integer","null"],"minimum":1,"maximum":9007199254740991,"description":"The bound, or `null` for the machine's own value."}},"required":["sessionId","maxStepsPerTurn"],"description":"Sets or clears this session's own bound on how many steps one turn may take, from its next\nturn. `null` returns the session to the machine's own value; a bound below one is refused."};
/** Checks that a value is a {@link SessionMaxStepsUpdateRequest}. */
// prettier-ignore
export const validateSessionMaxStepsUpdateRequest: CompiledSchemaCheck<SessionMaxStepsUpdateRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionMaxStepsUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionMaxStepsUpdateRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.maxStepsPerTurn === undefined) && (missing0 = "maxStepsPerTurn"))){validateSessionMaxStepsUpdateRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "maxStepsPerTurn"))){validateSessionMaxStepsUpdateRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.maxStepsPerTurn !== undefined){let data1: any = data.maxStepsPerTurn;const _errs3: any = errors;if((!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))) && (data1 !== null)){validateSessionMaxStepsUpdateRequest.errors = [{instancePath:instancePath+"/maxStepsPerTurn",schemaPath:"#/properties/maxStepsPerTurn/type",keyword:"type",params:{type: schema1143.properties.maxStepsPerTurn.type}}];return false;}if(errors === _errs3){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validateSessionMaxStepsUpdateRequest.errors = [{instancePath:instancePath+"/maxStepsPerTurn",schemaPath:"#/properties/maxStepsPerTurn/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 1 || isNaN(data1)){validateSessionMaxStepsUpdateRequest.errors = [{instancePath:instancePath+"/maxStepsPerTurn",schemaPath:"#/properties/maxStepsPerTurn/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateSessionMaxStepsUpdateRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionMaxStepsUpdateRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionMaxStepsUpdateRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionMaxStepsUpdateResponse}. */
// prettier-ignore
export const validateSessionMaxStepsUpdateResponse: CompiledSchemaCheck<SessionMaxStepsUpdateResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionMaxStepsUpdateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionMaxStepsUpdateResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validateSessionMaxStepsUpdateResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "maxStepsPerTurn"))){validateSessionMaxStepsUpdateResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.maxStepsPerTurn !== undefined){let data1: any = data.maxStepsPerTurn;const _errs3: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validateSessionMaxStepsUpdateResponse.errors = [{instancePath:instancePath+"/maxStepsPerTurn",schemaPath:"#/properties/maxStepsPerTurn/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs3){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validateSessionMaxStepsUpdateResponse.errors = [{instancePath:instancePath+"/maxStepsPerTurn",schemaPath:"#/properties/maxStepsPerTurn/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 1 || isNaN(data1)){validateSessionMaxStepsUpdateResponse.errors = [{instancePath:instancePath+"/maxStepsPerTurn",schemaPath:"#/properties/maxStepsPerTurn/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateSessionMaxStepsUpdateResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionMaxStepsUpdateResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionMaxStepsUpdateResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionSpendLimitUpdateRequest}. */
// prettier-ignore
export const validateSessionSpendLimitUpdateRequest: CompiledSchemaCheck<SessionSpendLimitUpdateRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionSpendLimitUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionSpendLimitUpdateRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.spendLimitUsdMicros === undefined) && (missing0 = "spendLimitUsdMicros"))){validateSessionSpendLimitUpdateRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "spendLimitUsdMicros"))){validateSessionSpendLimitUpdateRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.spendLimitUsdMicros !== undefined){let data1: any = data.spendLimitUsdMicros;const _errs3: any = errors;const _errs4: any = errors;let valid1: any = false;const _errs5: any = errors;if(!(validateUsdMicros.call(this, data1, {instancePath:instancePath+"/spendLimitUsdMicros",parentData:data,parentDataProperty:"spendLimitUsdMicros",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateUsdMicros.errors : vErrors.concat(validateUsdMicros.errors);errors = vErrors.length;}var _valid0: any = _errs5 === errors;valid1 = valid1 || _valid0;const _errs6: any = errors;if(data1 !== null){const err0: any = {instancePath:instancePath+"/spendLimitUsdMicros",schemaPath:"#/properties/spendLimitUsdMicros/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var _valid0: any = _errs6 === errors;valid1 = valid1 || _valid0;if(!valid1){const err1: any = {instancePath:instancePath+"/spendLimitUsdMicros",schemaPath:"#/properties/spendLimitUsdMicros/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;validateSessionSpendLimitUpdateRequest.errors = vErrors;return false;}else {errors = _errs4;if(vErrors !== null){if(_errs4){vErrors.length = _errs4;}else {vErrors = null;}}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateSessionSpendLimitUpdateRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionSpendLimitUpdateRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionSpendLimitUpdateRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionTokensPerRunUpdateRequest}. */
// prettier-ignore
export const validateSessionTokensPerRunUpdateRequest: CompiledSchemaCheck<SessionTokensPerRunUpdateRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionTokensPerRunUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionTokensPerRunUpdateRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.tokensPerRun === undefined) && (missing0 = "tokensPerRun"))){validateSessionTokensPerRunUpdateRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "tokensPerRun"))){validateSessionTokensPerRunUpdateRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.tokensPerRun !== undefined){let data1: any = data.tokensPerRun;const _errs3: any = errors;const _errs4: any = errors;let valid1: any = false;const _errs5: any = errors;if(!(validateTokensPerRun.call(this, data1, {instancePath:instancePath+"/tokensPerRun",parentData:data,parentDataProperty:"tokensPerRun",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTokensPerRun.errors : vErrors.concat(validateTokensPerRun.errors);errors = vErrors.length;}var _valid0: any = _errs5 === errors;valid1 = valid1 || _valid0;const _errs6: any = errors;if(data1 !== null){const err0: any = {instancePath:instancePath+"/tokensPerRun",schemaPath:"#/properties/tokensPerRun/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var _valid0: any = _errs6 === errors;valid1 = valid1 || _valid0;if(!valid1){const err1: any = {instancePath:instancePath+"/tokensPerRun",schemaPath:"#/properties/tokensPerRun/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;validateSessionTokensPerRunUpdateRequest.errors = vErrors;return false;}else {errors = _errs4;if(vErrors !== null){if(_errs4){vErrors.length = _errs4;}else {vErrors = null;}}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateSessionTokensPerRunUpdateRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionTokensPerRunUpdateRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionTokensPerRunUpdateRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1136: any = {"description":"Where a provider session typed in a terminal stands.","type":"string","enum":["working","idle","unreachable"]};
/** Checks that a value is a {@link TerminalProviderSessionState}. */
// prettier-ignore
export const validateTerminalProviderSessionState: CompiledSchemaCheck<TerminalProviderSessionState> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalProviderSessionState {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateTerminalProviderSessionState.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateTerminalProviderSessionState.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data === "working") || (data === "idle")) || (data === "unreachable"))){validateTerminalProviderSessionState.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1136.enum}}];return false;}validateTerminalProviderSessionState.errors = vErrors;return errors === 0;};
// prettier-ignore
validateTerminalProviderSessionState.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link TerminalProviderSession}. */
// prettier-ignore
export const validateTerminalProviderSession: CompiledSchemaCheck<TerminalProviderSession> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalProviderSession {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateTerminalProviderSession.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.provider === undefined) && (missing0 = "provider")) || ((data.name === undefined) && (missing0 = "name"))) || ((data.threadId === undefined) && (missing0 = "threadId"))) || ((data.state === undefined) && (missing0 = "state"))){validateTerminalProviderSession.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "provider") || (key0 === "name")) || (key0 === "threadId")) || (key0 === "state"))){validateTerminalProviderSession.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.provider !== undefined){const _errs2: any = errors;if(!(validateProviderId.call(this, data.provider, {instancePath:instancePath+"/provider",parentData:data,parentDataProperty:"provider",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderId.errors : vErrors.concat(validateProviderId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data1: any = data.name;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) < 1){validateTerminalProviderSession.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateTerminalProviderSession.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.threadId !== undefined){let data2: any = data.threadId;const _errs5: any = errors;if(errors === _errs5){if(typeof data2 === "string"){if(func1(data2) < 1){validateTerminalProviderSession.errors = [{instancePath:instancePath+"/threadId",schemaPath:"#/properties/threadId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateTerminalProviderSession.errors = [{instancePath:instancePath+"/threadId",schemaPath:"#/properties/threadId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){const _errs7: any = errors;if(!(validateTerminalProviderSessionState.call(this, data.state, {instancePath:instancePath+"/state",parentData:data,parentDataProperty:"state",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTerminalProviderSessionState.errors : vErrors.concat(validateTerminalProviderSessionState.errors);errors = vErrors.length;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}}}}}}}else {validateTerminalProviderSession.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateTerminalProviderSession.errors = vErrors;return errors === 0;};
// prettier-ignore
validateTerminalProviderSession.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link TerminalSessionProvider}. */
// prettier-ignore
export const validateTerminalSessionProvider: CompiledSchemaCheck<TerminalSessionProvider> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalSessionProvider {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateTerminalSessionProvider.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.provider === undefined) && (missing0 = "provider")) || ((data.name === undefined) && (missing0 = "name"))) || ((data.resumeCommand === undefined) && (missing0 = "resumeCommand"))){validateTerminalSessionProvider.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "provider") || (key0 === "name")) || (key0 === "resumeCommand"))){validateTerminalSessionProvider.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.provider !== undefined){const _errs2: any = errors;if(!(validateProviderId.call(this, data.provider, {instancePath:instancePath+"/provider",parentData:data,parentDataProperty:"provider",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderId.errors : vErrors.concat(validateProviderId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data1: any = data.name;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 512){validateTerminalSessionProvider.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/maxLength",keyword:"maxLength",params:{limit: 512}}];return false;}else {if(func1(data1) < 1){validateTerminalSessionProvider.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data1)){validateTerminalSessionProvider.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateTerminalSessionProvider.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.resumeCommand !== undefined){let data2: any = data.resumeCommand;const _errs5: any = errors;if(errors === _errs5){if(typeof data2 === "string"){if(func1(data2) > 512){validateTerminalSessionProvider.errors = [{instancePath:instancePath+"/resumeCommand",schemaPath:"#/properties/resumeCommand/maxLength",keyword:"maxLength",params:{limit: 512}}];return false;}else {if(func1(data2) < 1){validateTerminalSessionProvider.errors = [{instancePath:instancePath+"/resumeCommand",schemaPath:"#/properties/resumeCommand/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data2)){validateTerminalSessionProvider.errors = [{instancePath:instancePath+"/resumeCommand",schemaPath:"#/properties/resumeCommand/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateTerminalSessionProvider.errors = [{instancePath:instancePath+"/resumeCommand",schemaPath:"#/properties/resumeCommand/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}}else {validateTerminalSessionProvider.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateTerminalSessionProvider.errors = vErrors;return errors === 0;};
// prettier-ignore
validateTerminalSessionProvider.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProviderTerminalSessionListResponse}. */
// prettier-ignore
export const validateProviderTerminalSessionListResponse: CompiledSchemaCheck<ProviderTerminalSessionListResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderTerminalSessionListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderTerminalSessionListResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessions === undefined) && (missing0 = "sessions")) || ((data.providers === undefined) && (missing0 = "providers"))){validateProviderTerminalSessionListResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessions") || (key0 === "providers"))){validateProviderTerminalSessionListResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessions !== undefined){let data0: any = data.sessions;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validateTerminalProviderSession.call(this, data0[i0], {instancePath:instancePath+"/sessions/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTerminalProviderSession.errors : vErrors.concat(validateTerminalProviderSession.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validateProviderTerminalSessionListResponse.errors = [{instancePath:instancePath+"/sessions",schemaPath:"#/properties/sessions/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.providers !== undefined){let data2: any = data.providers;const _errs5: any = errors;if(errors === _errs5){if(Array.isArray(data2)){var valid2: any = true;const len1: any = data2.length;for(let i1=0; i1<len1; i1++){const _errs7: any = errors;if(!(validateTerminalSessionProvider.call(this, data2[i1], {instancePath:instancePath+"/providers/" + i1,parentData:data2,parentDataProperty:i1,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTerminalSessionProvider.errors : vErrors.concat(validateTerminalSessionProvider.errors);errors = vErrors.length;}var valid2: any = _errs7 === errors;if(!valid2){break;}}}else {validateProviderTerminalSessionListResponse.errors = [{instancePath:instancePath+"/providers",schemaPath:"#/properties/providers/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}else {validateProviderTerminalSessionListResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProviderTerminalSessionListResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderTerminalSessionListResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;

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
