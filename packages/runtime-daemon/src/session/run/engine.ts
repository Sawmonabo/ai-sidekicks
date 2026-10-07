// The run engine: every run state change goes through it, each checked against the table and
// written with the run's row, and each terminal followed by the terminal hooks of the setup gates.
// It also tells a session when a run's provider does not run it at the fast output level it carried.

import type { Database } from "better-sqlite3";

import {
  EventEnvelopeVersionSchema,
  type EventEnvelopeVersion,
} from "@ai-sidekicks/contracts/event/envelope";
import type { ProcessExit } from "@ai-sidekicks/contracts/run/control";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { RunState } from "@ai-sidekicks/contracts/run/state";
import type { QueueItemSummary } from "@ai-sidekicks/contracts/run/queue";
import type { ExecutionPosture } from "@ai-sidekicks/contracts/provider/driver/capabilities";
import type { InterventionType } from "@ai-sidekicks/contracts/provider/driver/intervention";
import type { ProviderOutputSpeedState } from "@ai-sidekicks/contracts/provider/driver/output-speed";
import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";
import type { SessionNoticePayload } from "@ai-sidekicks/contracts/session/controls/events";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { WriteStatement } from "../../database/statement.js";
import {
  SessionEventAppender,
  type SessionEventAppenderDeps,
} from "../../events/session/appender.js";
import {
  boundFailureDetail,
  type ProviderDriver,
  type StartRunParams,
} from "../../provider/driver/contract.js";
import { PROVIDER_DRIVER_DESCRIPTORS } from "../../provider/driver/descriptor.js";
import { RunStateReader, type LiveRun, type RunRead } from "./read.js";
import { RunAlreadyEndedError, RunInvalidTransitionError } from "./refusals.js";
import {
  PendingInterruptReader,
  decideRestartSettlement,
  pendingInterruptStatement,
} from "./restart.js";
import { RunSetupGates, type RunSetupGate } from "./setup-gates.js";
import { RunStateChangeWriter, type RunStateChange } from "./state-change.js";
import { isTerminalState } from "./transitions.js";

// Parsed at load so a bad literal throws at import, not at the first change.
const RUN_ENGINE_EVENT_VERSION: EventEnvelopeVersion = EventEnvelopeVersionSchema.parse("1.0");

const DRIVER_START_FAILURE_FALLBACK = "The provider could not start the run";
const RESTART_FAILURE_FALLBACK = "The run could not be resumed after the service restarted";

/**
 * A state change a caller asks for. `run.running` carries the run's posture only from
 * {@link RunEngine.startRun}, which stamps what it handed the driver.
 */
export type RunTransitionRequest =
  | Exclude<RunStateChange, { newState: "running" }>
  | Omit<Extract<RunStateChange, { newState: "running" }>, "executionPosture">;

/** What {@link RunEngine.startRun} needs: the admitted item, the driver, and what it is handed. */
export interface RunStartRequest {
  readonly runId: RunId;
  readonly queueItem: QueueItemSummary;
  /** The provider the run runs on, whose standard output speed its settled state is read against. */
  readonly provider: ProviderName;
  readonly driver: Pick<ProviderDriver, "startRun">;
  readonly driverParams: Omit<StartRunParams, "runId" | "executionPosture">;
  /** The run's effective posture: handed to the driver and stamped on `run.running` as is. */
  readonly executionPosture: ExecutionPosture;
}

/** What the run engine reads and writes through. */
export interface RunEngineDeps extends SessionEventAppenderDeps {
  /** The daemon's read-only connection. */
  readonly reader: Database;
}

/** Owns every run state change and the setup gates a run passes before its provider starts it. */
export class RunEngine {
  readonly #runs: RunStateReader;
  readonly #pendingInterrupts: PendingInterruptReader;
  readonly #changes: RunStateChangeWriter;
  readonly #appender: SessionEventAppender;
  readonly #gates = new RunSetupGates();
  // The fast output level each started run carried, until its settled state is reported or it
  // ends, so the map holds at most the runs started and not yet settled or ended.
  readonly #carriedOutputSpeedByRun = new Map<RunId, string>();

