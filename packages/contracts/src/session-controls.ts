// A session's own controls and the reads behind its composer chips: the permission level and the
// Build or Plan mode, the auto-compact bound, the tool servers and their resources, the live `/`
// list, the side question, the review, the definitions reload, the step bound, the spend and token
// limits, and the Codex sessions typed in a terminal. It also holds the payloads of the flow rows
// these controls write and the live frame of Codex's safety hold on a turn.
//
// Every method here names the session it acts on, and every setting it changes belongs to that
// session alone: Settings, other sessions and future sessions are untouched.
//
// Must not import `./event.js`: it registers the payloads below as event variants, so an import
// back closes a module-scope cycle that throws at load time.
import { z } from "zod";

import { brandedUuidIdSchema } from "./internal/branded.js";
import { composedTextSchema, countSchema } from "./internal/wire-scalars.js";
import { SubscribeAckResponseSchema, type SubscribeAckResponse } from "./jsonrpc-streaming.js";
import { MCP_SERVER_STATUS_SEVERITY_ORDER, McpServerNameSchema } from "./mcp.js";
import type { MethodDescriptor, SubscriptionMethodDescriptor } from "./method-descriptor.js";
import { defineMethodDescriptors } from "./method-descriptor.js";
import { ProviderNameSchema, type ProviderName } from "./provider-account.js";
import {
  DRIVER_FAILURE_DETAIL_MAX_LEN,
  DRIVER_PROVIDER_COMMAND_ENTRIES_MAX,
  RunIdSchema,
  type McpServerStatus,
  type RunId,
} from "./provider-driver.js";
import { DRIVER_WIRE_HANDLE_MAX_LEN, DRIVER_WIRE_TOKEN_MAX_LEN } from "./provider-driver-wire.js";
import {
  ProviderCommandEntrySchema,
  type ProviderCommandEntry,
} from "./provider-driver-transcript.js";
import {
  SessionIdSchema,
  wireFreeFormString,
  wireUncappedFreeFormString,
  type SessionId,
} from "./session.js";
import {
  OrchestrationBudgetStateSchema,
  TokensPerRunSchema,
  UsdMicrosSchema,
  type OrchestrationBudgetState,
} from "./session-cost.js";

// The unbranded UUID text form, since the `agentId` brand belongs to the live agent contract.
const agentIdSchema = uuidTextFormSchema;

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

const EXECUTION_POSTURE_MODE_VALUES = ["readonly", "ask", "reviewed", "sandboxed", "yolo"] as const;

/**
 * The five permission levels, most careful first, the same five words on every provider. Only
 * the first three ever ask the person; at `sandboxed` and `yolo` the daemon answers every ask
 * itself. Plan is not a level: it is the session's mode.
 */
export type ExecutionPostureMode = (typeof EXECUTION_POSTURE_MODE_VALUES)[number];
/** Every {@link ExecutionPostureMode}, most careful first. */
export const EXECUTION_POSTURE_MODES: readonly ExecutionPostureMode[] =
  EXECUTION_POSTURE_MODE_VALUES;
/** Parses an {@link ExecutionPostureMode}. */
export const ExecutionPostureModeSchema: z.ZodType<ExecutionPostureMode, ExecutionPostureMode> =
  z.enum(EXECUTION_POSTURE_MODE_VALUES);

/** Moves the session to a level. Setting the level it already has changes nothing. */
export interface SessionPermissionLevelUpdateRequest {
  sessionId: SessionId;
  level: ExecutionPostureMode;
}
/** Parses a {@link SessionPermissionLevelUpdateRequest}. */
export const SessionPermissionLevelUpdateRequestSchema: z.ZodType<
  SessionPermissionLevelUpdateRequest,
  SessionPermissionLevelUpdateRequest
> = z.object({ sessionId: SessionIdSchema, level: ExecutionPostureModeSchema }).strict();

/** The level the session now stands at. */
export interface SessionPermissionLevelUpdateResponse {
  sessionId: SessionId;
  level: ExecutionPostureMode;
}
/** Parses a {@link SessionPermissionLevelUpdateResponse}. */
export const SessionPermissionLevelUpdateResponseSchema: z.ZodType<SessionPermissionLevelUpdateResponse> =
  z.object({ sessionId: SessionIdSchema, level: ExecutionPostureModeSchema }).strict();

const SESSION_MODE_VALUES = ["build", "plan"] as const;

/** Whether the session's next turns plan or build: the composer's mode control. */
export type SessionMode = (typeof SESSION_MODE_VALUES)[number];
/** Every {@link SessionMode}. */
export const SESSION_MODES: readonly SessionMode[] = SESSION_MODE_VALUES;
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

// A side question is a message sent into a provider turn, uncapped like any other message.
const sideQuestionTextSchema = wireUncappedFreeFormString("SessionSideQuestionAskRequest.question");

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

