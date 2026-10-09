// The run engine: every run state change goes through it, each checked against the table and
// written with the run's row, and each terminal followed by the terminal hooks of the setup gates.
// It also starts the runs of the turns the daemon starts on a session itself and of a provider's
// own subagents, records the markers a provider reports on a live run, and tells a session when a
// run's provider does not run it at the fast output level it carried.

import type { Database } from "better-sqlite3";

import {
  EventEnvelopeVersionSchema,
  type EventEnvelopeVersion,
} from "@ai-sidekicks/contracts/event/envelope";
import type { ProcessExit } from "@ai-sidekicks/contracts/run/control";
import type { RunSetupFailedCause } from "@ai-sidekicks/contracts/run/failure-cause";
import type { InterruptReason } from "@ai-sidekicks/contracts/orchestration";
import type {
  InterventionEventPayload,
  RunProviderInitializedPayload,
  RunTurnStartedPayload,
  RunWorkerShutdownPayload,
} from "@ai-sidekicks/contracts/run/events";
import { RunIdSchema, type RunId } from "@ai-sidekicks/contracts/run/id";
import type { RunQueuedPayload } from "@ai-sidekicks/contracts/run/queued";
import type { RunState } from "@ai-sidekicks/contracts/run/state";
import type { QueueItemSummary } from "@ai-sidekicks/contracts/run/queue";
import type { ExecutionPosture } from "@ai-sidekicks/contracts/provider/driver/capabilities";
import { ProviderAccountIdSchema } from "@ai-sidekicks/contracts/provider/account/record";
import type { ProviderOutputSpeedState } from "@ai-sidekicks/contracts/provider/driver/output-speed";
import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";
import type { SessionNoticePayload } from "@ai-sidekicks/contracts/session/controls/events";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { WriteStatement } from "../../database/statement.js";
import { WriteRefusedError } from "../../database/writer.js";
import { DaemonDomainError } from "../../ipc/domain-error.js";
import {
  SessionEventAppender,
  type SessionEventAppenderDeps,
  type SessionEventDraft,
} from "../../events/session/appender.js";
import { moveInterventionStatement, runAtVersionStatement } from "../../interventions/store.js";
import type { ExecutionPostureService } from "../../policy/execution-posture-service.js";
import {
  boundFailureDetail,
  type ProviderDriver,
  type StartRunParams,
} from "../../provider/driver/contract.js";
import { PROVIDER_DRIVER_DESCRIPTORS } from "../../provider/driver/descriptor.js";
import { mintUuidV7 } from "../../uuid-v7.js";
import { insertQueuedRunStatement } from "./projection.js";
import { RunStateReader, type LiveRun, type RunRead } from "./read.js";
import { RunAlreadyEndedError, RunInvalidTransitionError, RunNotFoundError } from "./refusals.js";
import {
  PendingInterruptReader,
  decideRestartSettlement,
  noPendingInterruptStatement,
  type PendingInterrupt,
} from "./restart.js";
import { RunSetupGates, type RunSetupGate } from "./setup-gates.js";
import {
  RunStateChangeWriter,
  type RunStateChange,
  type RunStateChangeCompanions,
} from "./state-change.js";
import { isTerminalState } from "./transitions.js";
import { describeRejection } from "../../rejection.js";

// Parsed at load so a bad literal throws at import, not at the first change.
const RUN_ENGINE_EVENT_VERSION: EventEnvelopeVersion = EventEnvelopeVersionSchema.parse("1.0");

const DRIVER_START_FAILURE_FALLBACK = "The provider could not start the run";
const RESTART_FAILURE_FALLBACK = "The run could not be resumed after the service restarted";
const SETUP_FAILURE_FALLBACK = "The run's setup failed";
const RESTART_INTERRUPT_TRIGGER: InterruptReason = "daemon_restart";
// Reads of a live run before a guarded append gives up on a run that keeps moving under it.
const LIVE_APPEND_ATTEMPTS = 3;
// The guard on the version a live append was built from is the first statement of its write.
const LIVE_APPEND_VERSION_GUARD_INDEX = 0;

/**
 * Where an interrupt of a run goes: `claimed` by the engine for a run no driver has, whose end is
 * left to the interrupt's own outcome; to the `driver`, which has the run to stop; or nowhere, the
 * run having `ended`.
 */