  constructor(deps: RunEngineDeps) {
    this.#runs = new RunStateReader(deps.reader);
    this.#pendingInterrupts = new PendingInterruptReader(deps.reader);
    this.#appender = new SessionEventAppender(deps, RUN_ENGINE_EVENT_VERSION);
    this.#changes = new RunStateChangeWriter(this.#runs, this.#appender);
  }

  /** Adds a setup gate after those already registered; its terminal hook runs before theirs. */
  registerSetupGate(gate: RunSetupGate): void {
    this.#gates.register(gate);
  }

  /**
   * Moves the run as `request` asks and resolves with the run as the change left it. A terminal
   * runs every terminal hook once it has committed; a hook's failure is thrown after all have run,
   * as an `AggregateError`, with the change kept. Refuses as {@link RunStateChangeWriter.write}.
   */
  async transition(request: RunTransitionRequest): Promise<RunRead> {
    return this.#change(request);
  }

  /**
   * Starts a queued run: `starting`, every setup gate in order, the driver's start, then `running`
   * stamped with the posture the driver was handed. A gate's throw leaves the run in `starting`
   * and throws `RunParkedInSetupError`; a driver's throw ends the run `failed` and is rethrown.
   */
  async startRun(request: RunStartRequest): Promise<RunRead> {
    const { runId, queueItem, provider, driver, driverParams, executionPosture } = request;
    const starting = await this.#change({ runId, expectedState: "queued", newState: "starting" });
    await this.#gates.assertRunReady({ runId, sessionId: starting.sessionId, queueItem });

    // An interrupt may have landed while a gate ran; a run no longer starting is not started.
    const afterGates = this.#runs.getRun(runId);
    if (afterGates !== undefined && afterGates.state !== "starting") {
      throw new RunInvalidTransitionError(runId, afterGates.state, "running");
    }

    // Held before the driver starts, since the driver may report the settled state at once.
    const carriedOutputSpeed = driverParams.outputSpeed;
    if (
      carriedOutputSpeed !== undefined &&
      carriedOutputSpeed !== PROVIDER_DRIVER_DESCRIPTORS[provider].standardOutputSpeed
    ) {
      this.#carriedOutputSpeedByRun.set(runId, carriedOutputSpeed);
    }
    try {
      await driver.startRun({ ...driverParams, runId, executionPosture });
    } catch (driverError) {
      await this.#failStart(runId, driverError);
      throw driverError;
    }
    return this.#change({
      runId,
      expectedState: "starting",
      newState: "running",
      executionPosture,
    });
  }

  /**
   * Moves the run as a provider reported, as {@link transition} does, unless the run has already
   * ended: then a terminal is refused with {@link RunAlreadyEndedError} and any other change with
   * {@link RunInvalidTransitionError} from the ended state, whether the run read ended or ended
   * inside the write. A send's re-open of an ended run is the daemon's, never a provider's.
   */
  async applyProviderStateChange(change: RunTransitionRequest): Promise<RunRead> {
    const run = this.#runs.getRun(change.runId);
    if (run !== undefined && isTerminalState(run.state)) {
      throw endedRunRefusal(change, run.state);
    }
    return this.#change(change);
  }

  /**
   * Compares a run's settled output speed with the fast level it carried and, where the provider
   * runs it at another state, appends one `fast_output_unavailable` notice with the provider's
   * reason. Only the first report for a started run is compared; a later one finds nothing.
   */
  async recordSettledOutputSpeed(
    sessionId: SessionId,
    runId: RunId,
    state: ProviderOutputSpeedState,
  ): Promise<void> {
    const carried = this.#carriedOutputSpeedByRun.get(runId);
    if (carried === undefined) {
      return;
    }
    this.#carriedOutputSpeedByRun.delete(runId);
    if (state.declared === carried) {
      return;
    }
    const notice: SessionNoticePayload = {
      sessionId,
      kind: "fast_output_unavailable",
      ...(state.reason === undefined ? {} : { reason: state.reason }),
    };
    await this.#appender.append("session.notice", notice, {});
  }

  /**
   * Carries a recorded intervention outcome into the run's state: an interrupt, applied or
   * degraded, ends the run `interrupted`, or leaves it as it is when it has already ended; a steer
   * or a faster-model retry changes no state.
   */
  async settleInterventionOutcome(outcome: {
    runId: RunId;
    interventionType: InterventionType;
    state: "applied" | "degraded";
  }): Promise<void> {
    if (outcome.interventionType !== "interrupt") {
      return;
    }
    try {
      await this.#change({ runId: outcome.runId, newState: "interrupted" });
    } catch (error) {
      // The run ended before the settle, which is what the interrupt asked for.
      if (error instanceof RunAlreadyEndedError) {
        return;
      }
      throw error;
    }
  }

  /**
   * Ends the turn a provider process left when it ended on its own: the run, and each live run
   * the provider dispatched beneath it as its own subagent, ends `failed` with `processExit`.
   * Every run is ended before any failure is thrown, together.
   */
  async endTurnOnProcessExit(runId: RunId, processExit: ProcessExit): Promise<void> {
    const failures: unknown[] = [];
    for (const endedRunId of [runId, ...this.#runs.listLiveProviderSubagents(runId)]) {
      try {
        await this.#change({
          runId: endedRunId,
          newState: "failed",
          failureCategory: "provider failure",
          processExit,
        });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Ending the turn of run ${runId} on its process's exit failed`,
      );
    }
  }

  /**
   * Settles one run a restart left live that recovery could not resume, without calling any
   * driver: `interrupted` when the person's interrupt was pending or it is a child held in a pause,
   * otherwise `failed` as a provider failure that needs recovery, carrying `failureDetail`. A
   * queued run is left as it is.
   */
  async settleRunAfterRestart(run: LiveRun, failureDetail: string): Promise<RunRead> {
    const hasPendingInterrupt = this.#pendingInterrupts.hasPendingInterrupt(run);
    const settlement = decideRestartSettlement(run, hasPendingInterrupt);
    if (settlement === undefined) {
      return run;
    }
    const guard = [pendingInterruptStatement(run, hasPendingInterrupt)];
    if (settlement === "interrupted") {
      return this.#change({ runId: run.runId, newState: "interrupted" }, guard);
    }
    return this.#change(
      {
        runId: run.runId,
        newState: "failed",
        failureCategory: "provider failure",
        recoveryCondition: "recovery-needed",
        providerFailureDetail: boundFailureDetail(failureDetail, RESTART_FAILURE_FALLBACK),
      },
      guard,
    );
  }

  async #change(change: RunStateChange, extraGuards?: readonly WriteStatement[]): Promise<RunRead> {
    const run = await this.#changes.write(change, extraGuards);
    if (isTerminalState(run.state)) {
      this.#carriedOutputSpeedByRun.delete(change.runId);
      await this.#gates.releaseForTerminal({
        runId: change.runId,
        sessionId: run.sessionId,
        terminalState: run.state,
        runVersion: run.version,
      });
    }
    return run;
  }

  async #failStart(runId: RunId, driverError: unknown): Promise<void> {
    const detail = driverError instanceof Error ? driverError.message : String(driverError);
    try {
      await this.#change({
        runId,
        expectedState: "starting",
        newState: "failed",
        failureCategory: "provider failure",
        providerFailureDetail: boundFailureDetail(detail, DRIVER_START_FAILURE_FALLBACK),
      });
    } catch (failError) {
      throw new AggregateError(
        [driverError, failError],
        `The driver could not start run ${runId}, and ending the run failed too`,
        { cause: failError },
      );
    }
  }
}

// The refusal of a provider's change to a run that has ended in `endedState`.
function endedRunRefusal(
  change: RunTransitionRequest,
  endedState: RunState,
): RunInvalidTransitionError {
  return isTerminalState(change.newState)
    ? new RunAlreadyEndedError(change.runId, endedState, change.newState)
    : new RunInvalidTransitionError(change.runId, endedState, change.newState);
}
