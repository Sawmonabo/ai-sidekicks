// How a caller acts on a live run through its driver: the interrupt params, the intervention types
// and their payloads, and the driver's result, parsed because it comes from provider output.
import { z } from "zod";

import { wireFreeFormString } from "../../free-form-string.js";
import type { ArtifactId } from "../../artifacts/id.js";
import type { RunId } from "../../run/id.js";
import { DRIVER_FALLBACK_ACTION_MAX_LEN } from "./caps.js";

/** Asks a driver to interrupt one run, with an optional reason. */
export interface InterruptRunParams {
  runId: RunId;
  // `| undefined` keeps this aligned with `InterruptRunParamsSchema`, whose `.optional()` infers
  // `string | undefined`.
  reason?: string | undefined;
}

/**
 * How a caller acts on a live run: steer, interrupt, cancel, or retry on a faster model. A driver
 * applies the first three (`ApplyInterventionParams`); the daemon carries out `faster_model_retry`
 * by stopping the turn and sending its message again on the named model.
 */
export type InterventionType = "steer" | "interrupt" | "cancel" | "faster_model_retry";
/** Validates an {@link InterventionType}; the one runtime spelling of its values. */
export const InterventionTypeSchema: z.ZodType<InterventionType, InterventionType> = z.enum([
  "steer",
  "interrupt",
  "cancel",
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
    }
  | {
      type: "cancel";
      targetRunId: RunId;
      expectedRunVersion: number;
      clientIdempotencyKey: string;
      payload: CancelPayload;
    };

/** Payload of a `steer` intervention: the message content, its attachments and a target turn. */
export interface SteerPayload {
  content: string;
  // Order-preserving: an attachment the turn cannot resolve becomes an unresolved marker with its
  // cause in its own position, never dropped. No count of the app's own bounds the list.
  attachments?: ArtifactId[] | undefined;
  expectedTurnId?: string | undefined;
}

/** Payload of an `interrupt` intervention. */
export interface InterruptPayload {
  reason?: string | undefined;
}

/** Payload of a `cancel` intervention. */
export interface CancelPayload {
  reason?: string | undefined;
}

/**
 * Return of `ProviderDriver.applyIntervention()`. `fallbackAction` names the fallback for a
 * `degraded` result (e.g. `queue_and_interrupt` for a steer) and is absent when `applied`.
 */
export interface DriverInterventionResult {
  status: "applied" | "degraded";
  fallbackAction?: string | undefined;
  // Set when the driver refused the text before it reached the provider and knew so before
  // answering; otherwise the run's own `run.failed` carries the refusal.
  refusalCode?: "driver.text_neutralization_failed" | undefined;
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
    refusalCode: z.literal("driver.text_neutralization_failed").optional(),
  })
  .strict()
  // The refusal code says the person's text never reached the provider, which `applied` denies.
  .superRefine((result, context) => {
    if (result.status === "applied" && result.refusalCode !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["refusalCode"],
        message:
          "refusalCode classifies the user text as swallowed, which status " +
          "'applied' denies; the code is expressible only on a degraded result.",
      });
    }
  });
