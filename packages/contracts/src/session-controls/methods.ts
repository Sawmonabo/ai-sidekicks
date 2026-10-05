// A session's own controls and the reads behind its composer chips: the permission level and the
// Build or Plan mode, the auto-compact bound, the tool servers and their resources, the live `/`
// list, the side question, the review, the definitions reload, the step bound, the spend and token
// limits, and the Codex sessions typed in a terminal. The flow rows these controls write are in
// `./events.ts`.
//
// Every method here names the session it acts on, and every setting it changes belongs to that
// session alone: Settings, other sessions and future sessions are untouched.
//
// Must not import `../event.js`: it registers the payloads in `./events.ts`, which import this
// module, as event variants, so an import back closes a module-scope cycle that throws at load
// time.
import { z } from "zod";

import { brandedUuidIdSchema } from "../internal/branded.js";
import { composedTextSchema, countSchema } from "../internal/wire-scalars.js";
import { SubscribeAckResponseSchema, type SubscribeAckResponse } from "../jsonrpc-streaming.js";
import { McpServerNameSchema } from "../mcp.js";
import type { MethodDescriptor, SubscriptionMethodDescriptor } from "../method-descriptor.js";
import { defineMethodDescriptors } from "../method-descriptor.js";
import { ProviderNameSchema, type ProviderName } from "../provider-account.js";
import {
  DRIVER_PROVIDER_COMMAND_ENTRIES_MAX,
  MCP_SERVER_STATUS_SEVERITY_ORDER,
  type McpServerStatus,
} from "../provider-driver.js";
import {
  ProviderCommandEntrySchema,
  type ProviderCommandEntry,
} from "../provider-driver-transcript.js";
import { SessionIdSchema, wireUncappedFreeFormString, type SessionId } from "../session.js";
import {
  OrchestrationBudgetStateSchema,
  TokensPerRunSchema,
  UsdMicrosSchema,
  type OrchestrationBudgetState,
} from "../session-cost.js";

/** The one input every session read takes: the session. */
export interface SessionAddressedRequest {
  sessionId: SessionId;
}
/** Parses a {@link SessionAddressedRequest}. */
export const SessionAddressedRequestSchema: z.ZodType<
  SessionAddressedRequest,
  SessionAddressedRequest
> = z.object({ sessionId: SessionIdSchema }).strict();

/** The acknowledgement an operation with nothing more to say answers with. */
export interface SessionAcknowledgement {
  sessionId: SessionId;
}
/** Parses a {@link SessionAcknowledgement}. */
export const SessionAcknowledgementSchema: z.ZodType<SessionAcknowledgement> = z
  .object({ sessionId: SessionIdSchema })
  .strict();

const PERMISSION_LEVEL_VALUES = ["readonly", "ask", "reviewed", "sandboxed", "yolo"] as const;

/**
 * The five permission levels, most careful first, the same five words on every provider. Only
 * the first three ever ask the person; at `sandboxed` and `yolo` the daemon answers every ask
 * itself. Plan is not a level: it is the session's mode.
 */
export type PermissionLevel = (typeof PERMISSION_LEVEL_VALUES)[number];
/** Parses a {@link PermissionLevel}. */
export const PermissionLevelSchema: z.ZodType<PermissionLevel, PermissionLevel> =
  z.enum(PERMISSION_LEVEL_VALUES);

/** Moves the session to a level. Setting the level it already has changes nothing. */
export interface SessionPermissionLevelUpdateRequest {
  sessionId: SessionId;
  level: PermissionLevel;
}
/** Parses a {@link SessionPermissionLevelUpdateRequest}. */
export const SessionPermissionLevelUpdateRequestSchema: z.ZodType<
  SessionPermissionLevelUpdateRequest,
  SessionPermissionLevelUpdateRequest
> = z.object({ sessionId: SessionIdSchema, level: PermissionLevelSchema }).strict();

/** The level the session now stands at. */
export interface SessionPermissionLevelUpdateResponse {
  sessionId: SessionId;
  level: PermissionLevel;
}
/** Parses a {@link SessionPermissionLevelUpdateResponse}. */
export const SessionPermissionLevelUpdateResponseSchema: z.ZodType<SessionPermissionLevelUpdateResponse> =
  z.object({ sessionId: SessionIdSchema, level: PermissionLevelSchema }).strict();

