// The run engine: every run state change goes through it, each checked against the table and
// written with the run's row, and each terminal followed by the terminal hooks of the setup gates.
// It also starts the runs of the turns the daemon starts on a session itself and of a provider's
// own subagents, continues an interrupted run on its next turn, records the markers a provider
// reports on a live run, and tells a session when a run's provider does not run it at the fast
// output level it carried.

import type { Database } from "better-sqlite3";

import {
  EventEnvelopeVersionSchema,
  type EventEnvelopeVersion,
} from "@ai-sidekicks/contracts/event/envelope";
import type { WorkspaceId } from "@ai-sidekicks/contracts/repo/mount";
import type { ProcessExit } from "@ai-sidekicks/contracts/run/control";
import type { RunSetupFailedCause } from "@ai-sidekicks/contracts/run/failure-cause";
import type { InterruptReason } from "@ai-sidekicks/contracts/orchestration";
import type {
  RunProviderInitializedPayload,
  RunTurnStartedPayload,
  RunWorkerShutdownPayload,
} from "@ai-sidekicks/contracts/run/events";
import { RunIdSchema, type RunId } from "@ai-sidekicks/contracts/run/id";
import type { RunQueuedPayload } from "@ai-sidekicks/contracts/run/queued";
import type { QueueItemSummary } from "@ai-sidekicks/contracts/run/queue";
import type { ProviderOutputSpeedState } from "@ai-sidekicks/contracts/provider/driver/output-speed";
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
import { runAtVersionStatement } from "../../interventions/store.js";
import type { ExecutionPostureService } from "../../policy/execution-posture-service.js";
import { boundFailureDetail } from "../../provider/driver/contract.js";
import { PROVIDER_DRIVER_DESCRIPTORS } from "../../provider/driver/descriptor.js";
import { takeOverInterruptedStatement } from "../../queue/store.js";
import { mintUuidV7 } from "../../uuid-v7.js";
import { insertQueuedRunStatement } from "./projection.js";
import { RunAgentReader } from "./agent.js";
import { queueDaemonTurnRun } from "./daemon-turn.js";
import { RunStateReader, type LiveRun, type RunRead } from "./read.js";
import {
  endedRunRefusal,
  RunAlreadyEndedError,
  RunInvalidTransitionError,
  RunNotFoundError,
} from "./refusals.js";
import {
  PendingInterruptReader,
  appliedPendingInterruptOf,
  decideRestartSettlement,
  noPendingInterruptStatement,
} from "./restart.js";
import { RunSetupGates, type RunSetupGate } from "./setup-gates.js";
import type { DaemonTurnStartRequest, RunStartPath, RunStartRequest } from "./start-request.js";
import {
  RunStateChangeWriter,
  type RunStateChange,
  type RunStateChangeCompanions,
} from "./state-change.js";
import { RUN_TERMINAL_EVENT_TYPES, isTerminalState } from "./transitions.js";
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
// An interrupt's end write runs the terminal guard, the swap, then its own guard that the run has
// not ended since the interrupt was accepted.
const INTERRUPT_END_SINCE_GUARD_INDEX = 2;

// Spelled as the unique index on terminal records spells its predicate, so the read uses it.
const SELECT_TERMINAL_SINCE_SQL = `SELECT 1 FROM session_events
  WHERE category = 'run_lifecycle'
    AND type IN (${[...RUN_TERMINAL_EVENT_TYPES].map((type) => `'${type}'`).join(", ")})
    AND json_extract(payload, '$.runId') = @run_id
    AND json_extract(payload, '$.runVersion') > @run_version
  LIMIT 1`;

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

// An interrupted run being continued, until its `running` write landed or its continue failed.
// Its next turn has started once the driver started it, or at once when the provider started it.
interface ContinuingRun {
  readonly settled: Promise<void>;
  isTurnStarted: boolean;
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
  readonly #agents: RunAgentReader;
  readonly #pendingInterrupts: PendingInterruptReader;
  readonly #changes: RunStateChangeWriter;
  readonly #appender: SessionEventAppender;
  readonly #gates = new RunSetupGates();
  readonly #executionPostures: ExecutionPostureService;
  // The clock the appender stamps events with, which stamps the queue rows the engine writes too.
  readonly #now: () => string;
  // The runs no driver has yet; an entry goes once the driver has its run or the run ends.
  readonly #startingRuns = new Map<RunId, StartingRun>();
  // Each interrupted run being continued, settling once its next turn is the driver's or its
  // continue failed; what a provider reports on the run waits for it.
  readonly #continuingRuns = new Map<RunId, ContinuingRun>();
  // Each run's terminal writes in flight, settling once all have landed or been refused, so a
  // continue reads the end a provider reported just before it.
  readonly #endingRuns = new Map<RunId, Promise<void>>();
  // The fast output level each started run carried, until its settled state is reported or it
  // ends, so the map holds at most the runs started and not yet settled or ended.
  readonly #carriedOutputSpeedByRun = new Map<RunId, string>();

