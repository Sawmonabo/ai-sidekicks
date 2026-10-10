// The recovery pass every start runs: it rebuilds each session's projections the log has moved
// past, settles every run the restart left live, the person's pending interrupt with it, and
// records the pass on the service's own session. The node takes no write until the pass has
// listed those sessions; from then each listed session alone refuses the calls that name it until
// it is rebuilt and its runs settled, so every other session takes its writes while the pass goes
// on. A session whose rebuild fails is healed first: the store's files are copied aside untouched,
// once a pass and once for the same damage across starts, and the rebuild runs again; one that
// still fails opens at its last good point, or reads damaged when none of it can be read. It never
// throws: a pass that fails leaves the node blocked, or a session damaged, and says why in the
// service log. The service's stop ends the pass before the next page it would fold, so the stop
// never waits on it; what the pass had yet to rebuild stays listed for the next start's pass, and
// a pass that fails once the stop came is never read as a failed store.

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
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { EventLogService } from "../events/log-service.js";
import { boundFailureDetail } from "../provider/driver/contract.js";
import type { RunEngine } from "../session/run/engine.js";
import type { LiveRun, RunStateReader } from "../session/run/read.js";
import { hasSqliteErrorCode } from "../session/sqlite-error-code.js";
import { mintUuidV7 } from "../uuid-v7.js";
import type { DamagedHistory } from "./damaged-history.js";
import { ProjectionFailureError, type ProjectionRebuildService } from "./projection-rebuild.js";
import type { RecoveryStatusTracker } from "./status.js";
import { describeRejection } from "../rejection.js";

/** What the pass reads, writes and reports through. */
export interface StartupRecoveryDeps {
  readonly nodeId: NodeId;
  readonly reader: Database;
  readonly sessionEvents: Pick<EventLogService, "append">;
  readonly projectionRebuild: Pick<ProjectionRebuildService, "listSessionsToRebuild" | "rebuild">;
  readonly damagedHistory: Pick<DamagedHistory, "rebuildThroughLastGoodPoint" | "readHeadSequence">;
  /**
   * The copies of the store's files a heal takes aside, and the damage each was taken for. The
   * pass copies the store at most once, and never again for damage already copied.
   */
  readonly storeAside: {
    /**
     * Copies the store's files aside untouched and returns where. Rejects, leaving no copy, when
     * `stopSignal` aborts.
     */
    readonly copy: (stopSignal: AbortSignal) => Promise<string>;
    /** The copy taken for the session damaged with its head at `headSequence`, if one was. */
    readonly findCopyOfSession: (
      sessionId: SessionId,
      headSequence: number,
    ) => Promise<string | undefined>;
    /** Records that the copy at `folder` was taken for the session damaged at that head. */
    readonly recordSession: (
      folder: string,
      sessionId: SessionId,
      headSequence: number,
    ) => Promise<void>;
  };
  readonly runs: Pick<RunStateReader, "listLiveRuns">;
  readonly runEngine: Pick<RunEngine, "settleRunAfterRestart">;
  readonly status: RecoveryStatusTracker;
  /** Told what failed the store, so a damaged file is repaired. */
  readonly reportStoreFailure: (error: unknown) => void;
  /** Aborts when the service stops, which ends the pass. */
  readonly stopSignal: AbortSignal;
  readonly now: () => Date;
  readonly writeServiceLog: (line: string) => void;
}

// Where the pass's heal stands: the folder the store's files were copied to, once they were.
interface HealState {
  asideFolder: string | undefined;
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

/** What a run the restart left live carries as its failure when nothing resumed it. */
export const RESTART_FAILURE_DETAIL = "The service restarted and no provider session was restored";

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

