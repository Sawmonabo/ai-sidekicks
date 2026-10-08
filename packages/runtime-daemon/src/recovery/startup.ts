// The recovery pass every start runs before the node takes writes: it rebuilds each session's
// projections the log has moved past, settles every run the restart left live, the person's
// pending interrupt with it, and records the pass on the service's own session. It never throws:
// a pass that fails leaves the node blocked, or a session it could not rebuild degraded, and says
// why in the service log.

import type { Database, Statement } from "better-sqlite3";

import {
  DAEMON_SCOPE_SENTINEL_SESSION_ID,
  EventEnvelopeVersionSchema,
} from "@ai-sidekicks/contracts/event/envelope";
import type {
  RecoveryAttemptedPayload,
  RecoveryEventBase,
  RecoveryFailedPayload,
  RecoveryFailureKind,
  RecoverySucceededPayload,
} from "@ai-sidekicks/contracts/daemon/recovery";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { NodeId } from "@ai-sidekicks/contracts/runtime-node/id";

import type { EventLogService } from "../events/log-service.js";
import { boundFailureDetail } from "../provider/driver/contract.js";
import type { RunEngine } from "../session/run/engine.js";
import type { RunStateReader } from "../session/run/read.js";
import { hasSqliteErrorCode } from "../session/sqlite-error-code.js";
import { mintUuidV7 } from "../uuid-v7.js";
import { ProjectionFailureError, type ProjectionRebuildService } from "./projection-rebuild.js";
import type { RecoveryStatusTracker } from "./status.js";

/** What the pass reads, writes and reports through. */
export interface StartupRecoveryDeps {
  readonly nodeId: NodeId;
  readonly reader: Database;
  readonly sessionEvents: Pick<EventLogService, "append">;
  readonly projectionRebuild: Pick<
    ProjectionRebuildService,
    "listSessionsToRebuild" | "rebuild" | "readLastAppliedSequence"
  >;
  readonly runs: Pick<RunStateReader, "listLiveRuns">;
  readonly runEngine: Pick<RunEngine, "settleRunAfterRestart">;
  readonly status: RecoveryStatusTracker;
  readonly now: () => Date;
  readonly writeServiceLog: (line: string) => void;
}

// What one pass did; the binding and resume steps are not built, so their counts stay at zero.
interface RecoveryTally {
  eventsApplied: number;
  bindingsRestored: number;
  runsResumed: number;
  runsFailedDeterministically: number;
  runsHaltedForReconciliation: number;
  runsInterrupted: number;
}

const RECOVERY_EVENT_VERSION = EventEnvelopeVersionSchema.parse("1.0");

// What a run the restart left live carries as its failure when nothing resumed it.
const RESTART_FAILURE_DETAIL = "The service restarted and no provider session was restored";

// What a failed pass records when what it threw carried no text.
const UNDESCRIBED_PASS_FAILURE = "The recovery pass failed without a message";

// The failed passes since the last one that succeeded, read from the service's own session.
const COUNT_FAILURES_SINCE_SUCCESS_SQL = `SELECT COUNT(*) AS failure_count FROM session_events
  WHERE session_id = @sentinel
    AND type = 'recovery.failed'
    AND sequence > COALESCE(
      (SELECT MAX(sequence) FROM session_events
        WHERE session_id = @sentinel AND type = 'recovery.succeeded'),
      -1)`;

/** Runs the recovery pass a start makes before the node takes writes. */
export class StartupRecovery {
  readonly #deps: StartupRecoveryDeps;
  readonly #countFailuresSinceSuccess: Statement<[{ sentinel: string }], { failure_count: number }>;

  constructor(deps: StartupRecoveryDeps) {
    this.#deps = deps;
    this.#countFailuresSinceSuccess = deps.reader.prepare(COUNT_FAILURES_SINCE_SUCCESS_SQL);
  }