  constructor(deps: RunEngineDeps) {
    this.#runs = new RunStateReader(deps.reader);
    this.#agents = new RunAgentReader(deps.reader);
    this.#pendingInterrupts = new PendingInterruptReader(deps.reader);
    this.#appender = new SessionEventAppender(deps, RUN_ENGINE_EVENT_VERSION);
    this.#changes = new RunStateChangeWriter(this.#runs, this.#appender);
    this.#executionPostures = deps.executionPostures;
    this.#now = deps.now ?? (() => new Date().toISOString());
    this.#gates.register(deps.executionPostures);
  }

  /**
   * Routes an interrupt of `runId` so it never reaches a driver that does not have the run. A run
   * in its setup gates, or left live by a start that failed without writing its end, is claimed at
   * once and never started. A run past its gates and still starting answers once its start has
   * settled and its `running` write landed: `ended` when the run ended meanwhile, `driver` when the
   * driver has it, and `claimed` when the start failed and its end could not be written. A run
   * being continued answers once its continue settles, `driver` while it runs and `ended` once it
   * ended. Any other run is the driver's to stop.
   */
  async routeInterrupt(runId: RunId): Promise<InterruptRoute> {
    const continuing = this.#continuingRuns.get(runId);
    if (continuing !== undefined) {
      await continuing.settled;
      const run = this.#runs.getRun(runId);
      return run === undefined || isTerminalState(run.state) ? "ended" : "driver";
    }
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
   * ends the run `failed` and is rethrown, and so does a `running` write that fails once the driver
   * has the run, after the driver's turn is interrupted. An interrupt that arrives after the gates
   * is routed once the start settles (see {@link routeInterrupt}).
   */
  async startRun(request: RunStartRequest): Promise<RunRead> {
    return await this.#start(request.runId, request.queueItem, request.workspaceId, request);
  }

  /**
   * Starts a turn the daemon starts on a session itself, such as a goal or a review, as the
   * session's own run: `run.queued` naming the session's lead and no parent, then the start
   * {@link startRun} makes, its setup gates given no queue item, and resolves with the new run's id
   * once it is `running`. Refuses with `SessionTurnHeldError`, writing nothing, while a lead
   * run of the session is live, since a session has one, unless the turn runs in a process of its
   * own, and a turn the daemon starts while a lead message waits for the session's current lead
   * run as it rests interrupted, since that run's continue is the session's next turn. The run of a provider's own turn takes over, in its
   * `running` write, the lead messages waiting for the session's interrupted lead runs, so a turn
   * that fails to open leaves them where they were. Throws as {@link startRun} does.
   */
  async startDaemonTurn(request: DaemonTurnStartRequest): Promise<RunId> {
    const runId = await queueDaemonTurnRun(
      this.#appender,
      request,
      this.#agents.readLeadAgent(request.sessionId),
    );
    await this.#start(runId, undefined, undefined, {
      provider: request.provider,
      outputSpeed: undefined,
      executionPosture: request.executionPosture,
      startDriver: async () => {
        await request.startTurn(runId);
      },
      interruptDriver: async () => {
        await request.interruptTurn(runId);
      },
      runningStatements: request.isProviderStarted
        ? () => [takeOverInterruptedStatement(request.sessionId, runId, this.#now())]
        : undefined,
    });
    return runId;
  }

  // `starting`, every setup gate, the driver's start, then `running`; see {@link startRun}.
  async #start(
    runId: RunId,
    queueItem: QueueItemSummary | undefined,
    workspaceId: WorkspaceId | undefined,
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
          workspaceId,
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
      try {
        // Awaited before a waiting interrupt is released, so a stop the driver applies never ends
        // the run under its own `running` write.
        return await this.#change(
          {
            runId,
            expectedState: "starting",
            newState: "running",
            executionPosture: resolvedPosture,
          },
          { statements: startPath.runningStatements?.() },
        );
      } catch (runningError) {
        // The driver runs a turn the run never records as running, so the turn is interrupted and
        // the run ends: a live run with no recorded turn would hold the session for good.
        const failures = [
          ...(await failuresOf(startPath.interruptDriver)),
          ...(await failuresOf(() => this.#endFailedStart(runId, runningError))),
        ];
        if (failures.length > 0) {
          throw new AggregateError(
            [runningError, ...failures],
            `Run ${runId} could not be recorded running, and ending its turn or the run failed`,
            { cause: runningError },
          );
        }
        throw runningError;
      }
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
   * waits on its own run's change. A change for a run being continued waits for its continue the
   * same way, but a terminal before its next turn started belongs to the turn that ended it and is
   * refused at once. A send's re-open of an ended run is the daemon's, never a provider's.
   */
  async applyProviderStateChange(change: RunTransitionRequest): Promise<RunRead> {
    const startingRun = this.#startingRuns.get(change.runId);
    if (startingRun?.phase === "settling") {
      await startingRun.settled;
    }
    const continuing = this.#continuingRuns.get(change.runId);
    if (continuing !== undefined) {
      const ended = this.#runs.getRun(change.runId);
      if (
        !continuing.isTurnStarted &&
        ended !== undefined &&
        isTerminalState(ended.state) &&
        isTerminalState(change.newState)
      ) {
        throw endedRunRefusal(change.runId, change.newState, ended.state);
      }
      await continuing.settled;
    }
    const run = this.#runs.getRun(change.runId);
    if (run !== undefined && isTerminalState(run.state)) {
      throw endedRunRefusal(change.runId, change.newState, run.state);
    }
    return this.#change(change);
  }

  /**
   * Starts the run of a subagent the provider started beneath `parentRunId`, sharing its process:
   * `run.queued` naming the parent and the parent's agent, which asked its provider for the
   * subagent, then `starting` and `running`, and resolves with the new run's
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
        agentId: this.#agents.readAgent(parentRun.sessionId, parentRunId),
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
   * Ends the run `interrupted` for an applied or degraded interrupt accepted at
   * `acceptedRunVersion`, committing `verdict`, the interrupt's row move and its event, in the
   * same write, and resolves `true`. Resolves `false` with nothing written when the run has ended
   * since that version, even if it was continued after, which is what the interrupt asked for; the
   * caller then records the verdict alone.
   */
  async endRunForInterrupt(
    runId: RunId,
    acceptedRunVersion: number,
    verdict: RunStateChangeCompanions,
  ): Promise<boolean> {
    try {
      await this.#change(
        { runId, newState: "interrupted" },
        {
          ...verdict,
          statements: [
            noTerminalSinceStatement(runId, acceptedRunVersion),
            ...(verdict.statements ?? []),
          ],
        },
      );
    } catch (error) {
      if (
        error instanceof RunAlreadyEndedError ||
        (error instanceof WriteRefusedError &&
          error.statementIndex === INTERRUPT_END_SINCE_GUARD_INDEX)
      ) {
        return false;
      }
      throw error;
    }
    return true;
  }

  /**
   * Continues the interrupted run `request.runId` on its next turn: every setup gate again, as at a
   * start, the driver's start of the turn with the posture the posture gate resolved, then
   * `running` stamped with it; what the provider reports meanwhile waits for that write. A gate's
   * or the driver's throw leaves the run interrupted, every terminal hook releasing what the gates
   * took for the continue, and is rethrown; a `running` write that fails once the driver started
   * the turn does so after the turn is interrupted. Throws {@link RunInvalidTransitionError} for a run that
   * does not read interrupted or is already being continued.
   */
  async continueRun(request: RunStartRequest): Promise<RunRead> {
    const { runId } = request;
    const run = this.#requireInterrupted(runId);
    const continued = Promise.withResolvers<void>();
    const continuing: ContinuingRun = { settled: continued.promise, isTurnStarted: false };
    this.#continuingRuns.set(runId, continuing);
    try {
      await this.#gates.assertRunReady({
        runId,
        sessionId: run.sessionId,
        queueItem: request.queueItem,
        workspaceId: request.workspaceId,
        executionPosture: request.executionPosture,
      });
      const resolvedPosture = this.#executionPostures.resolvedPostureFor(runId);
      if (resolvedPosture === undefined) {
        throw new Error(`Run ${runId} passed its gates with no resolved posture`);
      }
      await request.startDriver(resolvedPosture);
      continuing.isTurnStarted = true;
      return await this.#change({
        runId,
        expectedState: "interrupted",
        newState: "running",
        executionPosture: resolvedPosture,
      });
    } catch (continueError) {
      // A turn the driver started for a continue that was never recorded is interrupted, the run
      // keeping its interrupted end.
      const failures = continuing.isTurnStarted ? await failuresOf(request.interruptDriver) : [];
      await this.#releaseFailedContinue(runId, continueError);
      if (failures.length > 0) {
        throw new AggregateError(
          [continueError, ...failures],
          `Run ${runId} could not be recorded running again, and ending its turn failed`,
          { cause: continueError },
        );
      }
      throw continueError;
    } finally {
      this.#continuingRuns.delete(runId);
      continued.resolve();
    }
  }

  /**
   * Continues the interrupted run `runId` on the turn its provider started itself with messages it
   * kept from the run's interrupted turn, and resolves with the run as `running` left it. Resolves
   * `undefined` with nothing written when the run no longer reads interrupted. Whatever the
   * provider reports on the run after this call waits for its write.
   */
  async continueRunWithKeptMessages(runId: RunId): Promise<RunRead | undefined> {
    const continued = Promise.withResolvers<void>();
    // Taken before any await, so a marker the provider sends next waits for the run to run.
    this.#continuingRuns.set(runId, { settled: continued.promise, isTurnStarted: true });
    try {
      // The provider reported the interrupted turn's end just before it started this one.
      await this.#endingRuns.get(runId);
      return await this.#change({ runId, expectedState: "interrupted", newState: "running" });
    } catch (error) {
      if (error instanceof RunInvalidTransitionError) {
        return undefined;
      }
      throw error;
    } finally {
      this.#continuingRuns.delete(runId);
      continued.resolve();
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
        appliedPendingInterruptOf(run, pendingInterrupt),
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
    // A run being continued reads ended until its continue is written.
    const continuing = this.#continuingRuns.get(runId);
    if (continuing !== undefined) {
      await continuing.settled;
    }
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

  // A run that ends while no driver has it: an entry still settling learns it ended; a claimable
  // one has nothing left to claim.
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
    const writing = this.#changes.write(change, companions);
    if (isTerminalState(change.newState)) {
      this.#trackEnding(change.runId, writing);
    }
    const run = await writing;
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

  // Keeps a terminal write of `runId` in flight until it and any before it have settled.
  #trackEnding(runId: RunId, writing: Promise<unknown>): void {
    const settled = Promise.allSettled([this.#endingRuns.get(runId), writing]).then(() => {
      if (this.#endingRuns.get(runId) === settled) {
        this.#endingRuns.delete(runId);
      }
    });
    this.#endingRuns.set(runId, settled);
  }

  // A continue that failed with its run still interrupted leaves the run at that end, so what the
  // gates took for it, its resolved posture among it, is released as at the end itself.
  async #releaseFailedContinue(runId: RunId, continueError: unknown): Promise<void> {
    const run = this.#runs.getRun(runId);
    if (run?.state !== "interrupted") {
      return;
    }
    try {
      await this.#gates.releaseForTerminal({
        runId,
        sessionId: run.sessionId,
        terminalState: run.state,
        runVersion: run.version,
      });
    } catch (releaseError) {
      throw new AggregateError(
        [continueError, releaseError],
        `Continuing run ${runId} failed, and a terminal hook after it failed too`,
        { cause: releaseError },
      );
    }
  }

  #requireInterrupted(runId: RunId): RunRead {
    const run = this.#runs.getRun(runId);
    if (run === undefined) {
      throw new RunNotFoundError(runId);
    }
    if (run.state !== "interrupted" || this.#continuingRuns.has(runId)) {
      throw new RunInvalidTransitionError(runId, run.state, "running");
    }
    return run;
  }

  // Ends a run whose start failed `failed`, a provider failure carrying the failure's words.
  async #endFailedStart(runId: RunId, startError: unknown): Promise<void> {
    await this.#change({
      runId,
      expectedState: "starting",
      newState: "failed",
      failureCategory: "provider failure",
      providerFailureDetail: boundFailureDetail(
        describeRejection(startError),
        DRIVER_START_FAILURE_FALLBACK,
      ),
    });
  }

  async #failStart(runId: RunId, driverError: unknown): Promise<void> {
    try {
      await this.#endFailedStart(runId, driverError);
    } catch (failError) {
      throw new AggregateError(
        [driverError, failError],
        `The driver could not start run ${runId}, and ending the run or a terminal hook failed`,
        { cause: failError },
      );
    }
  }
}

// Answers the failure of `step` instead of throwing it, so the steps after it still run.
async function failuresOf(step: () => Promise<unknown>): Promise<unknown[]> {
  try {
    await step();
    return [];
  } catch (error) {
    return [error];
  }
}

// Holds only while the run has written no terminal after `runVersion`.
function noTerminalSinceStatement(runId: RunId, runVersion: number): WriteStatement {
  return {
    sql: SELECT_TERMINAL_SINCE_SQL,
    bindings: { run_id: runId, run_version: runVersion },
    expectedRowCount: 0,
  };
}

// The cause a gate's throw records: a coded daemon error's code, and the error's own words.
function setupFailedCause(gateError: unknown): RunSetupFailedCause {
  const message = boundFailureDetail(describeRejection(gateError), SETUP_FAILURE_FALLBACK);
  return gateError instanceof DaemonDomainError
    ? { cause: "setup-failed", origin: "daemon", code: gateError.code, message }
    : { cause: "setup-failed", origin: "daemon", message };
}
