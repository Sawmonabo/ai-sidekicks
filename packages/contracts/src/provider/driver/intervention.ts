// How a caller acts on a live run through its driver: the interrupt params, the intervention types
// and their payloads, and the driver's result, parsed because it comes from provider output.
import { z } from "zod";

import { wireFreeFormString } from "../../free-form-string.js";
import type { ArtifactId } from "../../artifacts/id.js";
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
 * How a caller acts on a live run: steer, interrupt, or retry on a faster model. A driver applies
 * the first two (`ApplyInterventionParams`); the daemon carries out `faster_model_retry` by
 * stopping the turn and sending its message again on the named model.
 */
export type InterventionType = "steer" | "interrupt" | "faster_model_retry";
/** Validates an {@link InterventionType}; the one runtime spelling of its values. */
export const InterventionTypeSchema: z.ZodType<InterventionType, InterventionType> = z.enum([
  "steer",
  "interrupt",
  "faster_model_retry",
]);

/**
 * A daemon-constructed intervention, one arm per type with its own payload. `expectedRunVersion`
 * is the fail-closed comparand; `clientIdempotencyKey` is the requester's key the daemon dedupes
 * on, passed through unchanged, because a key minted per retry would defeat the dedupe.
 */
export type ApplyInterventionParams =
  | {
      type: "steer";
      targetRunId: RunId;
      expectedRunVersion: number;
      clientIdempotencyKey: string;
      payload: SteerPayload;
    }
  | {
      type: "interrupt";
      targetRunId: RunId;
      expectedRunVersion: number;
      clientIdempotencyKey: string;
      payload: InterruptPayload;
    };

/** Payload of a `steer` intervention: the message content, its attachments and a target turn. */
export interface SteerPayload {
  content: string;
  // Order-preserving: an attachment the turn cannot resolve becomes an unresolved marker with its
  // cause in its own position, never dropped. No count of the app's own bounds the list.
  attachments?: ArtifactId[] | undefined;
  expectedTurnId?: string | undefined;
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
 * `degraded` result (e.g. `queue_and_interrupt` for a steer) and is absent when `applied`.
 * `deliveredRunId` names the run an `applied` steer's message went to when that is not its target:
 * settling a choice the target was held on ended it, so the message started the session's next
 * turn as a run of its own.
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