  /**
   * Runs the pass and resolves once it has ended, either way; the node's recovery state then says
   * how it ended. Never throws.
   */
  async run(): Promise<void> {
    const { status } = this.#deps;
    const passStartedAt = performance.now();
    const tally: RecoveryTally = {
      eventsApplied: 0,
      bindingsRestored: 0,
      runsResumed: 0,
      runsFailedDeterministically: 0,
      runsHaltedForReconciliation: 0,
      runsInterrupted: 0,
    };
    const base: RecoveryEventBase = {
      nodeId: this.#deps.nodeId,
      recoveryId: mintUuidV7(),
      phase: "projection_rebuild",
      attemptNumber: 1,
    };
    // The runs this pass has yet to settle, so a pass that stops early names what it left live.
    const runsLeftInFlight = new Set<RunId>();
    try {
      const priorFailureCount = this.#countFailuresSinceSuccess.get({
        sentinel: DAEMON_SCOPE_SENTINEL_SESSION_ID,
      })?.failure_count;
      if (priorFailureCount === undefined) {
        throw new Error("Counting the earlier failed recovery passes returned no row");
      }
      base.attemptNumber = priorFailureCount + 1;
      await this.#record("recovery.attempted", {
        ...base,
        recoveryTrigger: "startup",
        priorFailureCount,
        startedAt: this.#deps.now().toISOString(),
      } satisfies RecoveryAttemptedPayload);

      await this.#rebuildProjections(tally);

      base.phase = "run_resumption";
      await this.#settleLiveRuns(tally, runsLeftInFlight);

      const failureKind: RecoveryFailureKind | undefined =
        status.readOverall() === "degraded" ? "projection_rebuild_failed" : undefined;
      if (failureKind === undefined) {
        await this.#record("recovery.succeeded", {
          ...base,
          ...tally,
          durationMs: elapsedMs(passStartedAt),
          completedAt: this.#deps.now().toISOString(),
        } satisfies RecoverySucceededPayload);
      } else {
        // The outcome was decided when a session's rebuild failed, not in the step after it.
        await this.#recordFailure(
          { ...base, phase: "projection_rebuild" },
          {
            failureKind,
            detail: "The projections of one or more sessions could not be rebuilt",
            runsLeftInFlight: [...runsLeftInFlight],
            durationMs: elapsedMs(passStartedAt),
          },
        );
      }
    } catch (error) {
      // A failure outside one session's fold is the store's: nothing more can be trusted.
      status.markStoreFailed();
      this.#deps.writeServiceLog(`The recovery pass failed: ${describeError(error)}`);
      await this.#recordFailure(base, {
        failureKind: hasSqliteErrorCode(error, "SQLITE_") ? "persistence_unavailable" : "other",
        detail: boundFailureDetail(describeError(error), UNDESCRIBED_PASS_FAILURE),
        runsLeftInFlight: [...runsLeftInFlight],
        durationMs: elapsedMs(passStartedAt),
      }).catch((recordError: unknown) => {
        this.#deps.writeServiceLog(
          `Recording the failed recovery pass failed too: ${describeError(recordError)}`,
        );
      });
    } finally {
      status.markPassEnded();
    }
  }

  // A session whose log cannot be folded is degraded and the pass goes on; any other failure ends
  // the pass.
  async #rebuildProjections(tally: RecoveryTally): Promise<void> {
    const { projectionRebuild, status } = this.#deps;
    for (const sessionId of projectionRebuild.listSessionsToRebuild()) {
      status.markSessionRebuilding(sessionId);
      try {
        const rebuilt = await projectionRebuild.rebuild({ sessionId });
        tally.eventsApplied += rebuilt.eventsApplied;
        status.markSessionHealthy(sessionId);
      } catch (error) {
        if (!(error instanceof ProjectionFailureError)) {
          throw error;
        }
        status.markSessionDegraded(sessionId, projectionRebuild.readLastAppliedSequence(sessionId));
        this.#deps.writeServiceLog(
          `The projections of session ${sessionId} could not be rebuilt: ${describeError(error)}`,
        );
      }
    }
  }

  // No driver has any run after a restart, so every live run settles as the run engine decides,
  // which ends a run under the person's pending interrupt and gives that interrupt its outcome. A
  // degraded session's rows cannot be trusted, so its runs are left as they are.
  async #settleLiveRuns(tally: RecoveryTally, runsLeftInFlight: Set<RunId>): Promise<void> {
    const { runs, runEngine, status } = this.#deps;
    const liveRuns = runs.listLiveRuns().filter((run) => run.state !== "queued");
    for (const run of liveRuns) {
      runsLeftInFlight.add(run.runId);
    }
    for (const run of liveRuns) {
      if (status.isSessionDegraded(run.sessionId)) {
        continue;
      }
      const settled = await runEngine.settleRunAfterRestart(run, RESTART_FAILURE_DETAIL);
      if (settled.state === "failed") {
        tally.runsFailedDeterministically += 1;
      } else if (settled.state === "interrupted") {
        tally.runsInterrupted += 1;
      }
      runsLeftInFlight.delete(run.runId);
    }
  }

  async #recordFailure(
    base: RecoveryEventBase,
    failure: Omit<RecoveryFailedPayload, keyof RecoveryEventBase>,
  ): Promise<void> {
    await this.#record("recovery.failed", { ...base, ...failure } satisfies RecoveryFailedPayload);
  }

  async #record(
    type: "recovery.attempted" | "recovery.succeeded" | "recovery.failed",
    payload: RecoveryAttemptedPayload | RecoverySucceededPayload | RecoveryFailedPayload,
  ): Promise<void> {
    await this.#deps.sessionEvents.append({
      id: mintUuidV7(),
      sessionId: DAEMON_SCOPE_SENTINEL_SESSION_ID,
      occurredAt: this.#deps.now().toISOString(),
      category: "recovery_events",
      type,
      actor: null,
      payload: { ...payload },
      version: RECOVERY_EVENT_VERSION,
    });
  }
}

// Measured on the monotonic clock, so a wall-clock change during the pass does not skew it.
function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