export type InterruptRoute = "claimed" | "driver" | "ended";

// A run no driver has yet, from `starting` until the driver has it or the run ends. It is
// `claimable` while its setup gates run and after a start that left it live without a driver, and
// `settling` from the gates' end until its start settles, when an interrupt waits for `settled`.
interface StartingRun {
  phase: "claimable" | "settling";
  isInterrupted: boolean;
  hasEnded: boolean;
  // Whether the driver has the run, once the start has settled and its `running` write landed.
  readonly settled: Promise<boolean>;
}

/**
 * A state change a caller asks for. `run.running` carries the run's posture only from
 * {@link RunEngine.startRun}, which stamps what it handed the driver.
 */
export type RunTransitionRequest =
  | Exclude<RunStateChange, { newState: "running" }>
  | Omit<Extract<RunStateChange, { newState: "running" }>, "executionPosture">;

type RunMarkerPayloadByType = {
  "run.provider_initialized": RunProviderInitializedPayload;
  "run.turn_started": RunTurnStartedPayload;
  "run.worker_shutdown": RunWorkerShutdownPayload;
};

/**
 * A marker a provider reports on a live run, which changes no state. Its payload leaves out the
 * session and run version, which the engine reads from the run when it records the marker.
 */
export type RunMarker = {
  [Type in keyof RunMarkerPayloadByType]: {
    readonly type: Type;
    readonly payload: Omit<RunMarkerPayloadByType[Type], "sessionId" | "runVersion">;
  };
}[keyof RunMarkerPayloadByType];

// A row a live append writes, with the statements that go in its write after the version guard.
interface LiveAppend extends SessionEventDraft {
  readonly statements?: readonly WriteStatement[] | undefined;
}

/** What {@link RunEngine.startRun} needs: the admitted item, the driver, and what it is handed. */
export interface RunStartRequest {
  readonly runId: RunId;
  readonly queueItem: QueueItemSummary;
  /** The provider the run runs on; its settled output speed is read against this one's standard. */
  readonly provider: ProviderName;
  readonly driver: Pick<ProviderDriver, "startRun">;
  readonly driverParams: Omit<StartRunParams, "runId" | "executionPosture">;
  /**
   * The posture the run was requested at; the posture gate checks it, and its resolved form is what
   * the driver is handed and `run.running` is stamped with.
   */
  readonly executionPosture: ExecutionPosture;
}

/**
 * What {@link RunEngine.startDaemonTurn} needs: the session whose own run the turn is, the account
 * its process was admitted against, the posture it runs at, and the driver's start of the turn.
 */
export interface DaemonTurnStartRequest {
  readonly sessionId: SessionId;
  readonly provider: ProviderName;
  /** The account the session's process was admitted against, or `null` for none. */
  readonly admittedProviderAccountId: string | null;
  /** The session's current level and roots, which the turn runs at like any run. */
  readonly executionPosture: ExecutionPosture;
  /**
   * The driver's start of the turn under the new run's id: it binds the run and writes the turn's
   * opening, and resolves once it is written. A throw ends the run `failed`.
   */
  readonly startTurn: (runId: RunId) => Promise<void>;
}

// How one start reaches its driver, handed the run's resolved posture, and the posture requested.
interface RunStartPath {
  readonly provider: ProviderName;
  readonly outputSpeed: string | undefined;
  readonly executionPosture: ExecutionPosture;
  readonly startDriver: (resolvedPosture: ExecutionPosture) => Promise<void>;
}

/** What the run engine reads and writes through. */
export interface RunEngineDeps extends SessionEventAppenderDeps {
  /** The daemon's read-only connection. */
  readonly reader: Database;
  /**
   * The posture gate, registered as the first setup gate; every start reads the run's resolved
   * posture from it.
   */
  readonly executionPostures: ExecutionPostureService;
}

