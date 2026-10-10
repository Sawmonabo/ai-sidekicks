// The node's recovery after a restart: the state `daemon.status.read` carries as its `recovery`
// field, the refusal a write meets while the whole node cannot take one, and the three events the
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
 * Where the node stands in recovery: `rebuilding` while the restart's pass runs, `degraded` while
 * one or more sessions have damaged history, and `blocked` when the local store itself is
 * unavailable. Listed from least to most severe.
 */
export type DaemonRecoveryState = (typeof DAEMON_RECOVERY_STATE_VALUES)[number];
/** Every {@link DaemonRecoveryState}, from least to most severe. */
export const DAEMON_RECOVERY_STATES: readonly DaemonRecoveryState[] = Object.freeze([
  ...DAEMON_RECOVERY_STATE_VALUES,
]);
/** Parses a {@link DaemonRecoveryState}. */
export const DaemonRecoveryStateSchema: z.ZodType<DaemonRecoveryState, DaemonRecoveryState> =
  z.enum(DAEMON_RECOVERY_STATE_VALUES);

const DAEMON_RECOVERY_SESSION_STATE_VALUES = [
  "rebuilding",
  "degraded",
  "damaged",
  "blocked",
] as const;

/**
 * Where one session that is not healthy stands: `rebuilding` while the restart's pass has yet to
 * rebuild it, which a write refusal names and the status read leaves to the node's own state,
 * `degraded` when its history is damaged after a readable start, so it opens read-only at its
 * last good point, `damaged` when no event of it can be read, and `blocked` when a run of it
 * halted after the restart on a question for the person, named in its `haltedRuns`, which the
 * restart's question will set.
 */
export type DaemonRecoverySessionState = (typeof DAEMON_RECOVERY_SESSION_STATE_VALUES)[number];
/** Parses a {@link DaemonRecoverySessionState}. */
export const DaemonRecoverySessionStateSchema: z.ZodType<
  DaemonRecoverySessionState,
  DaemonRecoverySessionState
> = z.enum(DAEMON_RECOVERY_SESSION_STATE_VALUES);

/**
 * One run behind a session's entry that needs the person: a halt on a diverged resume carries no
 * `failureCategory`, since the run did not fail; a failed resume carries one.
 */
export interface DaemonRecoveryHaltedRun {
  runId: RunId;
  recoveryCondition: RecoveryCondition;
  failureCategory?: RunFailureCategory | undefined;
}

/**
 * One session that is not healthy, and why. A `degraded` session carries its last good point:
 * the last event it opens at, that event's time, and the first event that cannot be read.
 */
export interface DaemonRecoverySession {
  sessionId: SessionId;
  state: DaemonRecoverySessionState;
  /** The last event sequence the session's projections reflect. */
  lastAppliedSequence?: number | undefined;
  /** When the event at `lastAppliedSequence` happened. */
  lastAppliedAt?: string | undefined;
  /** The first event that cannot be read; every event from it to the head is damaged. */
  damagedFromSequence?: number | undefined;
  failureCategory?: RunFailureCategory | undefined;
  recoveryCondition?: RecoveryCondition | undefined;
  /** The runs that need the person, each once; absent when no run does. */
  haltedRuns?: DaemonRecoveryHaltedRun[] | undefined;
}

/**
 * The `recovery` field of `daemon.status.read`: the node's overall state and the sessions that
 * are not healthy, each damaged session among them.
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
          state: DaemonRecoverySessionStateSchema,
          lastAppliedSequence: countSchema.optional(),
          lastAppliedAt: isoDateTimeSchema.optional(),
          damagedFromSequence: countSchema.optional(),
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

/** A mutating call refused while the whole node cannot take writes. */
export type DaemonWriteRefusedCode = "daemon.write_refused";
/**
 * The error code the service answers a mutating call with while its recovery pass is still
 * running or its local store is unavailable; only the stop, the restart and the flush are taken
 * then. A session with damaged history refuses its own writes with `session.write_refused`.
 */
export const DAEMON_WRITE_REFUSED_CODE: DaemonWriteRefusedCode = "daemon.write_refused";

/** The refusal's `data.fields`: the node's recovery state when the call arrived. */
export interface DaemonWriteRefusedDetails {
  recovery: Extract<DaemonRecoveryState, "rebuilding" | "blocked">;
}

// ---- The repair of the database file ----

/** A call refused while the service repairs its database file before it opens it. */
export type DaemonRepairingCode = "daemon.repairing";
/**
 * The error code a service answers `daemon.hello` with, once the hello carries its session token,
 * while it repairs its database file: it serves nothing until the repair ends, then binds its
 * socket again and answers as usual. A client waits for it rather than counting it as silence.
 */
export const DAEMON_REPAIRING_CODE: DaemonRepairingCode = "daemon.repairing";

/** How far a repair has come: `done` of the damaged file's `total` session events recovered. */
export interface DaemonRepairProgress {
  done: number;
  total: number;
}

/**
 * The `daemon.repairing` refusal's `data.fields`: the repair's count, absent while the step it is
 * on gives none.
 */
export interface DaemonRepairingDetails {
  progress?: DaemonRepairProgress | undefined;
}
/** Parses a {@link DaemonRepairingDetails}. */
export const DaemonRepairingDetailsSchema: z.ZodType<DaemonRepairingDetails> = z
  .object({ progress: z.object({ done: countSchema, total: countSchema }).strict().optional() })
  .strict();

/** What a person reads while the service repairs its database file. */
export const DAEMON_REPAIRING_LINE = "Repairing saved sessions after an unexpected shutdown";

/**
 * The repair's line in parts, `<line> · <done> of <total>`, or the line ending in `…` when there
 * is no count; `drawCount` turns each figure into the reader's own form of it, such as a string
 * in the reader's locale.
 */
export function describeDaemonRepairingLine<Figure>(
  progress: DaemonRepairProgress | undefined,
  drawCount: (count: number) => Figure,
): (string | Figure)[] {
  return progress === undefined
    ? [`${DAEMON_REPAIRING_LINE}…`]
    : [`${DAEMON_REPAIRING_LINE} · `, drawCount(progress.done), " of ", drawCount(progress.total)];
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
 * degraded, when a session's history could not be rebuilt whole; `detail` is in the service's own
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