const SESSION_MODE_VALUES = ["build", "plan"] as const;

/** Whether the session's next turns plan or build: the composer's mode control. */
export type SessionMode = (typeof SESSION_MODE_VALUES)[number];
/** Parses a {@link SessionMode}. */
export const SessionModeSchema: z.ZodType<SessionMode, SessionMode> = z.enum(SESSION_MODE_VALUES);

/** Sets the session's mode. */
export interface SessionModeUpdateRequest {
  sessionId: SessionId;
  mode: SessionMode;
}
/** Parses a {@link SessionModeUpdateRequest}. */
export const SessionModeUpdateRequestSchema: z.ZodType<
  SessionModeUpdateRequest,
  SessionModeUpdateRequest
> = z.object({ sessionId: SessionIdSchema, mode: SessionModeSchema }).strict();

/** The mode the session now runs in. */
export interface SessionModeUpdateResponse {
  sessionId: SessionId;
  mode: SessionMode;
}
/** Parses a {@link SessionModeUpdateResponse}. */
export const SessionModeUpdateResponseSchema: z.ZodType<SessionModeUpdateResponse> = z
  .object({ sessionId: SessionIdSchema, mode: SessionModeSchema })
  .strict();

// A share of the context window, in percent; a bound of nothing is no bound.
const autoCompactPercentSchema = z.number().gt(0).max(100);

/**
 * Sets this session's own auto-compact bound from its next turn, as a percent of the window;
 * `null` returns the session to the Settings default. The accepted range comes from the
 * provider's live figures, so the daemon refuses a percent outside it; the schema bounds only a
 * percent.
 */
export interface SessionAutoCompactUpdateRequest {
  sessionId: SessionId;
  percent: number | null;
}
/** Parses a {@link SessionAutoCompactUpdateRequest}. */
export const SessionAutoCompactUpdateRequestSchema: z.ZodType<
  SessionAutoCompactUpdateRequest,
  SessionAutoCompactUpdateRequest
> = z.object({ sessionId: SessionIdSchema, percent: autoCompactPercentSchema.nullable() }).strict();

/** The bound the session compacts at from its next turn, and whether it is its own. */
export interface SessionAutoCompactUpdateResponse {
  sessionId: SessionId;
  percent: number;
  sessionOverride: boolean;
}
/** Parses a {@link SessionAutoCompactUpdateResponse}. */
export const SessionAutoCompactUpdateResponseSchema: z.ZodType<SessionAutoCompactUpdateResponse> = z
  .object({
    sessionId: SessionIdSchema,
    percent: autoCompactPercentSchema,
    sessionOverride: z.boolean(),
  })
  .strict();

/**
 * One tool server this session was started with. `enabled` is the session's own switch;
 * `pendingUntilNextTurn` says a switch flipped mid-turn waits for the next turn. `reason` is the
 * failure or sign-in reason, carried for a server that is not working.
 */
export interface SessionMcpServer {
  serverName: string;
  status: McpServerStatus;
  reason?: string | undefined;
  enabled: boolean;
  pendingUntilNextTurn: boolean;
}

