// The payloads of the flow rows a session's controls write, and the live frame of Codex's safety
// hold on a turn.
//
// Must not import `../../event/session-event.js`: it registers the payloads below as event
// variants, so an import back closes a module-scope cycle that throws at load time.
import { z } from "zod";

import { AgentIdSchema, type AgentId } from "../../agent/definition.js";
import { composedTextSchema } from "../../internal/wire-scalars.js";
import { PROVIDER_VERSION_MAX_LEN } from "../../provider/provider.js";
import { ProviderNameSchema, type ProviderName } from "../../provider/account/account.js";
import {
  DRIVER_FAILURE_DETAIL_MAX_LEN,
  RunIdSchema,
  type RunId,
} from "../../provider/driver/driver.js";
import {
  DRIVER_WIRE_HANDLE_MAX_LEN,
  DRIVER_WIRE_TOKEN_MAX_LEN,
} from "../../provider/driver/wire.js";
import {
  SessionIdSchema,
  wireFreeFormString,
  wireUncappedFreeFormString,
  type SessionId,
} from "../session.js";
import { TokensPerRunSchema, UsdMicrosSchema } from "../cost.js";
import {
  PermissionLevelSchema,
  SessionReviewTargetSchema,
  SideQuestionIdSchema,
  sideQuestionTextSchema,
  type PermissionLevel,
  type SessionReviewTarget,
  type SideQuestionId,
} from "./methods.js";

/**
 * The `session.side_question_answered` payload: the person's question and the provider's answer,
 * each as written. The aside never enters the conversation.
 */
export type SessionSideQuestionAnsweredPayload = {
  sessionId: SessionId;
  sideQuestionId: SideQuestionId;
  question: string;
  answer: string;
};
/** Parses a {@link SessionSideQuestionAnsweredPayload}. */
export const SessionSideQuestionAnsweredPayloadSchema: z.ZodType<SessionSideQuestionAnsweredPayload> =
  z
    .object({
      sessionId: SessionIdSchema,
      sideQuestionId: SideQuestionIdSchema,
      question: sideQuestionTextSchema,
      answer: wireUncappedFreeFormString("SessionSideQuestionAnsweredPayload.answer"),
    })
    .strict();

/**
 * The `run.step_limit_reached` payload: a turn reached the step bound and ended there, and the run
 * then ends as interrupted. `count` is the bound reached, drawn beside `Continue`.
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
 * show it again.
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
 * - `provider_warning`: a warning or a deprecation notice from Codex, in Codex's own words.
 * - `level_unavailable`: an account switch moved the session onto an account that cannot run the
 *   level it left, so it runs at `ask`; `level` is the level it left.
 * - `provider_updated`: the provider's installed build changed under the running session, both
 *   versions as the provider reports them; drawn as a banner, never a row.
 * - `fast_output_unavailable`: the provider says fast output is not on for a run that asked for
 *   it, with its own reason when it sent one.
 * - `provider_missing`: the session's provider is not installed where the background service
 *   runs, so no provider process started; `placeHasNeitherProvider` is true where that place has
 *   neither provider.
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
  | { sessionId: SessionId; kind: "goal_not_met"; agentId: AgentId }
  | { sessionId: SessionId; kind: "goal_check_unfinished"; agentId: AgentId }
  | {
      sessionId: SessionId;
      kind: "provider_warning";
      source: ProviderWarningSource;
      text: string;
      details?: string | undefined;
    }
  | { sessionId: SessionId; kind: "level_unavailable"; level: PermissionLevel }
  | {
      sessionId: SessionId;
      kind: "provider_updated";
      provider: ProviderName;
      fromVersion: string;
      toVersion: string;
    }
  | { sessionId: SessionId; kind: "fast_output_unavailable"; reason?: string | undefined }
  | {
      sessionId: SessionId;
      kind: "provider_missing";
      provider: ProviderName;
      placeHasNeitherProvider: boolean;
    };

const PROVIDER_WARNING_SOURCE_VALUES = ["warning", "deprecation"] as const;

/** Which Codex notice a provider warning came from: its warning or its deprecation notice. */
export type ProviderWarningSource = (typeof PROVIDER_WARNING_SOURCE_VALUES)[number];

/**
 * Every `session.notice` kind.
 *
 * @consumedBy the transcript's system messages, each drawn by its session notice kind
 */
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
        agentId: AgentIdSchema,
      })
      .strict(),
    z
      .object({
        sessionId: SessionIdSchema,
        kind: z.literal("goal_check_unfinished"),
        agentId: AgentIdSchema,
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
    z
      .object({
        sessionId: SessionIdSchema,
        kind: z.literal("level_unavailable"),
        level: PermissionLevelSchema,
      })
      .strict(),
    z
      .object({
        sessionId: SessionIdSchema,
        kind: z.literal("provider_updated"),
        provider: ProviderNameSchema,
        fromVersion: wireFreeFormString(
          PROVIDER_VERSION_MAX_LEN,
          "SessionNoticePayload.fromVersion",
        ),
        toVersion: wireFreeFormString(PROVIDER_VERSION_MAX_LEN, "SessionNoticePayload.toVersion"),
      })
      .strict(),
    z
      .object({
        sessionId: SessionIdSchema,
        kind: z.literal("fast_output_unavailable"),
        reason: wireFreeFormString(
          DRIVER_FAILURE_DETAIL_MAX_LEN,
          "SessionNoticePayload.reason",
        ).optional(),
      })
      .strict(),
    z
      .object({
        sessionId: SessionIdSchema,
        kind: z.literal("provider_missing"),
        provider: ProviderNameSchema,
        placeHasNeitherProvider: z.boolean(),
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
  agentId: AgentId;
  eventId: string;
  signal: ModerationReviewSignal;
  text: string;
};
/** Parses a {@link ModerationReviewFlaggedPayload}. */
export const ModerationReviewFlaggedPayloadSchema: z.ZodType<ModerationReviewFlaggedPayload> = z
  .object({
    sessionId: SessionIdSchema,
    runId: RunIdSchema,
    agentId: AgentIdSchema,
    eventId: composedTextSchema,
    signal: z.enum(MODERATION_REVIEW_SIGNAL_VALUES),
    text: wireFreeFormString(DRIVER_FAILURE_DETAIL_MAX_LEN, "ModerationReviewFlaggedPayload.text"),
  })
  .strict();
