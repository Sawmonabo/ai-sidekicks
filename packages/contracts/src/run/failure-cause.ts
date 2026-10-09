// Why a run failed, as `run.failed` records it: one closed union of causes, each provider's own
// normalized into it by its driver, so a reload redraws the run's last row from the cause alone.

import { z } from "zod";

import { wireFreeFormString } from "../free-form-string.js";
import { DRIVER_FAILURE_DETAIL_MAX_LEN } from "../provider/driver/length-limits.js";
import { DRIVER_WIRE_HANDLE_MAX_LEN } from "../provider/driver/methods.js";
import {
  ProviderUsageLimitCauseSchema,
  ProviderUsageLimitResetBoundarySchema,
  type ProviderSpentRetriesSignal,
  type ProviderUsageLimitSignal,
} from "../provider/driver/usage-limit.js";

/**
 * A turn the provider's safety check refused with no other model to take it, on
 * `run.failed`: the refusing model, and the provider's own sentence, explanation
 * and check category when it sends them. `origin` is `provider` where the driver normalized the
 * provider's own cause and `daemon` where the app's own refusal ended the run.
 */
export interface RunRefusedCause {
  cause: "refused";
  origin: "provider" | "daemon";
  model: string;
  sentence?: string | undefined;
  explanation?: string | undefined;
  safetyCategory?: string | undefined;
}
const RunRefusedCauseSchema: z.ZodType<RunRefusedCause> = z
  .object({
    cause: z.literal("refused"),
    origin: z.enum(["provider", "daemon"]),
    model: wireFreeFormString(DRIVER_WIRE_HANDLE_MAX_LEN, "RunRefusedCause.model"),
    sentence: wireFreeFormString(
      DRIVER_FAILURE_DETAIL_MAX_LEN,
      "RunRefusedCause.sentence",
    ).optional(),
    explanation: wireFreeFormString(
      DRIVER_FAILURE_DETAIL_MAX_LEN,
      "RunRefusedCause.explanation",
    ).optional(),
    safetyCategory: wireFreeFormString(
      DRIVER_WIRE_HANDLE_MAX_LEN,
      "RunRefusedCause.safetyCategory",
    ).optional(),
  })
  .strict();

/**
 * A setup gate's throw before the provider started the run, which ends it `starting -> failed`:
 * the error's code when the gate threw a coded daemon error, and its own words.
 */
export interface RunSetupFailedCause {
  cause: "setup-failed";
  origin: "daemon";
  code?: string | undefined;
  message: string;
}
const RunSetupFailedCauseSchema: z.ZodType<RunSetupFailedCause> = z
  .object({
    cause: z.literal("setup-failed"),
    origin: z.literal("daemon"),
    code: wireFreeFormString(DRIVER_WIRE_HANDLE_MAX_LEN, "RunSetupFailedCause.code").optional(),
    message: wireFreeFormString(DRIVER_FAILURE_DETAIL_MAX_LEN, "RunSetupFailedCause.message"),
  })
  .strict();

/**
 * A turn too long for the context window even after compaction, cut back out of the conversation:
 * the person's message `returnedMessageId` goes back to the composer as a failed send.
 */
interface RunContextWindowExceededCause {
  cause: "context-window-exceeded";
  origin: "provider";
  returnedMessageId: string;
}
const RunContextWindowExceededCauseSchema: z.ZodType<RunContextWindowExceededCause> = z
  .object({
    cause: z.literal("context-window-exceeded"),
    origin: z.literal("provider"),
    returnedMessageId: wireFreeFormString(
      DRIVER_WIRE_HANDLE_MAX_LEN,
      "RunContextWindowExceededCause.returnedMessageId",
    ),
  })
  .strict();

/**
 * A turn sent on the flex speed that the provider failed for want of flex capacity, which it does
 * not retry: the same turn can go again on flex, or once on the standard speed.
 */
interface RunFlexCapacityUnavailableCause {
  cause: "flex-capacity-unavailable";
  origin: "provider";
}

/**
 * Why a run failed, on `run.failed`: the refusal, the provider's usage limit with the reset
 * boundary its driver held when the turn failed, the provider's spent retries, a setup gate's
 * failure, a turn too long for the context window, or no flex capacity for a turn on flex. A
 * reload redraws the run's last row from this cause alone.
 */
export type RunFailureCause =
  | RunRefusedCause
  | (ProviderUsageLimitSignal & { origin: "provider" })
  | (ProviderSpentRetriesSignal & { origin: "provider" })
  | RunSetupFailedCause
  | RunContextWindowExceededCause
  | RunFlexCapacityUnavailableCause;
/** Parses a {@link RunFailureCause}. */
export const RunFailureCauseSchema: z.ZodType<RunFailureCause> = z.union([
  RunRefusedCauseSchema,
  z
    .object({
      cause: ProviderUsageLimitCauseSchema,
      origin: z.literal("provider"),
      resetBoundary: ProviderUsageLimitResetBoundarySchema.optional(),
    })
    .strict(),
  z.object({ cause: z.literal("retries-exhausted"), origin: z.literal("provider") }).strict(),
  RunSetupFailedCauseSchema,
  RunContextWindowExceededCauseSchema,
  z
    .object({ cause: z.literal("flex-capacity-unavailable"), origin: z.literal("provider") })
    .strict(),
]);
