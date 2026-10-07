// The run engine: every run state change goes through it, each checked against the table and
// written with the run's row, and each terminal followed by the terminal hooks of the setup gates.

import type { Database } from "better-sqlite3";

import {
  EventEnvelopeVersionSchema,
  type EventEnvelopeVersion,
} from "@ai-sidekicks/contracts/event/envelope";
import type { ProcessExit } from "@ai-sidekicks/contracts/run/control";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { QueueItemSummary } from "@ai-sidekicks/contracts/run/queue";
import type { ExecutionPosture } from "@ai-sidekicks/contracts/provider/driver/capabilities";
import type { InterventionType } from "@ai-sidekicks/contracts/provider/driver/intervention";

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
import { RunStateReader, type LiveRun, type RunRead } from "./read.js";
import { RunInvalidTransitionError } from "./refusals.js";
import {
  PendingInterruptReader,
  decideRestartSettlement,
  pendingInterruptStatement,
} from "./restart.js";
import { RunSetupGates, type RunSetupGate } from "./setup-gates.js";
import { RunStateChangeWriter, type RunStateChange } from "./state-change.js";
import { isTerminalState } from "./transitions.js";

// Parsed at load so a bad literal throws at import, not at the first change.
const RUN_STATE_CHANGE_EVENT_VERSION: EventEnvelopeVersion =
  EventEnvelopeVersionSchema.parse("1.0");

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
  readonly #gates = new RunSetupGates();

  constructor(deps: RunEngineDeps) {
    this.#runs = new RunStateReader(deps.reader);
    this.#pendingInterrupts = new PendingInterruptReader(deps.reader);
    this.#changes = new RunStateChangeWriter(
      this.#runs,
      new SessionEventAppender(deps, RUN_STATE_CHANGE_EVENT_VERSION),
    );
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
    const { runId, queueItem, driver, driverParams, executionPosture } = request;
    const starting = await this.#change({ runId, expectedState: "queued", newState: "starting" });
    await this.#gates.assertRunReady({ runId, sessionId: starting.sessionId, queueItem });

    // An interrupt may have landed while a gate ran; a run no longer starting is not started.
    const afterGates = this.#runs.getRun(runId);
    if (afterGates !== undefined && afterGates.state !== "starting") {
      throw new RunInvalidTransitionError(runId, afterGates.state, "running");
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
   * Carries a recorded intervention outcome into the run's state: an interrupt, applied or
   * degraded, ends the run `interrupted`; a steer or a faster-model retry changes no state.
   */
  async settleInterventionOutcome(outcome: {
    runId: RunId;
    interventionType: InterventionType;
    state: "applied" | "degraded";
  }): Promise<void> {
    if (outcome.interventionType === "interrupt") {
      await this.#change({ runId: outcome.runId, newState: "interrupted" });
    }
  }

  /**
   * Ends the turn a provider process left when it ended on its own: the run, and each live run
   * the provider dispatched beneath it as its own subagent, ends `failed` with `processExit`.
   * Waiting messages stay waiting. Every run is ended before any failure is thrown, together.
   */
  async endTurnOnProcessExit(runId: RunId, processExit: ProcessExit): Promise<void> {
    const failures: unknown[] = [];
    for (const endedRunId of [runId, ...this.#listLiveProviderSubagents(runId)]) {
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
    const hasPendingInterrupt = this.#pendingInterrupts.hasPendingInterrupt(run.runId);
    const settlement = decideRestartSettlement(run, hasPendingInterrupt);
    if (settlement === undefined) {
      return run;
    }
    const guard = [pendingInterruptStatement(run.runId, hasPendingInterrupt)];
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

  // The live runs reached from `runId` through provider subagents at any depth, which share its
  // process; a child reached any other way runs in a process of its own.
  #listLiveProviderSubagents(runId: RunId): RunId[] {
    const childrenByParent = new Map<RunId, RunId[]>();
    for (const live of this.#runs.listLiveRuns()) {
      if (live.reachedBy === "provider_subagent" && live.parentRunId !== undefined) {
        childrenByParent.set(live.parentRunId, [
          ...(childrenByParent.get(live.parentRunId) ?? []),
          live.runId,
        ]);
      }
    }
    const reached: RunId[] = [];
    const pending = [runId];
    for (let parent = pending.pop(); parent !== undefined; parent = pending.pop()) {
      const children = childrenByParent.get(parent) ?? [];
      reached.push(...children);
      pending.push(...children);
    }
    return reached;
  }
}
