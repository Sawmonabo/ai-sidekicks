// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The service's recovery after a restart: its state, the refusals a write meets, the repair of the database file and the recovery pass's events.

import type { WireInstant } from "../internal/wire-scalars.js";
import type { MachineId } from "../machine/id.js";
import type { RecoveryCondition } from "../provider/driver/recovery.js";
import type { RunFailureCategory } from "../run/control.js";
import type { RunId } from "../run/id.js";
import type { SessionId } from "../session/id.js";

/**
 * The error code a service answers `connection.initialize` with, once the request carries its
 * session token, while it repairs its database file. A client waits for it rather than
 * counting it as silence.
 */
export const DAEMON_REPAIRING_CODE = "daemon.repairing" as const;

/** What a person reads while the service repairs its database file. */
export const DAEMON_REPAIRING_LINE =
  "Repairing saved sessions after an unexpected shutdown" as const;

/**
 * Where the service stands in recovery: `rebuilding` while the restart's pass runs, `degraded`
 * while one or more sessions have damaged history, and `blocked` when the local store itself is
 * unavailable. Ordered from least to most severe.
 */
export type DaemonRecoveryState = "healthy" | "rebuilding" | "degraded" | "blocked";
/**
 * Where one session that is not healthy stands: `rebuilding` while the restart's pass has yet to
 * rebuild it, which a write refusal names and the status read leaves to the service's own state,
 * `degraded` when its history is damaged after a readable start, so it opens read-only at its
 * last good point, `damaged` when no event of it can be read, and `blocked` when a run of it
 * halted after the restart on a question for the person, named in its `haltedRuns`.
 */
export type DaemonRecoverySessionState = "rebuilding" | "degraded" | "damaged" | "blocked";
/**
 * The service's state when a write was refused by the whole service.
 */
export type DaemonWriteRefusedRecovery = "rebuilding" | "blocked";
/**
 * The step of the recovery pass an event's outcome was decided in.
 */
export type RecoveryPhase = "projectionRebuild" | "bindingRestore" | "runResumption";
/**
 * What started a recovery pass.
 */
export type RecoveryTrigger = "startup" | "manual" | "supervisor";
/**
 * Identifies one recovery pass; every event of the pass names it.
 */
export type RecoveryId = string & { readonly __brand: "RecoveryId" };
/**
 * What kind of failure a failed recovery pass met.
 */
export type RecoveryFailureKind =
  | "projectionRebuildFailed"
  | "bindingRestoreFailed"
  | "persistenceUnavailable"
  | "other";

/**
 * One run behind a session's entry that needs the person: a halt on a diverged resume carries no
 * `failureCategory`, since the run did not fail; a failed resume carries one.
 */
export interface DaemonRecoveryHaltedRun {
  /**
   * The run.
   */
  runId: RunId;
  /**
   * What its recovery needs.
   */
  recoveryCondition: RecoveryCondition;
  /**
   * Why it failed, where it did.
   */
  failureCategory?: RunFailureCategory;
}
/**
 * One session that is not healthy, and why. A `degraded` session carries its last good point:
 * the last event it opens at, that event's time, and the first event that cannot be read.
 */
export interface DaemonRecoverySession {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * Where it stands.
   */
  state: DaemonRecoverySessionState;
  /**
   * The last event sequence the session's projections reflect.
   */
  lastAppliedSequence?: number;
  /**
   * When the event at `last_applied_sequence` happened.
   */
  lastAppliedAt?: WireInstant;
  /**
   * The first event that cannot be read; every event from it to the head is damaged.
   */
  damagedFromSequence?: number;
  /**
   * Why its run failed, where one did.
   */
  failureCategory?: RunFailureCategory;
  /**
   * What its recovery needs, where that is known.
   */
  recoveryCondition?: RecoveryCondition;
  /**
   * The runs that need the person, each once; absent when no run does.
   */
  haltedRuns?: DaemonRecoveryHaltedRun[];
}
/**
 * The `recovery` member of `daemon.status.read`: the service's overall state and the sessions that
 * are not healthy, each damaged session among them.
 */
export interface DaemonRecoveryStatus {
  /**
   * The service's overall state.
   */
  overall: DaemonRecoveryState;
  /**
   * The sessions that are not healthy.
   */
  sessions: DaemonRecoverySession[];
}
/**
 * The `daemon.writeRefused` refusal's `data.fields`: the service's recovery state when the call
 * arrived.
 */
