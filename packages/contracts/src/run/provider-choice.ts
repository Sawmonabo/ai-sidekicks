// The choices a provider asks the person to make while a run waits on the answer: Claude Code's
// retry-or-edit choice when its safety check refuses a turn and names a fallback model, and its
// switch-or-credits choice when a turn on Fable needs usage credits. Each has a
// resolve request, which the `run.*` method table in `run/control.ts` serves, and the payloads of
// the event that asks and the event that records how it settled.
import { z } from "zod";

import { EVENT_FIELD_MAX_LEN } from "../event/version.js";
import { DRIVER_FAILURE_DETAIL_MAX_LEN } from "../provider/driver/caps.js";
import { RunIdSchema, type RunId } from "../provider/driver/intervention.js";
import { DRIVER_WIRE_HANDLE_MAX_LEN } from "../provider/driver/methods.js";
import { wireFreeFormString } from "../free-form-string.js";
import { SessionIdSchema, type SessionId } from "../session/id.js";
import { DeviceIdSchema, type DeviceId } from "../trust-statement.js";

/**
 * The person's answer when Claude Code's safety check refuses a turn and names a fallback model:
 * `retry_fallback` goes on on the fallback model, and `edit_prompt` ends the turn refused and
 * returns the message to the composer.
 */
export type RunRefusalChoice = "retry_fallback" | "edit_prompt";
const RunRefusalChoiceSchema: z.ZodType<RunRefusalChoice, RunRefusalChoice> = z.enum([
  "retry_fallback",
  "edit_prompt",
]);

/**
 * Answers the retry-or-edit choice a refused run waits on (`run.refusalChoiceResolve`). The first
 * answer settles it; a second or late one is refused with `run.invalid_transition`.
 */
export interface RunRefusalChoiceResolveRequest {
  runId: RunId;
  choice: RunRefusalChoice;
}
/** Parses a {@link RunRefusalChoiceResolveRequest}. */
export const RunRefusalChoiceResolveRequestSchema: z.ZodType<
  RunRefusalChoiceResolveRequest,
  RunRefusalChoiceResolveRequest
> = z.object({ runId: RunIdSchema, choice: RunRefusalChoiceSchema }).strict();

/**
 * The payload of `run.refusal_choice_requested`: the refusing model, the fallback it names, the
 * provider's own sentence and check category when it sends them, and the ids of the rows already
 * streamed for the refused answer, which leave the flow when the choice is answered.
 */
export interface RunRefusalChoiceRequestedPayload {
  sessionId: SessionId;
  runId: RunId;
  refusedModel: string;
  fallbackModel: string;
  sentence?: string | undefined;
  safetyCategory?: string | undefined;
  retractedMessageIds?: string[] | undefined;
}
/** Parses a {@link RunRefusalChoiceRequestedPayload}. */
export const RunRefusalChoiceRequestedPayloadSchema: z.ZodType<RunRefusalChoiceRequestedPayload> = z
  .object({
    sessionId: SessionIdSchema,
    runId: RunIdSchema,
    refusedModel: wireFreeFormString(
      DRIVER_WIRE_HANDLE_MAX_LEN,
      "RunRefusalChoiceRequestedPayload.refusedModel",
    ),
    fallbackModel: wireFreeFormString(
      DRIVER_WIRE_HANDLE_MAX_LEN,
      "RunRefusalChoiceRequestedPayload.fallbackModel",
    ),
    sentence: wireFreeFormString(
      DRIVER_FAILURE_DETAIL_MAX_LEN,
      "RunRefusalChoiceRequestedPayload.sentence",
    ).optional(),
    safetyCategory: wireFreeFormString(
      DRIVER_WIRE_HANDLE_MAX_LEN,
      "RunRefusalChoiceRequestedPayload.safetyCategory",
    ).optional(),
    retractedMessageIds: z
      .array(
        wireFreeFormString(
          EVENT_FIELD_MAX_LEN,
          "RunRefusalChoiceRequestedPayload.retractedMessageIds",
        ),
      )
      .optional(),
  })
  .strict();

/**
 * The payload of `run.refusal_choice_resolved`: the answer that settled the choice, and the
 * device that sent a person's answer. `canceled` is the answer the daemon sends for an interrupt
 * or a message sent while the choice waits; the driver maps Claude Code's own `cancelled` answer,
 * recorded when it settles the choice itself, to `canceled` at the boundary.
 */
