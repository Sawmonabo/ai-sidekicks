// The node's recovery after a restart: the state `daemon.status.read` carries as its `recovery`
// field, the refusal a write meets while that state is not healthy, and the three events the
// daemon's recovery pass records on its own sentinel session.
//
// This file imports nothing from the event registry, which imports it.
import { z } from "zod";

import { wireFreeFormString } from "../free-form-string.js";
import { uuidTextFormSchema } from "../internal/branded.js";
import { countSchema, isoDateTimeSchema } from "../internal/wire-scalars.js";
import { DRIVER_FAILURE_DETAIL_MAX_LEN } from "../provider/driver/length-limits.js";
import { RecoveryConditionSchema, type RecoveryCondition } from "../provider/driver/recovery.js";
import { RunFailureCategorySchema, type RunFailureCategory } from "../run/control.js";
import { RunIdSchema, type RunId } from "../run/id.js";
import { NodeIdSchema, type NodeId } from "../runtime-node/id.js";
import { SessionIdSchema, type SessionId } from "../session/id.js";

// ---- The recovery state ----

const DAEMON_RECOVERY_STATE_VALUES = ["healthy", "rebuilding", "degraded", "blocked"] as const;

/**
 * Where the node or one session stands in recovery: `rebuilding` while the restart's pass runs,
 * `degraded` when a projection could not be rebuilt into trustworthy read state, and `blocked`
 * when the local store itself is unavailable. Listed from least to most severe.
 */
export type DaemonRecoveryState = (typeof DAEMON_RECOVERY_STATE_VALUES)[number];
/** Every {@link DaemonRecoveryState}, from least to most severe. */
export const DAEMON_RECOVERY_STATES: readonly DaemonRecoveryState[] = Object.freeze([
  ...DAEMON_RECOVERY_STATE_VALUES,
]);
/** Parses a {@link DaemonRecoveryState}. */
export const DaemonRecoveryStateSchema: z.ZodType<DaemonRecoveryState, DaemonRecoveryState> =
  z.enum(DAEMON_RECOVERY_STATE_VALUES);

/**
 * One run behind a session's entry that needs the person: a halt on a diverged resume carries no
 * `failureCategory`, since the run did not fail; a failed resume carries one.
 */
export interface DaemonRecoveryHaltedRun {
  runId: RunId;
  recoveryCondition: RecoveryCondition;
  failureCategory?: RunFailureCategory | undefined;
}

/** One session that is not healthy, and why. */
export interface DaemonRecoverySession {
  sessionId: SessionId;
  state: DaemonRecoveryState;
  /** The last event sequence the session's projections reflect. */
  lastAppliedSequence?: number | undefined;
  failureCategory?: RunFailureCategory | undefined;
  recoveryCondition?: RecoveryCondition | undefined;
  /** The runs that need the person, each once; absent when no run does. */
  haltedRuns?: DaemonRecoveryHaltedRun[] | undefined;
}

/**
 * The `recovery` field of `daemon.status.read`: the node's overall state, the most severe of its
 * own and every listed session's, and the sessions that are not healthy.
 */
export interface DaemonRecoveryStatus {
  overall: DaemonRecoveryState;
  sessions: DaemonRecoverySession[];
}
/** Parses a {@link DaemonRecoveryStatus}. */
export const DaemonRecoveryStatusSchema: z.ZodType<DaemonRecoveryStatus> = z
  .object({
    overall: DaemonRecoveryStateSchema,
    sessions: z.array(
      z
        .object({
          sessionId: SessionIdSchema,
          state: DaemonRecoveryStateSchema,
          lastAppliedSequence: countSchema.optional(),
          failureCategory: RunFailureCategorySchema.optional(),
          recoveryCondition: RecoveryConditionSchema.optional(),
          haltedRuns: z
            .array(
              z
                .object({
                  runId: RunIdSchema,
                  recoveryCondition: RecoveryConditionSchema,
                  failureCategory: RunFailureCategorySchema.optional(),
                })
                .strict(),
            )
            .optional(),
        })
        .strict(),
    ),
  })
  .strict();

// ---- The write refusal ----

/** A mutating call refused while the node's recovery state is not healthy. */
export type DaemonWriteRefusedCode = "daemon.write_refused";
/**
 * The error code the service answers a mutating call with while its recovery state is not
 * healthy; only the stop, the restart and the flush are taken then.
 */
export const DAEMON_WRITE_REFUSED_CODE: DaemonWriteRefusedCode = "daemon.write_refused";