/** The session's whole server list, sent again on every change. */
export interface SessionMcpServerList {
  sessionId: SessionId;
  servers: SessionMcpServer[];
}
/** Parses a {@link SessionMcpServerList}. */
export const SessionMcpServerListSchema: z.ZodType<SessionMcpServerList> = z
  .object({
    sessionId: SessionIdSchema,
    servers: z.array(
      z
        .object({
          serverName: McpServerNameSchema,
          status: z.literal(MCP_SERVER_STATUS_SEVERITY_ORDER),
          reason: composedTextSchema.optional(),
          enabled: z.boolean(),
          pendingUntilNextTurn: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();

/** Turns one server on or off for this session only. */
export interface SessionMcpServerUpdateRequest {
  sessionId: SessionId;
  serverName: string;
  enabled: boolean;
}
/** Parses a {@link SessionMcpServerUpdateRequest}. */
export const SessionMcpServerUpdateRequestSchema: z.ZodType<
  SessionMcpServerUpdateRequest,
  SessionMcpServerUpdateRequest
> = z
  .object({ sessionId: SessionIdSchema, serverName: McpServerNameSchema, enabled: z.boolean() })
  .strict();

/** The switch as the session now holds it. */
export interface SessionMcpServerUpdateResponse {
  sessionId: SessionId;
  serverName: string;
  enabled: boolean;
}
/** Parses a {@link SessionMcpServerUpdateResponse}. */
export const SessionMcpServerUpdateResponseSchema: z.ZodType<SessionMcpServerUpdateResponse> = z
  .object({ sessionId: SessionIdSchema, serverName: McpServerNameSchema, enabled: z.boolean() })
  .strict();

/** Lists what one working server offers, for `Attach a resource…`. */
export interface SessionMcpResourceListRequest {
  sessionId: SessionId;
  serverName: string;
}
/** Parses a {@link SessionMcpResourceListRequest}. */
export const SessionMcpResourceListRequestSchema: z.ZodType<
  SessionMcpResourceListRequest,
  SessionMcpResourceListRequest
> = z.object({ sessionId: SessionIdSchema, serverName: McpServerNameSchema }).strict();

/** One resource as the server describes it. */
export interface SessionMcpResource {
  uri: string;
  name: string;
  title?: string | undefined;
  description?: string | undefined;
  mimeType?: string | undefined;
  size?: number | undefined;
}

/** The server's resources. */
export interface SessionMcpResourceListResponse {
  sessionId: SessionId;
  serverName: string;
  resources: SessionMcpResource[];
}
/** Parses a {@link SessionMcpResourceListResponse}. */
export const SessionMcpResourceListResponseSchema: z.ZodType<SessionMcpResourceListResponse> = z
  .object({
    sessionId: SessionIdSchema,
    serverName: McpServerNameSchema,
    resources: z.array(
      z
        .object({
          uri: composedTextSchema,
          name: composedTextSchema,
          title: composedTextSchema.optional(),
          description: composedTextSchema.optional(),
          mimeType: composedTextSchema.optional(),
          size: countSchema.optional(),
        })
        .strict(),
    ),
  })
  .strict();

/** One prompt a working tool server publishes, listed under the server's name. */
export interface SessionServerPrompt {
  serverName: string;
  name: string;
  title?: string | undefined;
  description?: string | undefined;
}

/**
 * The live `/` list's provider half: the running process's slash commands, as its provider
 * publishes them, and each working server's prompts. It is sent whole on every change: a new
 * process, the provider's own list-changed push, a server coming up or going down. `complete` is
 * false when the process published more commands than one list carries.
 */
export interface SessionProviderCommandList {
  sessionId: SessionId;
  commands: ProviderCommandEntry[];
  serverPrompts: SessionServerPrompt[];
  complete: boolean;
}
/** Parses a {@link SessionProviderCommandList}. */
export const SessionProviderCommandListSchema: z.ZodType<SessionProviderCommandList> = z
  .object({
    sessionId: SessionIdSchema,
    commands: z.array(ProviderCommandEntrySchema).max(DRIVER_PROVIDER_COMMAND_ENTRIES_MAX),
    serverPrompts: z
      .array(
        z
          .object({
            serverName: McpServerNameSchema,
            name: composedTextSchema,
            title: composedTextSchema.optional(),
            description: composedTextSchema.optional(),
          })
          .strict(),
      )
      .max(DRIVER_PROVIDER_COMMAND_ENTRIES_MAX),
    complete: z.boolean(),
  })
  .strict();

/** The daemon-minted id of one side question, echoed on its answer. */
export type SideQuestionId = string & { readonly __brand: "SideQuestionId" };
/** Parses a {@link SideQuestionId}. */
export const SideQuestionIdSchema: z.ZodType<SideQuestionId, SideQuestionId> =
  brandedUuidIdSchema<SideQuestionId>("SideQuestionId");

/** A side question's text: a message sent into a provider turn, uncapped like any other message. */
export const sideQuestionTextSchema: z.ZodString = wireUncappedFreeFormString(
  "SessionSideQuestionAskRequest.question",
);

/** Asks a side question in a throwaway copy of the conversation. */
export interface SessionSideQuestionAskRequest {
  sessionId: SessionId;
  question: string;
}
/** Parses a {@link SessionSideQuestionAskRequest}. */
export const SessionSideQuestionAskRequestSchema: z.ZodType<
  SessionSideQuestionAskRequest,
  SessionSideQuestionAskRequest
> = z.object({ sessionId: SessionIdSchema, question: sideQuestionTextSchema }).strict();

/** The id the answer will carry; the answer arrives later as an event. */
export interface SessionSideQuestionAskResponse {
  sessionId: SessionId;
  sideQuestionId: SideQuestionId;
}
/** Parses a {@link SessionSideQuestionAskResponse}. */
export const SessionSideQuestionAskResponseSchema: z.ZodType<SessionSideQuestionAskResponse> = z
  .object({ sessionId: SessionIdSchema, sideQuestionId: SideQuestionIdSchema })
  .strict();

const SESSION_REVIEW_TARGET_VALUES = ["workingTree", "staged", "branch"] as const;

/** What a review covers: the working tree, the staged set, or the branch against its base. */
export type SessionReviewTarget = (typeof SESSION_REVIEW_TARGET_VALUES)[number];
/** Parses a {@link SessionReviewTarget}. */
export const SessionReviewTargetSchema: z.ZodType<SessionReviewTarget, SessionReviewTarget> =
  z.enum(SESSION_REVIEW_TARGET_VALUES);

/** Starts the provider's own review; its report lands as the agent's reply. */
export interface SessionReviewStartRequest {
  sessionId: SessionId;
  target: SessionReviewTarget;
}
/** Parses a {@link SessionReviewStartRequest}. */
export const SessionReviewStartRequestSchema: z.ZodType<
  SessionReviewStartRequest,
  SessionReviewStartRequest
> = z.object({ sessionId: SessionIdSchema, target: SessionReviewTargetSchema }).strict();

/**
 * Sets or clears this session's own bound on how many steps one turn may take, from its next
 * turn. `null` returns the session to the machine's own value.
 */
export interface SessionMaxStepsUpdateRequest {
  sessionId: SessionId;
  maxStepsPerTurn: number | null;
}
/** Parses a {@link SessionMaxStepsUpdateRequest}; a bound below one is refused. */
export const SessionMaxStepsUpdateRequestSchema: z.ZodType<
  SessionMaxStepsUpdateRequest,
  SessionMaxStepsUpdateRequest
> = z
  .object({ sessionId: SessionIdSchema, maxStepsPerTurn: z.number().int().positive().nullable() })
  .strict();

/** The stored override; absent after a clear. */
export interface SessionMaxStepsUpdateResponse {
  sessionId: SessionId;
  maxStepsPerTurn?: number | undefined;
}
/** Parses a {@link SessionMaxStepsUpdateResponse}. */
export const SessionMaxStepsUpdateResponseSchema: z.ZodType<SessionMaxStepsUpdateResponse> = z
  .object({ sessionId: SessionIdSchema, maxStepsPerTurn: z.number().int().positive().optional() })
  .strict();

/**
 * Sets or clears this session's own `Spend limit`, in micro-dollars; `null` is `Unlimited`.
 * Saving a higher limit carries on the turns the limit stopped.
 */
export interface SessionSpendLimitUpdateRequest {
  sessionId: SessionId;
  spendLimitUsdMicros: number | null;
}
/** Parses a {@link SessionSpendLimitUpdateRequest}; a fraction or a negative amount is refused. */
export const SessionSpendLimitUpdateRequestSchema: z.ZodType<
  SessionSpendLimitUpdateRequest,
  SessionSpendLimitUpdateRequest
> = z
  .object({ sessionId: SessionIdSchema, spendLimitUsdMicros: UsdMicrosSchema.nullable() })
  .strict();

/**
 * Sets or clears this session's own `Tokens per run`; `null` is `Unlimited`. Saving a higher
 * limit carries on the run the limit stopped.
 */
export interface SessionTokensPerRunUpdateRequest {
  sessionId: SessionId;
  tokensPerRun: number | null;
}
/** Parses a {@link SessionTokensPerRunUpdateRequest}; a count below one is refused. */
export const SessionTokensPerRunUpdateRequestSchema: z.ZodType<
  SessionTokensPerRunUpdateRequest,
  SessionTokensPerRunUpdateRequest
> = z.object({ sessionId: SessionIdSchema, tokensPerRun: TokensPerRunSchema.nullable() }).strict();

/** Takes nothing: the list is the machine's, read when a confirm opens. */
export type SessionTerminalProviderSessionListRequest = Record<string, never>;
/** Parses a {@link SessionTerminalProviderSessionListRequest}; any member is refused. */
export const SessionTerminalProviderSessionListRequestSchema: z.ZodType<
  SessionTerminalProviderSessionListRequest,
  SessionTerminalProviderSessionListRequest
> = z.object({}).strict();

/** One provider session a person typed in a terminal, inside that provider's shared service. */
export interface TerminalProviderSession {
  provider: ProviderName;
  name: string;
  threadId: string;
  state: "working" | "idle" | "unreachable";
}

/**
 * The provider sessions typed in a terminal, read off the same directory entries the agents'
 * `session_list` names. Empty while `Reach Codex sessions started in a terminal` is off.
 */
export interface SessionTerminalProviderSessionListResponse {
  sessions: TerminalProviderSession[];
}
/** Parses a {@link SessionTerminalProviderSessionListResponse}. */
export const SessionTerminalProviderSessionListResponseSchema: z.ZodType<SessionTerminalProviderSessionListResponse> =
  z
    .object({
      sessions: z.array(
        z
          .object({
            provider: ProviderNameSchema,
            name: composedTextSchema,
            threadId: composedTextSchema,
            state: z.enum(["working", "idle", "unreachable"]),
          })
          .strict(),
      ),
    })
    .strict();

/** The session-control methods, keyed by method name. */
export interface SessionControlMethodDescriptors {
  readonly "session.permissionLevelUpdate": MethodDescriptor<
    "session.permissionLevelUpdate",
    SessionPermissionLevelUpdateRequest,
    SessionPermissionLevelUpdateResponse
  >;
  readonly "session.modeUpdate": MethodDescriptor<
    "session.modeUpdate",
    SessionModeUpdateRequest,
    SessionModeUpdateResponse
  >;
  readonly "session.autoCompactUpdate": MethodDescriptor<
    "session.autoCompactUpdate",
    SessionAutoCompactUpdateRequest,
    SessionAutoCompactUpdateResponse
  >;
  readonly "session.mcpServerList": SubscriptionMethodDescriptor<
    "session.mcpServerList",
    SessionAddressedRequest,
    SubscribeAckResponse,
    SessionMcpServerList
  >;
  readonly "session.mcpServerUpdate": MethodDescriptor<
    "session.mcpServerUpdate",
    SessionMcpServerUpdateRequest,
    SessionMcpServerUpdateResponse
  >;
  readonly "session.mcpResourceList": MethodDescriptor<
    "session.mcpResourceList",
    SessionMcpResourceListRequest,
    SessionMcpResourceListResponse
  >;
  readonly "session.providerCommandsSubscribe": SubscriptionMethodDescriptor<
    "session.providerCommandsSubscribe",
    SessionAddressedRequest,
    SubscribeAckResponse,
    SessionProviderCommandList
  >;
  readonly "session.sideQuestionAsk": MethodDescriptor<
    "session.sideQuestionAsk",
    SessionSideQuestionAskRequest,
    SessionSideQuestionAskResponse
  >;
  readonly "session.reviewStart": MethodDescriptor<
    "session.reviewStart",
    SessionReviewStartRequest,
    SessionAcknowledgement
  >;
  readonly "session.definitionsReload": MethodDescriptor<
    "session.definitionsReload",
    SessionAddressedRequest,
    SessionAcknowledgement
  >;
  readonly "session.maxStepsUpdate": MethodDescriptor<
    "session.maxStepsUpdate",
    SessionMaxStepsUpdateRequest,
    SessionMaxStepsUpdateResponse
  >;
  readonly "session.spendLimitUpdate": MethodDescriptor<
    "session.spendLimitUpdate",
    SessionSpendLimitUpdateRequest,
    OrchestrationBudgetState
  >;
  readonly "session.tokensPerRunUpdate": MethodDescriptor<
    "session.tokensPerRunUpdate",
    SessionTokensPerRunUpdateRequest,
    OrchestrationBudgetState
  >;
  readonly "session.terminalProviderSessionList": MethodDescriptor<
    "session.terminalProviderSessionList",
    SessionTerminalProviderSessionListRequest,
    SessionTerminalProviderSessionListResponse
  >;
}

/**
 * The session-control methods' wire contract: name, procedure type and schemas.
 *
 * @consumedBy the daemon's session control handlers
 */
export const SESSION_CONTROL_METHOD_DESCRIPTORS: SessionControlMethodDescriptors =
  defineMethodDescriptors({
    "session.permissionLevelUpdate": {
      method: "session.permissionLevelUpdate",
      procedureType: "mutation",
      mutating: true,
      requestSchema: SessionPermissionLevelUpdateRequestSchema,
      responseSchema: SessionPermissionLevelUpdateResponseSchema,
    },
    "session.modeUpdate": {
      method: "session.modeUpdate",
      procedureType: "mutation",
      mutating: true,
      requestSchema: SessionModeUpdateRequestSchema,
      responseSchema: SessionModeUpdateResponseSchema,
    },
    "session.autoCompactUpdate": {
      method: "session.autoCompactUpdate",
      procedureType: "mutation",
      mutating: true,
      requestSchema: SessionAutoCompactUpdateRequestSchema,
      responseSchema: SessionAutoCompactUpdateResponseSchema,
    },
    "session.mcpServerList": {
      method: "session.mcpServerList",
      procedureType: "subscription",
      mutating: false,
      requestSchema: SessionAddressedRequestSchema,
      responseSchema: SubscribeAckResponseSchema,
      emissionSchema: SessionMcpServerListSchema,
    },
    "session.mcpServerUpdate": {
      method: "session.mcpServerUpdate",
      procedureType: "mutation",
      mutating: true,
      requestSchema: SessionMcpServerUpdateRequestSchema,
      responseSchema: SessionMcpServerUpdateResponseSchema,
    },
    "session.mcpResourceList": {
      method: "session.mcpResourceList",
      procedureType: "query",
      mutating: false,
      requestSchema: SessionMcpResourceListRequestSchema,
      responseSchema: SessionMcpResourceListResponseSchema,
    },
    "session.providerCommandsSubscribe": {
      method: "session.providerCommandsSubscribe",
      procedureType: "subscription",
      mutating: false,
      requestSchema: SessionAddressedRequestSchema,
      responseSchema: SubscribeAckResponseSchema,
      emissionSchema: SessionProviderCommandListSchema,
    },
    "session.sideQuestionAsk": {
      method: "session.sideQuestionAsk",
      procedureType: "mutation",
      mutating: true,
      requestSchema: SessionSideQuestionAskRequestSchema,
      responseSchema: SessionSideQuestionAskResponseSchema,
    },
    "session.reviewStart": {
      method: "session.reviewStart",
      procedureType: "mutation",
      mutating: true,
      requestSchema: SessionReviewStartRequestSchema,
      responseSchema: SessionAcknowledgementSchema,
    },
    "session.definitionsReload": {
      method: "session.definitionsReload",
      procedureType: "mutation",
      mutating: true,
      requestSchema: SessionAddressedRequestSchema,
      responseSchema: SessionAcknowledgementSchema,
    },
    "session.maxStepsUpdate": {
      method: "session.maxStepsUpdate",
      procedureType: "mutation",
      mutating: true,
      requestSchema: SessionMaxStepsUpdateRequestSchema,
      responseSchema: SessionMaxStepsUpdateResponseSchema,
    },
    "session.spendLimitUpdate": {
      method: "session.spendLimitUpdate",
      procedureType: "mutation",
      mutating: true,
      requestSchema: SessionSpendLimitUpdateRequestSchema,
      responseSchema: OrchestrationBudgetStateSchema,
    },
    "session.tokensPerRunUpdate": {
      method: "session.tokensPerRunUpdate",
      procedureType: "mutation",
      mutating: true,
      requestSchema: SessionTokensPerRunUpdateRequestSchema,
      responseSchema: OrchestrationBudgetStateSchema,
    },
    "session.terminalProviderSessionList": {
      method: "session.terminalProviderSessionList",
      procedureType: "query",
      mutating: false,
      requestSchema: SessionTerminalProviderSessionListRequestSchema,
      responseSchema: SessionTerminalProviderSessionListResponseSchema,
    },
  });
