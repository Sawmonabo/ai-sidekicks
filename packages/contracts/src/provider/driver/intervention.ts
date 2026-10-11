// How a caller acts on a live run through its driver: the interrupt params, the intervention types
// and their payloads, and the driver's result, parsed because it comes from provider output.
import { z } from "zod";

import { wireFreeFormString } from "../../free-form-string.js";
import { RunIdSchema, type RunId } from "../../run/id.js";
import { DRIVER_FALLBACK_ACTION_MAX_LEN } from "./length-limits.js";

/** Asks a driver to interrupt one run, with an optional reason. */
export interface InterruptRunParams {
  runId: RunId;
  // `| undefined` keeps this aligned with `InterruptRunParamsSchema`, whose `.optional()` infers
  // `string | undefined`.
  reason?: string | undefined;
}

/**
 * How a caller acts on a live run, as its intervention row records it: interrupt, or retry on a
 * faster model, which the daemon carries out by stopping the turn and sending its message again on
 * the named model. A person's message mid-turn is a queue send, never an intervention.
 */
export type InterventionType = "interrupt" | "faster_model_retry";
/** Validates an {@link InterventionType}; the one runtime spelling of its values. */
export const InterventionTypeSchema: z.ZodType<InterventionType, InterventionType> = z.enum([
  "interrupt",
  "faster_model_retry",
]);

/**
 * The request of `driver.applyIntervention`: an interrupt on a live run. `expectedRunVersion` is
 * the fail-closed comparand; `clientIdempotencyKey` is the requester's key, passed through
 * unchanged, because a key minted per retry would defeat the dedupe. A message a person sends
 * mid-turn reaches a driver only from the run queue (`run.queueCreate`), never over the wire.
 */
export interface ApplyInterventionRequest {
  type: "interrupt";
  targetRunId: RunId;
  expectedRunVersion: number;
  clientIdempotencyKey: string;
  payload: InterruptPayload;
}

/**
 * What an interrupt does with the messages still waiting for the run: they go as the next turn
 * (`nextTurn`) or return to the draft (`returnToDraft`).
 */
export type InterruptPendingChoice = "nextTurn" | "returnToDraft";
/** Validates an {@link InterruptPendingChoice}; the one runtime spelling of its values. */
export const InterruptPendingChoiceSchema: z.ZodType<
  InterruptPendingChoice,
  InterruptPendingChoice
> = z.enum(["nextTurn", "returnToDraft"]);

/** Payload of an `interrupt` intervention; `pending` says what becomes of the waiting messages. */
export interface InterruptPayload {
  pending: InterruptPendingChoice;
  reason?: string | undefined;
}

/**
 * Return of `ProviderDriver.applyIntervention()`. `fallbackAction` names the fallback for a
 * `degraded` result and is absent when `applied`. `deliveredRunId` names the run a delivered
 * message went to when that is not its target: settling a choice the target was held on ended it,
 * so the message started the session's next turn as a run of its own.
 */
export interface DriverInterventionResult {
  status: "applied" | "degraded";
  fallbackAction?: string | undefined;
  deliveredRunId?: RunId | undefined;
}
/** Validates a {@link DriverInterventionResult} parsed from untrusted provider output. */
export const DriverInterventionResultSchema: z.ZodType<
  DriverInterventionResult,
  DriverInterventionResult
> = z
  .object({
    status: z.enum(["applied", "degraded"]),
    fallbackAction: wireFreeFormString(
      DRIVER_FALLBACK_ACTION_MAX_LEN,
      "DriverInterventionResult.fallbackAction",
    ).optional(),
    deliveredRunId: RunIdSchema.optional(),
  })
  .strict();