/** The refusal's `data.fields`: the node's overall recovery state when the call arrived. */
export interface DaemonWriteRefusedDetails {
  recovery: Exclude<DaemonRecoveryState, "healthy">;
}

// ---- The recovery pass's events, recorded on the service's own session ----

const RECOVERY_PHASE_VALUES = ["projection_rebuild", "binding_restore", "run_resumption"] as const;

/** The step of the recovery pass an event's outcome was decided in. */
export type RecoveryPhase = (typeof RECOVERY_PHASE_VALUES)[number];

const RECOVERY_TRIGGER_VALUES = ["startup", "manual", "supervisor"] as const;

/** What started a recovery pass. */
export type RecoveryTrigger = (typeof RECOVERY_TRIGGER_VALUES)[number];

const RECOVERY_FAILURE_KIND_VALUES = [
  "projection_rebuild_failed",
  "binding_restore_failed",
  "persistence_unavailable",
  "other",
] as const;

/** What kind of failure a failed recovery pass met. */
export type RecoveryFailureKind = (typeof RECOVERY_FAILURE_KIND_VALUES)[number];

/**
 * The members every recovery event carries: this machine, the pass, the step it was in, and which
 * attempt it is, one above the failed passes since the last one that succeeded.
 */
export interface RecoveryEventBase {
  nodeId: NodeId;
  recoveryId: string;
  phase: RecoveryPhase;
  attemptNumber: number;
}

const recoveryEventBaseShape = {
  nodeId: NodeIdSchema,
  recoveryId: uuidTextFormSchema,
  phase: z.enum(RECOVERY_PHASE_VALUES),
  attemptNumber: z.number().int().min(1),
};

/** `recovery.attempted`: a recovery pass started. */
export interface RecoveryAttemptedPayload extends RecoveryEventBase {
  recoveryTrigger: RecoveryTrigger;
  /** The failed passes since the last one that succeeded. */
  priorFailureCount: number;
  startedAt: string;
}
/** Parses a {@link RecoveryAttemptedPayload}. */
export const RecoveryAttemptedPayloadSchema: z.ZodType<RecoveryAttemptedPayload> = z
  .object({
    ...recoveryEventBaseShape,
    recoveryTrigger: z.enum(RECOVERY_TRIGGER_VALUES),
    priorFailureCount: countSchema,
    startedAt: isoDateTimeSchema,
  })
  .strict();

/**
 * `recovery.succeeded`: a recovery pass completed; every count is of this pass alone, and every
 * run it settled is in exactly one of the run counts.
 */
export interface RecoverySucceededPayload extends RecoveryEventBase {
  eventsApplied: number;
  bindingsRestored: number;
  runsResumed: number;
  runsFailedDeterministically: number;
  runsHaltedForReconciliation: number;
  /** The runs ended `interrupted`: under the person's pending interrupt, or a paused child. */
  runsInterrupted: number;
  /** Measured on a monotonic clock, in milliseconds. */
  durationMs: number;
  completedAt: string;
}
/** Parses a {@link RecoverySucceededPayload}. */
export const RecoverySucceededPayloadSchema: z.ZodType<RecoverySucceededPayload> = z
  .object({
    ...recoveryEventBaseShape,
    eventsApplied: countSchema,
    bindingsRestored: countSchema,
    runsResumed: countSchema,
    runsFailedDeterministically: countSchema,
    runsHaltedForReconciliation: countSchema,
    runsInterrupted: countSchema,
    durationMs: countSchema,
    completedAt: isoDateTimeSchema,
  })
  .strict();

/**
 * `recovery.failed`: a recovery pass that left the node blocked, when the local store failed, or
 * degraded, when a session's projections could not be rebuilt; `detail` is in the service's own
 * words.
 */
export interface RecoveryFailedPayload extends RecoveryEventBase {
  failureKind: RecoveryFailureKind;
  detail: string;
  /** The runs the pass left live. */
  runsLeftInFlight: RunId[];
  /** Measured on a monotonic clock, in milliseconds. */
  durationMs: number;
}
/** Parses a {@link RecoveryFailedPayload}. */
export const RecoveryFailedPayloadSchema: z.ZodType<RecoveryFailedPayload> = z
  .object({
    ...recoveryEventBaseShape,
    failureKind: z.enum(RECOVERY_FAILURE_KIND_VALUES),
    detail: wireFreeFormString(DRIVER_FAILURE_DETAIL_MAX_LEN, "RecoveryFailedPayload.detail"),
    runsLeftInFlight: z.array(RunIdSchema),
    durationMs: countSchema,
  })
  .strict();