/** Owns every run state change and the setup gates a run passes before its provider starts it. */
export class RunEngine {
  readonly #runs: RunStateReader;
  readonly #pendingInterrupts: PendingInterruptReader;
  readonly #changes: RunStateChangeWriter;
  readonly #appender: SessionEventAppender;
  readonly #gates = new RunSetupGates();
  readonly #executionPostures: ExecutionPostureService;
  // The runs no driver has yet; an entry goes once the driver has its run or the run ends.
  readonly #startingRuns = new Map<RunId, StartingRun>();
  // The fast output level each started run carried, until its settled state is reported or it
  // ends, so the map holds at most the runs started and not yet settled or ended.
  readonly #carriedOutputSpeedByRun = new Map<RunId, string>();

  constructor(deps: RunEngineDeps) {
    this.#runs = new RunStateReader(deps.reader);
    this.#pendingInterrupts = new PendingInterruptReader(deps.reader);
    this.#appender = new SessionEventAppender(deps, RUN_ENGINE_EVENT_VERSION);
    this.#changes = new RunStateChangeWriter(this.#runs, this.#appender);
    this.#executionPostures = deps.executionPostures;
    this.#gates.register(deps.executionPostures);
  }

  /**
   * Routes an interrupt of `runId` so it never reaches a driver that does not have the run. A run
   * in its setup gates, or left live by a start that failed without writing its end, is claimed at
   * once and never started. A run past its gates and still starting answers once its start has
   * settled and its `running` write landed: `ended` when the run ended meanwhile, `driver` when the
   * driver has it, and `claimed` when the start failed and its end could not be written. Any other
   * run is the driver's to stop.
   */
  async routeInterrupt(runId: RunId): Promise<InterruptRoute> {
    const startingRun = this.#startingRuns.get(runId);
    if (startingRun === undefined) {
      return "driver";
    }
    if (startingRun.phase === "claimable") {
      startingRun.isInterrupted = true;
      return "claimed";
    }
    const hasDriverRun = await startingRun.settled;
    if (startingRun.hasEnded) {
      return "ended";
    }
    return hasDriverRun ? "driver" : "claimed";
  }

  /** Adds a setup gate after those already registered; its terminal hook runs before theirs. */
  registerSetupGate(gate: RunSetupGate): void {
    this.#gates.register(gate);
  }

  /**
   * Moves the run as `request` asks, with `companions` in the same write, and resolves with the run
   * as the change left it. A terminal runs every terminal hook once it has committed; a hook's
   * failure is thrown after all have run, as an `AggregateError`, with the change kept. Refuses as
   * {@link RunStateChangeWriter.write}, a companion guard by its `WriteRefusedError`.
   */
  async transition(
    request: RunTransitionRequest,
    companions?: RunStateChangeCompanions,
  ): Promise<RunRead> {
    return this.#change(request, companions);
  }