/**
 * The stored `session.side_question_answered` payload: the half the personal-data split leaves
 * in the event. The question is the person's words and the answer the provider's, so the emitter
 * moves both into the row's personal-data partition and neither is a member here. The aside never
 * enters the conversation.
 */
export type SessionSideQuestionAnsweredPayload = {
  sessionId: SessionId;
  sideQuestionId: SideQuestionId;
};
/** Parses a {@link SessionSideQuestionAnsweredPayload}. */
export const SessionSideQuestionAnsweredPayloadSchema: z.ZodType<SessionSideQuestionAnsweredPayload> =
  z.object({ sessionId: SessionIdSchema, sideQuestionId: SideQuestionIdSchema }).strict();

const SESSION_REVIEW_TARGET_VALUES = ["workingTree", "staged", "branch"] as const;

/** What a review covers: the working tree, the staged set, or the branch against its base. */
export type SessionReviewTarget = (typeof SESSION_REVIEW_TARGET_VALUES)[number];
/** Every {@link SessionReviewTarget}. */
export const SESSION_REVIEW_TARGETS: readonly SessionReviewTarget[] = SESSION_REVIEW_TARGET_VALUES;
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

/**
 * The `run.step_limit_reached` payload: a turn reached the step bound and ended there, the run
 * going on. `count` is the bound reached, drawn beside `Continue`.
 */
export type RunStepLimitReachedPayload = {
  sessionId: SessionId;
  runId: RunId;
  count: number;
};
/** Parses a {@link RunStepLimitReachedPayload}. */
export const RunStepLimitReachedPayloadSchema: z.ZodType<RunStepLimitReachedPayload> = z
  .object({ sessionId: SessionIdSchema, runId: RunIdSchema, count: z.number().int().positive() })
  .strict();

/**
 * The `session.spend_limit_reached` payload: the session's spend passed its `Spend limit`, so
 * every running turn in it stopped. `spendLimitUsdMicros` is the limit, drawn beside
 * `Raise limit`.
 */
export type SessionSpendLimitReachedPayload = {
  sessionId: SessionId;
  spendLimitUsdMicros: number;
};
/** Parses a {@link SessionSpendLimitReachedPayload}. */
export const SessionSpendLimitReachedPayloadSchema: z.ZodType<SessionSpendLimitReachedPayload> = z
  .object({ sessionId: SessionIdSchema, spendLimitUsdMicros: UsdMicrosSchema })
  .strict();

/**
 * The `run.token_limit_reached` payload: the run passed its `Tokens per run` and ended. The next
 * message starts a new run with a fresh count. `tokenLimit` is the limit, drawn beside
 * `Raise limit`.
 */
export type RunTokenLimitReachedPayload = {
  sessionId: SessionId;
  runId: RunId;
  tokenLimit: number;
};
/** Parses a {@link RunTokenLimitReachedPayload}. */
export const RunTokenLimitReachedPayloadSchema: z.ZodType<RunTokenLimitReachedPayload> = z
  .object({ sessionId: SessionIdSchema, runId: RunIdSchema, tokenLimit: TokensPerRunSchema })
  .strict();

/**
 * Codex's safety hold on a turn: Codex is holding the turn for a safety check (`active`), or has
 * released it. `fasterModel` is the model Codex names, as it sent it. It is relayed live on the
 * run's state stream and never kept in the session's history, so a re-opened session does not
 * replay it.
 */
export type RunSafetyBufferingUpdatedPayload = {
  sessionId: SessionId;
  runId: RunId;
  turnId: string;
  active: boolean;
  fasterModel?: string | undefined;
};
/** Parses a {@link RunSafetyBufferingUpdatedPayload}. */
export const RunSafetyBufferingUpdatedPayloadSchema: z.ZodType<RunSafetyBufferingUpdatedPayload> = z
  .object({
    sessionId: SessionIdSchema,
    runId: RunIdSchema,
    turnId: wireFreeFormString(
      DRIVER_WIRE_HANDLE_MAX_LEN,
      "RunSafetyBufferingUpdatedPayload.turnId",
    ),
    active: z.boolean(),
    fasterModel: wireFreeFormString(
      DRIVER_WIRE_TOKEN_MAX_LEN,
      "RunSafetyBufferingUpdatedPayload.fasterModel",
    ).optional(),
  })
  .strict();

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
 * `ListSessions` names. Empty while `Reach Codex sessions started in a terminal` is off.
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

/**
 * The `session.notice` payload. Its kinds are a closed set, each drawn as one plain sentence:
 *
 * - `settings_ignored`: the provider started without part of its settings. Codex names the file
 *   and the line; Claude Code's `doctor` names the file and, for one bad value, the key, and
 *   never a line.
 * - `conversation_reloaded`: the conversation was reopened to take new definitions.
 * - `review_started` and `review_finished`: the two ends of a review.
 * - `goal_not_met` and `goal_check_unfinished`: Claude Code ended the turn at its cap on unmet
 *   checks, or a goal check ran past its limit; the goal stays active.
 * - `provider_warning`: a warning or a deprecation notice from Codex, in Codex's own words. It
 *   draws no flow row: the working line counts the session's warnings and lists them.
 */