export interface DaemonWriteRefusedDetails {
  /**
   * The service's state.
   */
  recovery: DaemonWriteRefusedRecovery;
}
/**
 * How far a repair has come: `done` of the damaged file's `total` session events recovered.
 */
export interface DaemonRepairProgress {
  /**
   * The session events recovered so far.
   */
  done: number;
  /**
   * The session events the damaged file lists.
   */
  total: number;
}
/**
 * The `daemon.repairing` refusal's `data.fields`: the repair's count, absent while the step it is
 * on gives none.
 */
export interface DaemonRepairingDetails {
  /**
   * The repair's count.
   */
  progress?: DaemonRepairProgress;
}
/**
 * `daemon.recovery.attempted`: a recovery pass started. Like every recovery event it names this
 * machine, the pass, the step it was in, and which attempt it is, one above the failed passes
 * since the last one that succeeded.
 */
export interface DaemonRecoveryAttemptedPayload {
  /**
   * This machine.
   */
  machineId: MachineId;
  /**
   * The pass.
   */
  recoveryId: RecoveryId;
  /**
   * The step it was in.
   */
  phase: RecoveryPhase;
  /**
   * Which attempt it is.
   */
  attemptNumber: number;
  /**
   * What started it.
   */
  recoveryTrigger: RecoveryTrigger;
  /**
   * The failed passes since the last one that succeeded.
   */
  priorFailureCount: number;
  /**
   * When it started.
   */
  startedAt: WireInstant;
}
/**
 * `daemon.recovery.succeeded`: a recovery pass completed; every count is of this pass alone, and
 * every run it settled is in exactly one of the run counts.
 */
export interface DaemonRecoverySucceededPayload {
  /**
   * This machine.
   */
  machineId: MachineId;
  /**
   * The pass.
   */
  recoveryId: RecoveryId;
  /**
   * The step it was in.
   */
  phase: RecoveryPhase;
  /**
   * Which attempt it is.
   */
  attemptNumber: number;
  /**
   * The events applied.
   */
  eventsApplied: number;
  /**
   * The provider bindings restored.
   */
  bindingsRestored: number;
  /**
   * The runs resumed.
   */
  runsResumed: number;
  /**
   * The runs that failed deterministically.
   */
  runsFailedDeterministically: number;
  /**
   * The runs halted for the person to reconcile.
   */
  runsHaltedForReconciliation: number;
  /**
   * The runs ended `interrupted`: under the person's pending interrupt, a paused child, or at a
   * step or spend limit their log still owed.
   */
  runsInterrupted: number;
  /**
   * The runs ended `stopped` at a token limit their log still owed.
   */
  runsStopped: number;
  /**
   * How long it took, on a monotonic clock, in milliseconds.
   */
  durationMs: number;
  /**
   * When it completed.
   */
  completedAt: WireInstant;
}
/**
 * `daemon.recovery.failed`: a recovery pass that left the service blocked, when the local store
 * failed, or degraded, when a session's history could not be rebuilt whole; `detail` is in the
 * service's own words.
 */
export interface DaemonRecoveryFailedPayload {
  /**
   * This machine.
   */
  machineId: MachineId;
  /**
   * The pass.
   */
  recoveryId: RecoveryId;
  /**
   * The step it was in.
   */
  phase: RecoveryPhase;
  /**
   * Which attempt it is.
   */
  attemptNumber: number;
  /**
   * What kind of failure it met.
   */
  failureKind: RecoveryFailureKind;
  /**
   * The failure, in the service's own words.
   */
  detail: string;
  /**
   * The runs the pass left live.
   */
  runsLeftInFlight: RunId[];
  /**
   * How long it took, on a monotonic clock, in milliseconds.
   */
  durationMs: number;
}

export {
  validateDaemonRecoveryAttemptedPayload,
  validateDaemonRecoveryFailedPayload,
  validateDaemonRecoveryHaltedRun,
  validateDaemonRecoverySession,
  validateDaemonRecoverySessionState,
  validateDaemonRecoveryState,
  validateDaemonRecoveryStatus,
  validateDaemonRecoverySucceededPayload,
  validateDaemonRepairProgress,
  validateDaemonRepairingDetails,
  validateRecoveryFailureKind,
  validateRecoveryId,
  validateRecoveryPhase,
  validateRecoveryTrigger,
} from "../checks/daemon/recovery.js";