  /**
   * Starts a queued run: `starting`, every setup gate in order, the driver's start with the posture
   * the posture gate resolved, then `running` stamped with that posture. A gate's throw ends the
   * run `failed` with the gate's error as its cause, unless an interrupt claimed or ended it first,
   * and is rethrown; a run interrupted in its gates is never handed to the driver; a driver's throw
   * ends the run `failed` and is rethrown. An interrupt that arrives after the gates is routed once
   * the start settles (see {@link routeInterrupt}).
   */
  async startRun(request: RunStartRequest): Promise<RunRead> {
    const { runId, queueItem, provider, driver, driverParams, executionPosture } = request;
    return await this.#start(runId, queueItem, {
      provider,
      outputSpeed: driverParams.outputSpeedForTurn ?? driverParams.outputSpeed,
      executionPosture,
      startDriver: async (resolvedPosture) => {
        await driver.startRun({ ...driverParams, runId, executionPosture: resolvedPosture });
      },
    });
  }

  /**
   * Starts a turn the daemon starts on a session itself, such as a goal or a review, as the
   * session's own run: `run.queued` with no parent, then the start {@link startRun} makes, its
   * setup gates given no queue item, and resolves with the new run's id once it is `running`.
   * Throws as {@link startRun} does.
   */
  async startDaemonTurn(request: DaemonTurnStartRequest): Promise<RunId> {
    const runId = RunIdSchema.parse(mintUuidV7());
    const accountId = request.admittedProviderAccountId;
    const queued: RunQueuedPayload = {
      sessionId: request.sessionId,
      runId,
      runVersion: 0,
      newState: "queued",
      ...(accountId === null
        ? {}
        : { admittedProviderAccountId: ProviderAccountIdSchema.parse(accountId) }),
    };
    await this.#appender.append("run.queued", queued, {
      transactionalPrelude: [insertQueuedRunStatement(queued)],
    });
    await this.#start(runId, undefined, {
      provider: request.provider,
      outputSpeed: undefined,
      executionPosture: request.executionPosture,
      startDriver: async () => {
        await request.startTurn(runId);
      },
    });
    return runId;
  }

  // `starting`, every setup gate, the driver's start, then `running`; see {@link startRun}.
  async #start(
    runId: RunId,
    queueItem: QueueItemSummary | undefined,
    startPath: RunStartPath,
  ): Promise<RunRead> {
    const { provider, executionPosture } = startPath;
    const starting = await this.#change({ runId, expectedState: "queued", newState: "starting" });
    const settled = Promise.withResolvers<boolean>();
    const startingRun: StartingRun = {
      phase: "claimable",
      isInterrupted: false,
      hasEnded: false,
      settled: settled.promise,
    };
    this.#startingRuns.set(runId, startingRun);
    let hasDriverRun = false;
    try {
      try {
        await this.#gates.assertRunReady({
          runId,
          sessionId: starting.sessionId,
          queueItem,
          executionPosture,
        });
      } catch (gateError) {
        startingRun.phase = "settling";
        if (!startingRun.isInterrupted) {
          await this.#failSetup(runId, gateError);
        }
        throw gateError;
      }
      startingRun.phase = "settling";

      // An interrupt may have landed while a gate ran; a run no longer starting is not started.
      const afterGates = this.#runs.getRun(runId);
      if (afterGates === undefined) {
        throw new RunNotFoundError(runId);
      }
      if (startingRun.isInterrupted || afterGates.state !== "starting") {
        throw new RunInvalidTransitionError(runId, afterGates.state, "running");
      }
      // The driver runs at, and the run records, the posture the gate checked and resolved.
      const resolvedPosture = this.#executionPostures.resolvedPostureFor(runId);
      if (resolvedPosture === undefined) {
        const missing = new Error(`Run ${runId} passed its gates with no resolved posture`);
        await this.#failSetup(runId, missing);
        throw missing;
      }

      // Held before the driver starts, since the driver may report the settled state at once.
      const carriedOutputSpeed = startPath.outputSpeed;
      if (
        carriedOutputSpeed !== undefined &&
        carriedOutputSpeed !== PROVIDER_DRIVER_DESCRIPTORS[provider].standardOutputSpeed
      ) {
        this.#carriedOutputSpeedByRun.set(runId, carriedOutputSpeed);
      }
      try {
        await startPath.startDriver(resolvedPosture);
      } catch (driverError) {
        await this.#failStart(runId, driverError);
        throw driverError;
      }
      hasDriverRun = true;
      // Awaited before a waiting interrupt is released, so a stop the driver applies never ends
      // the run under its own `running` write.
      return await this.#change({
        runId,
        expectedState: "starting",
        newState: "running",
        executionPosture: resolvedPosture,
      });
    } finally {
      // After a failed start's end is written or its write failed: a run left live without a
      // driver stays for an interrupt to claim, until its end.
      if (hasDriverRun || startingRun.hasEnded) {
        this.#startingRuns.delete(runId);
      } else {
        startingRun.phase = "claimable";
      }
      settled.resolve(hasDriverRun);
    }
  }

  /**
   * Moves the run as a provider reported, as {@link transition} does, unless the run has already
   * ended: then a terminal is refused with {@link RunAlreadyEndedError} and any other change with
   * {@link RunInvalidTransitionError} from the ended state, whether the run read ended or ended
   * inside the write. A change for a run whose driver is still starting it waits until that start
   * has settled, since a provider can answer before `running` is written; so a driver's start never
   * waits on its own run's change. A send's re-open of an ended run is the daemon's, never a
   * provider's.
   */
  async applyProviderStateChange(change: RunTransitionRequest): Promise<RunRead> {
    const startingRun = this.#startingRuns.get(change.runId);
    if (startingRun?.phase === "settling") {
      await startingRun.settled;
    }
    const run = this.#runs.getRun(change.runId);
    if (run !== undefined && isTerminalState(run.state)) {
      throw endedRunRefusal(change, run.state);
    }
    return this.#change(change);
  }

  /**
   * Starts the run of a subagent the provider started beneath `parentRunId`, sharing its process:
   * `run.queued` naming the parent, then `starting` and `running`, and resolves with the new run's
   * id. Resolves `undefined` with nothing written when the parent has ended, and throws
   * {@link RunNotFoundError} for a parent the daemon has no run for.
   */
  async startProviderSubagentRun(parentRunId: RunId): Promise<RunId | undefined> {
    const runId = RunIdSchema.parse(mintUuidV7());
    const parent = await this.#appendWhileLive(parentRunId, (parentRun) => {
      const queued: RunQueuedPayload = {
        sessionId: parentRun.sessionId,
        runId,
        runVersion: 0,
        newState: "queued",
        parentRunId,
        reachedBy: "provider_subagent",
      };
      return {
        type: "run.queued",
        payload: queued,
        statements: [insertQueuedRunStatement(queued)],
      };
    });
    if (parent === undefined) {
      return undefined;
    }
    await this.#change({ runId, expectedState: "queued", newState: "starting" });
    await this.#change({ runId, expectedState: "starting", newState: "running" });
    return runId;
  }

  /**
   * Records `marker` on its run at the run's current version and resolves with the id of the event
   * written. Resolves `undefined` with nothing written when the run has ended, and throws
   * {@link RunNotFoundError} for a run the daemon has no row for.
   */
  async appendRunMarker(marker: RunMarker): Promise<string | undefined> {
    const recorded = await this.#appendWhileLive(marker.payload.runId, (run) => ({
      type: marker.type,
      payload: { ...marker.payload, sessionId: run.sessionId, runVersion: run.version },
    }));
    return recorded?.eventId;
  }

  /**
   * Compares a run's settled output speed with the fast level it carried and, where the provider
   * runs it at another state, appends one `fast_output_unavailable` notice naming the run, with the
   * provider's reason. Only the first report for a started run is compared; a later one finds
   * nothing.
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
      runId,
      ...(state.reason === undefined ? {} : { reason: state.reason }),
    };
    await this.#appender.append("session.notice", notice, {});
  }

  /**
   * Ends the run `interrupted` for an applied or degraded interrupt, committing `verdict`, the
   * interrupt's row move and its event, in the same write, and resolves `true`. Resolves `false`
   * with nothing written when the run has already ended, which is what the interrupt asked for;
   * the caller then records the verdict alone.
   */
  async endRunForInterrupt(runId: RunId, verdict: RunStateChangeCompanions): Promise<boolean> {
    try {
      await this.#change({ runId, newState: "interrupted" }, verdict);
    } catch (error) {
      if (error instanceof RunAlreadyEndedError) {
        return false;
      }
      throw error;
    }
    return true;
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
   * driver: `interrupted` when the person's interrupt was pending, its row moved to `applied` in
   * the run's end write, or with the restart's trigger when it is a child held in a pause,
   * otherwise `failed` as a provider failure that needs recovery, carrying `failureDetail`. A
   * queued run is left as it is.
   */
  async settleRunAfterRestart(run: LiveRun, failureDetail: string): Promise<RunRead> {
    const pendingInterrupt = this.#pendingInterrupts.readPendingInterrupt(run.runId);
    const settlement = decideRestartSettlement(run, pendingInterrupt);
    if (settlement === undefined) {
      return run;
    }
    if (pendingInterrupt !== undefined) {
      // The person's pending interrupt stays theirs; only a held child's end is the daemon's.
      return this.#change(
        { runId: run.runId, newState: "interrupted" },
        appliedInterruptOf(run, pendingInterrupt),
      );
    }
    const guard: RunStateChangeCompanions = {
      statements: [noPendingInterruptStatement(run.runId)],
    };
    if (settlement === "interrupted") {
      return this.#change(
        { runId: run.runId, newState: "interrupted", trigger: RESTART_INTERRUPT_TRIGGER },
        guard,
      );
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

  // Appends the row `build` makes from the run as it reads now, guarded on that read's version so
  // a move in between reads the run again. Resolves with the read it appended at and the event's
  // id, or `undefined` with nothing written once the run has ended.
  async #appendWhileLive(
    runId: RunId,
    build: (run: RunRead) => LiveAppend,
  ): Promise<{ readonly run: RunRead; readonly eventId: string } | undefined> {
    for (let attempt = 1; ; attempt += 1) {
      const run = this.#runs.getRun(runId);
      if (run === undefined) {
        throw new RunNotFoundError(runId);
      }
      if (isTerminalState(run.state)) {
        return undefined;
      }
      const { type, payload, statements = [] } = build(run);
      try {
        const receipt = await this.#appender.append(type, payload, {
          transactionalPrelude: [runAtVersionStatement(runId, run.version), ...statements],
        });
        return { run, eventId: receipt.id };
      } catch (error) {
        const hasRunMoved =
          error instanceof WriteRefusedError &&
          error.statementIndex === LIVE_APPEND_VERSION_GUARD_INDEX;
        if (!hasRunMoved || attempt === LIVE_APPEND_ATTEMPTS) {
          throw error;
        }
      }
    }
  }

  // A run that ends while no driver has it: an entry still settling learns it ended; a claimable one
  // has nothing left to claim.
  #markStartingRunEnded(runId: RunId): void {
    const startingRun = this.#startingRuns.get(runId);
    if (startingRun === undefined) {
      return;
    }
    startingRun.hasEnded = true;
    if (startingRun.phase === "claimable") {
      this.#startingRuns.delete(runId);
    }
  }

  async #change(change: RunStateChange, companions?: RunStateChangeCompanions): Promise<RunRead> {
    const run = await this.#changes.write(change, companions);
    if (isTerminalState(run.state)) {
      this.#carriedOutputSpeedByRun.delete(change.runId);
      this.#markStartingRunEnded(change.runId);
      await this.#gates.releaseForTerminal({
        runId: change.runId,
        sessionId: run.sessionId,
        terminalState: run.state,
        runVersion: run.version,
      });
    }
    return run;
  }

  // Ends a run whose setup gate threw `failed`, its cause the gate's error. A run an interrupt
  // moved out of `starting` while the gate ran keeps that end.
  async #failSetup(runId: RunId, gateError: unknown): Promise<void> {
    try {
      await this.#change({
        runId,
        expectedState: "starting",
        newState: "failed",
        failureCategory: "setup failure",
        failureCause: setupFailedCause(gateError),
      });
    } catch (failError) {
      if (failError instanceof RunInvalidTransitionError && failError.fromState !== "starting") {
        return;
      }
      throw new AggregateError(
        [gateError, failError],
        `A setup gate refused run ${runId}, and ending the run or a terminal hook after it failed`,
        { cause: failError },
      );
    }
  }

  async #failStart(runId: RunId, driverError: unknown): Promise<void> {
    const detail = describeRejection(driverError);
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
        `The driver could not start run ${runId}, and ending the run or a terminal hook failed`,
        { cause: failError },
      );
    }
  }
}

// The pending interrupt's row moved to `applied`, with its event, for the run's end write.
function appliedInterruptOf(
  run: LiveRun,
  pendingInterrupt: PendingInterrupt,
): RunStateChangeCompanions {
  const payload: InterventionEventPayload<"applied"> = {
    sessionId: run.sessionId,
    interventionId: pendingInterrupt.interventionId,
    targetRunId: run.runId,
    type: "interrupt",
    state: "applied",
    actor: pendingInterrupt.actor,
  };
  return {
    statements: [
      moveInterventionStatement(pendingInterrupt.interventionId, {
        from: pendingInterrupt.state,
        to: "applied",
      }),
    ],
    precedingEvents: [{ type: "intervention.applied", payload }],
  };
}

// The cause a gate's throw records: a coded daemon error's code, and the error's own words.
function setupFailedCause(gateError: unknown): RunSetupFailedCause {
  const message = boundFailureDetail(describeRejection(gateError), SETUP_FAILURE_FALLBACK);
  return gateError instanceof DaemonDomainError
    ? { cause: "setup-failed", origin: "daemon", code: gateError.code, message }
    : { cause: "setup-failed", origin: "daemon", message };
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