export type SessionNoticePayload =
  | {
      sessionId: SessionId;
      kind: "settings_ignored";
      provider: "codex";
      file: string;
      line: number;
    }
  | {
      sessionId: SessionId;
      kind: "settings_ignored";
      provider: "claude";
      file: string;
      key?: string | undefined;
    }
  | { sessionId: SessionId; kind: "conversation_reloaded" }
  | { sessionId: SessionId; kind: "review_started"; target: SessionReviewTarget }
  | { sessionId: SessionId; kind: "review_finished" }
  | { sessionId: SessionId; kind: "goal_not_met"; agentId: string }
  | { sessionId: SessionId; kind: "goal_check_unfinished"; agentId: string }
  | {
      sessionId: SessionId;
      kind: "provider_warning";
      source: ProviderWarningSource;
      text: string;
      details?: string | undefined;
    };

const PROVIDER_WARNING_SOURCE_VALUES = ["warning", "deprecation"] as const;

/** Which Codex notice a provider warning came from: `warning` or `deprecationNotice`. */
export type ProviderWarningSource = (typeof PROVIDER_WARNING_SOURCE_VALUES)[number];

/** Every `session.notice` kind. */
export type SessionNoticeKind = SessionNoticePayload["kind"];

/** Parses a {@link SessionNoticePayload}. */
export const SessionNoticePayloadSchema: z.ZodType<SessionNoticePayload> = z.discriminatedUnion(
  "kind",
  [
    z.discriminatedUnion("provider", [
      z
        .object({
          sessionId: SessionIdSchema,
          kind: z.literal("settings_ignored"),
          provider: z.literal("codex"),
          file: composedTextSchema,
          line: z.number().int().positive(),
        })
        .strict(),
      z
        .object({
          sessionId: SessionIdSchema,
          kind: z.literal("settings_ignored"),
          provider: z.literal("claude"),
          file: composedTextSchema,
          key: composedTextSchema.optional(),
        })
        .strict(),
    ]),
    z.object({ sessionId: SessionIdSchema, kind: z.literal("conversation_reloaded") }).strict(),
    z
      .object({
        sessionId: SessionIdSchema,
        kind: z.literal("review_started"),
        target: SessionReviewTargetSchema,
      })
      .strict(),
    z.object({ sessionId: SessionIdSchema, kind: z.literal("review_finished") }).strict(),
    z
      .object({
        sessionId: SessionIdSchema,
        kind: z.literal("goal_not_met"),
        agentId: agentIdSchema,
      })
      .strict(),
    z
      .object({
        sessionId: SessionIdSchema,
        kind: z.literal("goal_check_unfinished"),
        agentId: agentIdSchema,
      })
      .strict(),
    z
      .object({
        sessionId: SessionIdSchema,
        kind: z.literal("provider_warning"),
        source: z.enum(PROVIDER_WARNING_SOURCE_VALUES),
        text: wireFreeFormString(DRIVER_FAILURE_DETAIL_MAX_LEN, "SessionNoticePayload.text"),
        details: wireFreeFormString(
          DRIVER_FAILURE_DETAIL_MAX_LEN,
          "SessionNoticePayload.details",
        ).optional(),
      })
      .strict(),
  ],
);

const MODERATION_REVIEW_SIGNAL_VALUES = ["review_warning", "review_required"] as const;

/** Which of Codex's reviewer signals a flag carries. */
export type ModerationReviewSignal = (typeof MODERATION_REVIEW_SIGNAL_VALUES)[number];

/**
 * The `moderation.review_flagged` payload: a warning or a required review from Codex's own
 * reviewer, drawn as one row in Codex's words. `eventId` names the item the flag is about;
 * `text` is the words the row shows.
 */
export type ModerationReviewFlaggedPayload = {
  sessionId: SessionId;
  runId: RunId;
  agentId: string;
  eventId: string;
  signal: ModerationReviewSignal;
  text: string;
};
/** Parses a {@link ModerationReviewFlaggedPayload}. */
export const ModerationReviewFlaggedPayloadSchema: z.ZodType<ModerationReviewFlaggedPayload> = z
  .object({
    sessionId: SessionIdSchema,
    runId: RunIdSchema,
    agentId: agentIdSchema,
    eventId: composedTextSchema,
    signal: z.enum(MODERATION_REVIEW_SIGNAL_VALUES),
    text: wireFreeFormString(DRIVER_FAILURE_DETAIL_MAX_LEN, "ModerationReviewFlaggedPayload.text"),
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

/** The session-control methods' wire contract: name, procedure type and schemas. */
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
