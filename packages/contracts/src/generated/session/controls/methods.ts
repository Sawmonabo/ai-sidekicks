// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A session's own controls and the reads behind its composer chips. Every method names the session it acts on, and every setting it changes belongs to that session alone.

import type { SchemaCheck } from "../../../schema-check.js";
import { validateSubscribeAcknowledgmentResponse } from "../../checks/jsonrpc/streaming.js";
import { validateEmptyPayload } from "../../checks/method-descriptor.js";
import { validateAgentQueueItemCreateResponse } from "../../checks/run/queue.js";
import {
  validateMcpResourceListRequest,
  validateMcpResourceListResponse,
  validateProviderTerminalSessionListResponse,
  validateSessionAcknowledgment,
  validateSessionAddressedRequest,
  validateSessionAutoCompactUpdateRequest,
  validateSessionAutoCompactUpdateResponse,
  validateSessionCodeReviewStartRequest,
  validateSessionMaxStepsUpdateRequest,
  validateSessionMaxStepsUpdateResponse,
  validateSessionMcpServerEnabledUpdateRequest,
  validateSessionMcpServerEnabledUpdateResponse,
  validateSessionMcpServerList,
  validateSessionModeUpdateRequest,
  validateSessionModeUpdateResponse,
  validateSessionPermissionLevelUpdateRequest,
  validateSessionPermissionLevelUpdateResponse,
  validateSessionProviderCommandList,
  validateSessionSideQuestionAskRequest,
  validateSessionSideQuestionAskResponse,
  validateSessionSpendLimitUpdateRequest,
  validateSessionTokensPerRunUpdateRequest,
} from "../../checks/session/controls/methods.js";
import { validateSessionBudgetState } from "../../checks/session/cost.js";
import type { SubscribeAcknowledgmentResponse } from "../../jsonrpc/streaming.js";
import type { McpServerStatus } from "../../mcp/server.js";
import type { EmptyPayload } from "../../method-descriptor.js";
import type { ProviderCommandEntry } from "../../provider/driver/commands.js";
import type { ProviderId } from "../../provider/id.js";
import type { AgentQueueItemCreateResponse } from "../../run/queue.js";
import type { SessionBudgetState, TokensPerRun, UsdMicros } from "../cost.js";
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

export {
  validateMcpResourceListRequest,
  validateMcpResourceListResponse,
  validatePermissionLevel,
  validateProviderTerminalSessionListResponse,
  validateSessionAcknowledgment,
  validateSessionAddressedRequest,
  validateSessionAutoCompactUpdateRequest,
  validateSessionAutoCompactUpdateResponse,
  validateSessionCodeReviewStartRequest,
  validateSessionMaxStepsUpdateRequest,
  validateSessionMaxStepsUpdateResponse,
  validateSessionMcpResource,
  validateSessionMcpServer,
  validateSessionMcpServerEnabledUpdateRequest,
  validateSessionMcpServerEnabledUpdateResponse,
  validateSessionMcpServerList,
  validateSessionMode,
  validateSessionModeUpdateRequest,
  validateSessionModeUpdateResponse,
  validateSessionPermissionLevelUpdateRequest,
  validateSessionPermissionLevelUpdateResponse,
  validateSessionProviderCommandList,
  validateSessionReviewTarget,
  validateSessionServerPrompt,
  validateSessionSideQuestionAskRequest,
  validateSessionSideQuestionAskResponse,
  validateSessionSpendLimitUpdateRequest,
  validateSessionTokensPerRunUpdateRequest,
  validateSideQuestionId,
  validateSideQuestionText,
  validateTerminalProviderSession,
  validateTerminalProviderSessionState,
  validateTerminalSessionProvider,
} from "../../checks/session/controls/methods.js";

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
export const SESSION_CONTROL_METHOD_DESCRIPTORS: SessionControlMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "session.permissionLevel.update": /* @__PURE__ */ Object.freeze({
      method: "session.permissionLevel.update",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateSessionPermissionLevelUpdateRequest,
      responseCheck: validateSessionPermissionLevelUpdateResponse,
    }),
    "session.mode.update": /* @__PURE__ */ Object.freeze({
      method: "session.mode.update",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateSessionModeUpdateRequest,
      responseCheck: validateSessionModeUpdateResponse,
    }),
    "session.autoCompact.update": /* @__PURE__ */ Object.freeze({
      method: "session.autoCompact.update",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateSessionAutoCompactUpdateRequest,
      responseCheck: validateSessionAutoCompactUpdateResponse,
    }),
    "session.mcpServer.subscribe": /* @__PURE__ */ Object.freeze({
      method: "session.mcpServer.subscribe",
      procedureType: "subscription",
      mutating: false,
      requestCheck: validateSessionAddressedRequest,
      responseCheck: validateSubscribeAcknowledgmentResponse,
      emissionCheck: validateSessionMcpServerList,
    }),
    "session.mcpServer.enabled.update": /* @__PURE__ */ Object.freeze({
      method: "session.mcpServer.enabled.update",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateSessionMcpServerEnabledUpdateRequest,
      responseCheck: validateSessionMcpServerEnabledUpdateResponse,
    }),
    "mcp.resource.list": /* @__PURE__ */ Object.freeze({
      method: "mcp.resource.list",
      procedureType: "query",
      mutating: false,
      requestCheck: validateMcpResourceListRequest,
      responseCheck: validateMcpResourceListResponse,
    }),
    "session.providerCommand.subscribe": /* @__PURE__ */ Object.freeze({
      method: "session.providerCommand.subscribe",
      procedureType: "subscription",
      mutating: false,
      requestCheck: validateSessionAddressedRequest,
      responseCheck: validateSubscribeAcknowledgmentResponse,
      emissionCheck: validateSessionProviderCommandList,
    }),
    "session.sideQuestion.ask": /* @__PURE__ */ Object.freeze({
      method: "session.sideQuestion.ask",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateSessionSideQuestionAskRequest,
      responseCheck: validateSessionSideQuestionAskResponse,
    }),
    "session.codeReview.start": /* @__PURE__ */ Object.freeze({
      method: "session.codeReview.start",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateSessionCodeReviewStartRequest,
      responseCheck: validateAgentQueueItemCreateResponse,
    }),
    "session.definition.reload": /* @__PURE__ */ Object.freeze({
      method: "session.definition.reload",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateSessionAddressedRequest,
      responseCheck: validateSessionAcknowledgment,
    }),
    "session.maxSteps.update": /* @__PURE__ */ Object.freeze({
      method: "session.maxSteps.update",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateSessionMaxStepsUpdateRequest,
      responseCheck: validateSessionMaxStepsUpdateResponse,
    }),
    "session.spendLimit.update": /* @__PURE__ */ Object.freeze({
      method: "session.spendLimit.update",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateSessionSpendLimitUpdateRequest,
      responseCheck: validateSessionBudgetState,
    }),
    "session.tokensPerRun.update": /* @__PURE__ */ Object.freeze({
      method: "session.tokensPerRun.update",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateSessionTokensPerRunUpdateRequest,
      responseCheck: validateSessionBudgetState,
    }),
    "provider.terminalSession.list": /* @__PURE__ */ Object.freeze({
      method: "provider.terminalSession.list",
      procedureType: "query",
      mutating: false,
      requestCheck: validateEmptyPayload,
      responseCheck: validateProviderTerminalSessionListResponse,
    }),
  });