      // A stale session's runs are read from its projection once it is rebuilt; every other
      // session's are read now, before the node takes a write that could start a new one.
      const sessionsToRebuild = new Set(this.#deps.projectionRebuild.listSessionsToRebuild());
      const runsOfCurrentSessions = this.#deps.runs
        .listLiveRuns()
        .filter((run) => run.state !== "queued" && !sessionsToRebuild.has(run.sessionId));
      for (const sessionId of [
        ...sessionsToRebuild,
        ...runsOfCurrentSessions.map((run) => run.sessionId),
      ]) {
        status.markSessionRebuilding(sessionId);
      }
      status.markPassListed();

      base.phase = "run_resumption";
      for (const run of runsOfCurrentSessions) {
        status.markSessionSettling(run.sessionId);
      }
      await this.#settleLiveRuns(runsOfCurrentSessions, tally, runsLeftInFlight);
      for (const run of runsOfCurrentSessions) {
        this.#markListedSessionHealthy(run.sessionId);
      }
      base.phase = "projection_rebuild";
      await this.#rebuildProjections(sessionsToRebuild, tally, runsLeftInFlight);
      base.phase = "run_resumption";

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
      // A step the stop ended, or one that failed as the stop closed what it used, says nothing
      // of the store.
      if (this.#deps.stopSignal.aborted) {
        this.#logStop();
        return;
      }
      // A failure outside one session's fold is the store's: nothing more can be trusted.
      status.markStoreFailed();
      this.#deps.reportStoreFailure(error);
      this.#deps.writeServiceLog(`The recovery pass failed: ${describeRejection(error)}`);
      await this.#recordFailure(base, {
        failureKind: hasSqliteErrorCode(error, "SQLITE_") ? "persistence_unavailable" : "other",
        detail: boundFailureDetail(describeRejection(error), UNDESCRIBED_PASS_FAILURE),
        runsLeftInFlight: [...runsLeftInFlight],
        durationMs: elapsedMs(passStartedAt),
      }).catch((recordError: unknown) => {
        this.#deps.writeServiceLog(
          `Recording the failed recovery pass failed too: ${describeRejection(recordError)}`,
        );
      });
    } finally {
      status.markPassEnded();
    }
  }

  // Rebuilds each session, then settles its runs the restart left live. A session whose log
  // cannot be folded is healed and the pass goes on; any other failure ends the pass.
  async #rebuildProjections(
    sessionsToRebuild: ReadonlySet<SessionId>,
    tally: RecoveryTally,
    runsLeftInFlight: Set<RunId>,
  ): Promise<void> {
    const { projectionRebuild, runs } = this.#deps;
    const heal: HealState = { asideFolder: undefined };
    const { stopSignal } = this.#deps;
    for (const sessionId of sessionsToRebuild) {
      try {
        const rebuilt = await projectionRebuild.rebuild({ sessionId, stopSignal });
        tally.eventsApplied += rebuilt.eventsApplied;
      } catch (error) {
        if (!(error instanceof ProjectionFailureError)) {
          throw error;
        }
        this.#deps.writeServiceLog(
          `The projections of session ${sessionId} could not be rebuilt: ${describeRejection(error)}`,
        );
        await this.#healSession(sessionId, heal, tally);
      }
      // The session has refused every call since the listing, so each live run is one the
      // restart left.
      const liveRuns = runs
        .listLiveRuns()
        .filter((run) => run.state !== "queued" && run.sessionId === sessionId);
      this.#deps.status.markSessionSettling(sessionId);
      await this.#settleLiveRuns(liveRuns, tally, runsLeftInFlight);
      this.#markListedSessionHealthy(sessionId);
    }
  }

  // The store's files go aside before anything is repaired, unless they already went for this
  // damage; then the rebuild runs again, and a session it still cannot rebuild opens at its last
  // good point.
  async #healSession(sessionId: SessionId, heal: HealState, tally: RecoveryTally): Promise<void> {
    const { projectionRebuild, damagedHistory, status, storeAside } = this.#deps;
    // A damaged session takes no write, so its head names the damage until it is continued.
    const headSequence = damagedHistory.readHeadSequence(sessionId);
    const earlierCopy = await storeAside.findCopyOfSession(sessionId, headSequence);
    // The copy this heal records the damage in; none when an earlier start already copied it.
    let thisPassCopy: string | undefined;
    if (earlierCopy !== undefined) {
      this.#deps.writeServiceLog(`The store's files were already copied aside to ${earlierCopy}`);
    } else {
      if (heal.asideFolder === undefined) {
        // A copy of a large store takes a while, so a stop that came first never starts one.
        this.#deps.stopSignal.throwIfAborted();
        heal.asideFolder = await storeAside.copy(this.#deps.stopSignal);
        this.#deps.writeServiceLog(`The store's files were copied aside to ${heal.asideFolder}`);
      }
      thisPassCopy = heal.asideFolder;
    }
    let failure: ProjectionFailureError;
    try {
      const rebuilt = await projectionRebuild.rebuild({
        sessionId,
        force: true,
        stopSignal: this.#deps.stopSignal,
      });
      tally.eventsApplied += rebuilt.eventsApplied;
      return;
    } catch (error) {
      if (!(error instanceof ProjectionFailureError)) {
        throw error;
      }
      failure = error;
    }
    const point = await damagedHistory.rebuildThroughLastGoodPoint(sessionId, failure);
    if (thisPassCopy !== undefined) {
      await storeAside.recordSession(thisPassCopy, sessionId, headSequence);
    }
    if (point === undefined) {
      status.markSessionUnreadable(sessionId);
      this.#deps.writeServiceLog(`No event of session ${sessionId} can be read`);
      return;
    }
    status.markSessionAtLastGoodPoint(sessionId, point);
    this.#deps.writeServiceLog(
      `Session ${sessionId} opens at sequence ${String(point.lastSequence)}; its events from ` +
        `sequence ${String(point.damagedFromSequence)} are damaged and kept in place`,
    );
  }

  // No driver has any run after a restart, so every live run settles as the run engine decides,
  // which ends a run under the person's pending interrupt and gives that interrupt its outcome. A
  // damaged session takes no writes, so its runs are left as they are.
  async #settleLiveRuns(
    liveRuns: readonly LiveRun[],
    tally: RecoveryTally,
    runsLeftInFlight: Set<RunId>,
  ): Promise<void> {
    const { runEngine, status } = this.#deps;
    for (const run of liveRuns) {
      runsLeftInFlight.add(run.runId);
    }
    for (const run of liveRuns) {
      if (status.readSessionWriteRefusal(run.sessionId) !== undefined) {
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

  #logStop(): void {
    this.#deps.writeServiceLog(
      "The service's stop ended the recovery pass; its next start rebuilds what it had yet to",
    );
  }

  // A session the pass listed takes calls again, unless its heal left its history damaged.
  #markListedSessionHealthy(sessionId: SessionId): void {
    const { status } = this.#deps;
    if (status.readSessionWriteRefusal(sessionId) === undefined) {
      status.markSessionHealthy(sessionId);
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