export interface RunRefusalChoiceResolvedPayload {
  sessionId: SessionId;
  runId: RunId;
  choice: RunRefusalChoice | "canceled";
  deviceId?: DeviceId | undefined;
}
/** Parses a {@link RunRefusalChoiceResolvedPayload}. */
export const RunRefusalChoiceResolvedPayloadSchema: z.ZodType<RunRefusalChoiceResolvedPayload> = z
  .object({
    sessionId: SessionIdSchema,
    runId: RunIdSchema,
    choice: z.union([RunRefusalChoiceSchema, z.literal("canceled")]),
    deviceId: DeviceIdSchema.optional(),
  })
  .strict();

/**
 * The person's answer when a turn on Fable needs usage credits: `switch_default` moves the turn to
 * the fallback model, and `consent` goes on on usage credits, which Claude Code accepts only while
 * credits are on.
 */
export type RunUsageCreditsChoice = "switch_default" | "consent";
const RunUsageCreditsChoiceSchema: z.ZodType<RunUsageCreditsChoice, RunUsageCreditsChoice> = z.enum(
  ["switch_default", "consent"],
);

/**
 * Answers the switch-or-credits choice a Fable run waits on (`run.usageCreditsChoiceResolve`). The
 * first answer settles it; a second or late one is refused with `run.invalid_transition`.
 */
export interface RunUsageCreditsChoiceResolveRequest {
  runId: RunId;
  choice: RunUsageCreditsChoice;
}
/** Parses a {@link RunUsageCreditsChoiceResolveRequest}. */
export const RunUsageCreditsChoiceResolveRequestSchema: z.ZodType<
  RunUsageCreditsChoiceResolveRequest,
  RunUsageCreditsChoiceResolveRequest
> = z.object({ runId: RunIdSchema, choice: RunUsageCreditsChoiceSchema }).strict();

/**
 * The payload of `run.usage_credits_choice_requested`: the model that needs credits, whether
 * credits are on, the balance and its currency when Claude Code reports them, and the model a
 * switch moves to when Claude Code's model list names one.
 */
export interface RunUsageCreditsChoiceRequestedPayload {
  sessionId: SessionId;
  runId: RunId;
  modelName: string;
  overagesEnabled: boolean;
  balanceCents?: number | undefined;
  currency?: string | undefined;
  fallbackModel?: string | undefined;
}
/** Parses a {@link RunUsageCreditsChoiceRequestedPayload}. */
export const RunUsageCreditsChoiceRequestedPayloadSchema: z.ZodType<RunUsageCreditsChoiceRequestedPayload> =
  z
    .object({
      sessionId: SessionIdSchema,
      runId: RunIdSchema,
      modelName: wireFreeFormString(
        DRIVER_WIRE_HANDLE_MAX_LEN,
        "RunUsageCreditsChoiceRequestedPayload.modelName",
      ),
      overagesEnabled: z.boolean(),
      balanceCents: z.number().int().optional(),
      currency: wireFreeFormString(
        DRIVER_WIRE_HANDLE_MAX_LEN,
        "RunUsageCreditsChoiceRequestedPayload.currency",
      ).optional(),
      fallbackModel: wireFreeFormString(
        DRIVER_WIRE_HANDLE_MAX_LEN,
        "RunUsageCreditsChoiceRequestedPayload.fallbackModel",
      ).optional(),
    })
    .strict();

/**
 * The payload of `run.usage_credits_choice_resolved`: how the choice settled, and the device that
 * sent a person's answer. `interrupted` is an interrupt or an undo while it waits, which ends the
 * turn on Fable and answers nothing; `unanswered` is Claude Code settling it when a message is
 * sent while it waits.
 */
export interface RunUsageCreditsChoiceResolvedPayload {
  sessionId: SessionId;
  runId: RunId;
  choice: RunUsageCreditsChoice | "interrupted" | "unanswered";
  deviceId?: DeviceId | undefined;
}
/** Parses a {@link RunUsageCreditsChoiceResolvedPayload}. */
export const RunUsageCreditsChoiceResolvedPayloadSchema: z.ZodType<RunUsageCreditsChoiceResolvedPayload> =
  z
    .object({
      sessionId: SessionIdSchema,
      runId: RunIdSchema,
      choice: z.union([
        RunUsageCreditsChoiceSchema,
        z.literal("interrupted"),
        z.literal("unanswered"),
      ]),
      deviceId: DeviceIdSchema.optional(),
    })
    .strict();
