// Starts each run a send queued, and continues an interrupted run with the messages waiting for
// it. The run waits its turn at the memory gate and passes the run's setup gates, which make the
// session's working folder; the session's provider session is opened at its first admission after
// them, and the driver is handed the run's first waiting message as the turn's opening. A run still
// waiting at the gate past the delivery timeout ends failed with its messages not delivered, and so
// does a run whose start failed while it still read queued. An interrupt that ends a run during its
// start leaves the opening to the interrupt's choice.
//
// The reservation the gate grants is the run's until it ends; the run lifecycle parks it while the
// run waits on a person, and while it rests interrupted with its provider process alive, so a
// continue takes it again, and releases it at any other end. The gate learns a run's peak only
// from a provider process the run's own start brought up, since one already running, shared or
// kept from an earlier run, holds memory the run did not grow.

import type { AgentId } from "@ai-sidekicks/contracts/agent/definition";
import { DRIVER_TIMEOUT_CODE } from "@ai-sidekicks/contracts/provider/driver/methods";
import type { ExecutionPosture } from "@ai-sidekicks/contracts/provider/driver/capabilities";
import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { QueueItemId, QueueItemNotDeliveredReason } from "@ai-sidekicks/contracts/run/queue";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { AdmissionWork, MemoryAdmission, MemoryGate } from "../admission/memory-gate.js";
import { waitWithin } from "../bounded-wait.js";
import type { ServiceLogWriter } from "../daemon/service-log.js";
import type { SessionEventDraft } from "../events/session/appender.js";
import { DaemonDomainError } from "../ipc/domain-error.js";
import {
  resolveDriverForSessionOrThrow,
  type SessionDriverDeps,
} from "../ipc/handlers/driver/resolution.js";
import type { KeyedLock } from "../keyed-lock.js";
import {
  boundFailureDetail,
  type ProviderDriver,
  type StartRunParams,
} from "../provider/driver/contract.js";
import type { ClaudeRunDispatch, DaemonTurnBinding } from "../provider/driver/run-control.js";
import { describeRejection } from "../rejection.js";
import type { RunEngine } from "../session/run/engine.js";
import type { RunStateReader } from "../session/run/read.js";
import { RunInvalidTransitionError } from "../session/run/refusals.js";
import type { ProviderSessions } from "./provider-session.js";
import { outcomeDraftOf, type QueueRecorder } from "./recorder.js";
import {
  summaryOf,
  type QueueItemOutcome,
  type QueueItemReader,
  type QueueItemRecord,
} from "./store.js";

// How long a queued run waits for the memory gate before its messages are not delivered: five
// minutes, past which a run is not getting memory soon and the person is better told so.
const QUEUE_DELIVERY_TIMEOUT_MS = 5 * 60 * 1000;

const TIMED_OUT_DETAIL = "The run waited longer than the delivery timeout to start";
const START_FAILED_FALLBACK = "The run could not be started";

/** What the run starter reads, writes and calls. */
export interface QueueAdmissionDeps {
  readonly items: QueueItemReader;
  readonly runs: Pick<RunStateReader, "getRun">;
  readonly recorder: Pick<QueueRecorder, "recordOutcome" | "publishCommitted">;
  readonly engine: Pick<RunEngine, "startRun" | "continueRun" | "transition">;
  readonly providerSessions: Pick<
    ProviderSessions,
    "readExecutionPosture" | "open" | "openRunBinding"
  >;
  readonly sessions: SessionDriverDeps;
  readonly readLeadAgent: (sessionId: SessionId) => AgentId;
  readonly memoryGate: Pick<MemoryGate, "enqueue">;
  /** Whether a Codex conversation on the session would start its account's service. */
  readonly startsCodexAccountService: (sessionId: SessionId) => Promise<boolean>;
  /** The process id of the session's provider process, or `undefined` while none runs. */
  readonly readProviderProcessId: (sessionId: SessionId) => number | undefined;
  /** The queue's per-session lock, which every decision on a session's waiting messages takes. */
  readonly sessionLock: KeyedLock<SessionId>;
  readonly writeServiceLog: ServiceLogWriter;
  readonly now: () => string;
  /** How long a queued run waits for the memory gate; defaults to the queue's delivery timeout. */
  readonly deliveryTimeoutMs?: number;
}

/** One waiting message and where it goes, for a write that ends the queued run it waited for. */
export interface QueuedRunOutcome {
  readonly item: QueueItemRecord;
  readonly outcome: QueueItemOutcome;
}

/**
 * Starts the runs sends queue and holds each one's memory reservation until it ends. A start's
 * failure is written to the run and its messages, and to the service log.
 */
export class QueueAdmission {
  readonly #deps: QueueAdmissionDeps;
  readonly #deliveryTimeoutMs: number;
  // Each run's place at the memory gate, from its queuing until it ends.
  readonly #admissions = new Map<RunId, MemoryAdmission>();
  // Each start in flight, settling once its opening message's outcome is written.
  readonly #starts = new Map<RunId, Promise<void>>();
  // The opening of each run whose driver is being started, which no change may move or hand again,
  // until its outcome is written.
  readonly #openingByRun = new Map<RunId, QueueItemRecord>();
  // What Claude Code's start reads for each run whose driver is being started.
  readonly #claudeDispatchByRun = new Map<RunId, ClaudeRunDispatch>();
  // Runs released while their start still read what it weighs at the gate, which never enqueue.
  readonly #releasedBeforeEnqueue = new Set<RunId>();
  // Runs whose own start brought up the provider process the gate learns their peak from.
  readonly #processStartingRuns = new Set<RunId>();

  constructor(deps: QueueAdmissionDeps) {
    this.#deps = deps;
    this.#deliveryTimeoutMs = deps.deliveryTimeoutMs ?? QUEUE_DELIVERY_TIMEOUT_MS;
  }

  /**
   * Starts the queued run `runId` in the background, once the memory gate admits it. A start that
   * fails while the run still reads `queued` ends the run failed with its messages not delivered.
   */
  start(sessionId: SessionId, runId: RunId): void {
    const started = this.#start(sessionId, runId).catch(async (error: unknown) => {
      // An interrupt claimed the start, and its choice decides the opening.
      if (
        error instanceof RunInvalidTransitionError ||
        this.#deps.runs.getRun(runId)?.state === "interrupted"
      ) {
        return;
      }
      this.#deps.writeServiceLog(
        `run queue: starting run ${runId} of session ${sessionId} failed: ` +
          describeRejection(error),
      );
      // A run left queued would hold every later send, so it ends with its messages.
      if (this.#deps.runs.getRun(runId)?.state !== "queued") {
        return;
      }
      this.release(runId);
      const detail = boundFailureDetail(describeRejection(error), START_FAILED_FALLBACK);
      await this.#endUndelivered(sessionId, runId, "failed", detail).catch((endError: unknown) => {
        this.#deps.writeServiceLog(
          `run queue: ending run ${runId} of session ${sessionId} after its failed start ` +
            `failed: ${describeRejection(endError)}`,
        );
      });
    });
    this.#starts.set(runId, started);
    void started.finally(() => {
      this.#starts.delete(runId);
      this.#releasedBeforeEnqueue.delete(runId);
    });
  }

  /**
   * Runs `read` on the session's Codex service. A start of the session's queued run, which holds
   * the session's place at the memory gate and brings the service up, is waited for first, so the
   * read never takes a second place behind it; a read that would still start the account's service
   * then waits at the gate itself and leaves it once the read settles. Throws `driver.timeout`
   * when either wait outlives the delivery timeout, having read nothing.
   */
  async readOnCodexService<T>(sessionId: SessionId, read: () => Promise<T>): Promise<T> {
    const liveRunId = this.#deps.items.readLiveLeadRun(sessionId);
    const starting = liveRunId === undefined ? undefined : this.#starts.get(liveRunId);
    if (starting !== undefined && !(await waitWithin(starting, this.#deliveryTimeoutMs))) {
      throw codexReadTimedOut(sessionId);
    }
    const work = await this.#codexWorkOf(sessionId);
    if (!work.startsAccountService) {
      return await read();
    }
    const admission = this.#deps.memoryGate.enqueue(work);
    try {
      if (!(await this.#waitForAdmission(admission))) {
        throw codexReadTimedOut(sessionId);
      }
      return await read();
    } finally {
      admission.release();
    }
  }

  /** Settles once the start of `runId` has written its opening's outcome; at once if none runs. */
  async settled(runId: RunId): Promise<void> {
    await this.#starts.get(runId);
  }

  /** Whether the queue holds `runId`'s place at the memory gate or is starting it. */
  isAdmitting(runId: RunId): boolean {
    return this.#admissions.has(runId) || this.#starts.has(runId);
  }

  /** Whether a start or continue of `runId` is under way. */
  isStarting(runId: RunId): boolean {
    return this.#starts.has(runId);
  }

  /**
   * Whether `itemId` is the opening of a run whose outcome is not yet written. One a newer lead
   * run took over is that run's to hand, whatever the start that took it as its opening does.
   */
  isOpening(itemId: QueueItemId): boolean {
    for (const [runId, opening] of this.#openingByRun) {
      if (opening.id === itemId) {
        return this.#deps.items.get(itemId)?.targetRunId === runId;
      }
    }
    return false;
  }

  /** Gives up the run's reservation while it waits on a person; a run holding none is left. */
  park(runId: RunId): void {
    const admission = this.#admissions.get(runId);
    if (admission?.state === "admitted") {
      admission.park();
    }
  }

  /**
   * Puts a parked run back in the gate's line, the run going on while it waits its place; a run
   * not parked is left.
   */
  resume(runId: RunId): void {
    const admission = this.#admissions.get(runId);
    if (admission?.state === "parked") {
      admission.resume();
    }
  }

  /**
   * Keeps the reservation of the run `runId`, which ended interrupted, parked while its provider
   * process lives, so a continue takes it again until {@link release}; with no process, or none
   * granted, it is released.
   */
  parkInterrupted(sessionId: SessionId, runId: RunId): void {
    this.park(runId);
    if (
      this.#deps.readProviderProcessId(sessionId) === undefined ||
      this.#admissions.get(runId)?.state !== "parked"
    ) {
      this.release(runId);
    }
  }

  /**
   * Continues the interrupted run `runId` in the background, the first message waiting for it
   * opening its next turn and the rest handed once it runs: its parked reservation taken again,
   * else a place at the gate it waits for as a start does. A continue whose gate wait outlives the
   * delivery timeout leaves the run interrupted with its messages not delivered; one that fails
   * while the run still reads interrupted leaves those still waiting for it not delivered too; one
   * a newer lead run took them over from is let go quietly. A start or continue of the run already
   * under way is left to finish.
   */
  continueRun(sessionId: SessionId, runId: RunId): void {
    if (this.#starts.has(runId)) {
      return;
    }
    const continued = this.#continue(sessionId, runId).catch(async (error: unknown) => {
      // A run its provider is continuing, or one that ended another way, keeps its messages.
      if (
        error instanceof RunInvalidTransitionError ||
        this.#deps.runs.getRun(runId)?.state !== "interrupted"
      ) {
        return;
      }
      // A newer lead run, such as a turn the provider started itself, took over the messages.
      if (error instanceof ContinueTakenOverError) {
        this.release(runId);
        return;
      }
      this.#deps.writeServiceLog(
        `run queue: continuing run ${runId} of session ${sessionId} failed: ` +
          describeRejection(error),
      );
      this.release(runId);
      await this.#markWaitingUndelivered(sessionId, runId, "failed").catch((markError: unknown) => {
        this.#deps.writeServiceLog(
          `run queue: settling the messages of run ${runId} after its failed continue ` +
            `failed: ${describeRejection(markError)}`,
        );
      });
    });
    this.#starts.set(runId, continued);
    void continued.finally(() => {
      this.#starts.delete(runId);
      this.#releasedBeforeEnqueue.delete(runId);
    });
  }

  /**
   * Reads the peak of the session's provider process into the run's place at the gate, when the
   * run's own start brought that process up.
   */
  async observeProcessPeak(sessionId: SessionId, runId: RunId): Promise<void> {
    const admission = this.#admissions.get(runId);
    if (
      !this.#processStartingRuns.has(runId) ||
      (admission?.state !== "admitted" && admission?.state !== "parked")
    ) {
      return;
    }
    const processId = this.#deps.readProviderProcessId(sessionId);
    if (processId !== undefined) {
      await admission.observeProcessPeak(processId);
    }
  }

  /** Ends the run's place at the gate: a run still waiting leaves the line and is never started. */
  release(runId: RunId): void {
    const admission = this.#admissions.get(runId);
    this.#admissions.delete(runId);
    this.#processStartingRuns.delete(runId);
    if (admission === undefined) {
      if (this.#starts.has(runId)) {
        this.#releasedBeforeEnqueue.add(runId);
      }
      return;
    }
    if (admission.state !== "released") {
      admission.release();
    }
  }

  /**
   * Writes the `admitted` outcome the opening of the ended run `runId` still owes, its driver
   * having started with it, and forgets the opening. Called at the run's end, under the session
   * lock; throws the write's failure.
   */
  async settleOpening(runId: RunId): Promise<void> {
    const opening = this.#openingByRun.get(runId);
    if (opening === undefined) {
      return;
    }
    this.#openingByRun.delete(runId);
    if (this.#deps.items.get(opening.id)?.state === "queued") {
      await this.#deps.recorder.recordOutcome(opening, { to: "admitted", runId }, this.#deps.now());
    }
  }

  /**
   * Ends the queued run `runId` `failed` as a setup failure saying `detail`, with each of
   * `outcomes` in the same write, and tells the queue's followers. Throws the write's refusal when
   * the run has left `queued` or one of the messages has.
   */
  async endQueuedRun(
    sessionId: SessionId,
    runId: RunId,
    outcomes: readonly QueuedRunOutcome[],
    detail: string,
  ): Promise<void> {
    const now = this.#deps.now();
    const drafts = outcomes.map(({ item, outcome }) => outcomeDraftOf(item, outcome, now));
    const precedingEvents: SessionEventDraft[] = drafts.map((draft) => draft.event);
    await this.#deps.engine.transition(
      {
        runId,
        expectedState: "queued",
        newState: "failed",
        failureCategory: "setup failure",
        failureCause: { cause: "setup-failed", origin: "daemon", message: detail },
      },
      { statements: drafts.map((draft) => draft.statement), precedingEvents },
    );
    this.release(runId);
    this.#deps.recorder.publishCommitted(
      sessionId,
      outcomes.map(({ item }) => item.id),
    );
  }

  /** The dispatch facts of a Claude run being started, or `undefined` for any other run. */
  resolveRunDispatch(params: StartRunParams): Promise<ClaudeRunDispatch | undefined> {
    return Promise.resolve(this.#claudeDispatchByRun.get(params.runId));
  }

  /**
   * The binding of a turn the daemon starts on a session itself, and the session's lead. Throws
   * when this process has not opened the session's provider session.
   */
  async openDaemonTurnBinding(runId: RunId, sessionId: SessionId): Promise<DaemonTurnBinding> {
    const bindingId = await this.#deps.providerSessions.openRunBinding(runId, sessionId);
    return { bindingId, agentId: this.#deps.readLeadAgent(sessionId) };
  }

  async #start(sessionId: SessionId, runId: RunId): Promise<void> {
    const { driverName, driver } = resolveDriverForSessionOrThrow(this.#deps.sessions, sessionId);
    const work = await this.#workOf(driverName, sessionId);
    if (this.#releasedBeforeEnqueue.has(runId)) {
      return;
    }
    const admission = this.#deps.memoryGate.enqueue(work);
    this.#admissions.set(runId, admission);
    if (!(await this.#waitForAdmission(admission))) {
      if (admission.state === "waiting") {
        this.release(runId);
        await this.#endUndelivered(sessionId, runId, "timed_out", TIMED_OUT_DETAIL);
      }
      return;
    }
    const isProcessStarting =
      work.provider === "codex"
        ? work.startsAccountService
        : this.#deps.readProviderProcessId(sessionId) === undefined;
    if (isProcessStarting) {
      this.#processStartingRuns.add(runId);
    }
    const executionPosture = await this.#deps.providerSessions.readExecutionPosture(sessionId);

    // Taken under the lock, so a removal either lands first or finds the opening taken.
    const opening = await this.#deps.sessionLock.run(sessionId, () => {
      const head =
        admission.state === "released" ? undefined : this.#deps.items.listWaitingForRun(runId)[0];
      if (head !== undefined) {
        this.#openingByRun.set(runId, head);
      }
      return Promise.resolve(head);
    });
    if (opening === undefined) {
      return;
    }

    try {
      await this.#deps.engine.startRun({
        runId,
        queueItem: summaryOf(opening),
        workspaceId: opening.body.workspaceId,
        provider: driverName,
        outputSpeed: opening.body.outputSpeedForTurn,
        executionPosture,
        startDriver: async (resolvedPosture) => {
          await this.#startDriver(sessionId, runId, driverName, driver, opening, resolvedPosture);
        },
        interruptDriver: async () => {
          await driver.interruptRun({ runId });
        },
      });
    } catch (startError) {
      // The opening never reached the provider's turn: a run the engine ended, or failed to end,
      // keeps the rest of its messages for the next run, one still queued ends with every
      // message, and one an interrupt claimed leaves the opening to the interrupt's choice.
      this.#openingByRun.delete(runId);
      const state = this.#deps.runs.getRun(runId)?.state;
      const isUnended = state === "starting" && startError instanceof AggregateError;
      if (
        (state === "failed" || isUnended) &&
        this.#deps.items.get(opening.id)?.state === "queued"
      ) {
        await this.#deps.recorder.recordOutcome(
          opening,
          { to: "not_delivered", reason: "failed" },
          this.#deps.now(),
        );
      }
      throw startError;
    }
    // Kept as the opening until this write lands, so a failed write never hands it again.
    await this.#deps.recorder.recordOutcome(opening, { to: "admitted", runId }, this.#deps.now());
    this.#openingByRun.delete(runId);
  }

  async #continue(sessionId: SessionId, runId: RunId): Promise<void> {
    const { driverName, driver } = resolveDriverForSessionOrThrow(this.#deps.sessions, sessionId);
    if (!(await this.#admitContinue(sessionId, runId, driverName))) {
      return;
    }
    const executionPosture = await this.#deps.providerSessions.readExecutionPosture(sessionId);
    // Taken under the lock, so a removal either lands first or finds the opening taken.
    const opening = await this.#deps.sessionLock.run(sessionId, () => {
      const head =
        this.#deps.runs.getRun(runId)?.state === "interrupted"
          ? this.#deps.items.listWaitingForRun(runId).find((item) => item.childHandle === undefined)
          : undefined;
      if (head !== undefined) {
        this.#openingByRun.set(runId, head);
      }
      return Promise.resolve(head);
    });
    if (opening === undefined) {
      // Nothing is left to continue the run with, so it rests interrupted holding no place.
      this.release(runId);
      return;
    }
    try {
      await this.#deps.engine.continueRun({
        runId,
        queueItem: summaryOf(opening),
        workspaceId: opening.body.workspaceId,
        provider: driverName,
        outputSpeed: opening.body.outputSpeedForTurn,
        executionPosture,
        startDriver: async (resolvedPosture) => {
          // A newer lead run that took over the messages while the gates ran takes the opening.
          if (this.#deps.items.get(opening.id)?.targetRunId !== runId) {
            throw new ContinueTakenOverError(runId);
          }
          await this.#startDriver(sessionId, runId, driverName, driver, opening, resolvedPosture);
        },
        interruptDriver: async () => {
          await driver.interruptRun({ runId });
        },
      });
    } catch (continueError) {
      // A run its provider is continuing is handed the opening with the rest once it runs.
      this.#openingByRun.delete(runId);
      if (
        continueError instanceof RunInvalidTransitionError ||
        this.#deps.runs.getRun(runId)?.state !== "interrupted"
      ) {
        throw continueError;
      }
      // A run that took over the messages, even while the driver held the continue back, takes
      // the opening with them.
      const current = this.#deps.items.get(opening.id);
      if (current !== undefined && current.targetRunId !== runId) {
        throw new ContinueTakenOverError(runId);
      }
      if (current?.state === "queued") {
        await this.#deps.recorder.recordOutcome(
          opening,
          { to: "not_delivered", reason: "failed" },
          this.#deps.now(),
        );
      }
      throw continueError;
    }
    await this.#deps.recorder.recordOutcome(opening, { to: "admitted", runId }, this.#deps.now());
    this.#openingByRun.delete(runId);
  }

  // Takes the continued run's place at the gate: its parked reservation again, the run going on
  // while it waits as a paused run's continue does, or a new place it waits for as a start does.
  // Answers `false` when that wait outlived the delivery timeout, its messages then not delivered.
  async #admitContinue(
    sessionId: SessionId,
    runId: RunId,
    driverName: ProviderName,
  ): Promise<boolean> {
    if (this.#admissions.has(runId)) {
      this.resume(runId);
      return true;
    }
    const work = await this.#workOf(driverName, sessionId);
    if (this.#releasedBeforeEnqueue.has(runId)) {
      return false;
    }
    const admission = this.#deps.memoryGate.enqueue(work);
    this.#admissions.set(runId, admission);
    if (!(await this.#waitForAdmission(admission))) {
      if (admission.state === "waiting") {
        this.release(runId);
        await this.#markWaitingUndelivered(sessionId, runId, "timed_out");
      }
      return false;
    }
    const isProcessStarting =
      work.provider === "codex"
        ? work.startsAccountService
        : this.#deps.readProviderProcessId(sessionId) === undefined;
    if (isProcessStarting) {
      this.#processStartingRuns.add(runId);
    }
    return true;
  }

  // Every lead message waiting for the run reads not delivered, for `reason`.
  async #markWaitingUndelivered(
    sessionId: SessionId,
    runId: RunId,
    reason: QueueItemNotDeliveredReason,
  ): Promise<void> {
    await this.#deps.sessionLock.run(sessionId, async () => {
      for (const item of this.#deps.items.listWaitingForRun(runId)) {
        if (item.childHandle === undefined) {
          await this.#deps.recorder.recordOutcome(
            item,
            { to: "not_delivered", reason },
            this.#deps.now(),
          );
        }
      }
    });
  }

  // Opens the session's provider session once the setup gates have made its working folder, then
  // hands the driver the run's opening on the run's own binding.
  async #startDriver(
    sessionId: SessionId,
    runId: RunId,
    driverName: ProviderName,
    driver: Pick<ProviderDriver, "startRun">,
    opening: QueueItemRecord,
    executionPosture: ExecutionPosture,
  ): Promise<void> {
    await this.#deps.providerSessions.open(sessionId, runId);
    const bindingId = await this.#deps.providerSessions.openRunBinding(runId, sessionId);
    if (driverName === "claude") {
      this.#claudeDispatchByRun.set(runId, {
        sessionId,
        bindingId,
        openingText: opening.body.content,
        attachments: opening.body.attachments ?? [],
        messageId: opening.id,
      });
    }
    try {
      await driver.startRun({
        runId,
        executionPosture,
        agentConfig:
          driverName === "codex"
            ? codexAgentConfigOf(sessionId, bindingId, this.#deps.readLeadAgent(sessionId), opening)
            : {},
        ...(opening.body.outputSpeedForTurn === undefined
          ? {}
          : { outputSpeedForTurn: opening.body.outputSpeedForTurn }),
      });
    } finally {
      this.#claudeDispatchByRun.delete(runId);
    }
  }

  // Whether the gate admitted the entry before the timeout; a release meanwhile answers `false`.
  async #waitForAdmission(admission: MemoryAdmission): Promise<boolean> {
    await waitWithin(admission.admitted(), this.#deliveryTimeoutMs);
    return admission.state === "admitted";
  }

  async #endUndelivered(
    sessionId: SessionId,
    runId: RunId,
    reason: "timed_out" | "failed",
    detail: string,
  ): Promise<void> {
    await this.#deps.sessionLock.run(sessionId, async () => {
      const outcomes = this.#deps.items
        .listWaitingForRun(runId)
        .map((item): QueuedRunOutcome => ({ item, outcome: { to: "not_delivered", reason } }));
      await this.endQueuedRun(sessionId, runId, outcomes, detail);
    });
  }

  async #workOf(
    driverName: ProviderName,
    sessionId: SessionId,
  ): Promise<Extract<AdmissionWork, { kind: "provider" }>> {
    return driverName === "codex"
      ? await this.#codexWorkOf(sessionId)
      : { kind: "provider", provider: "claude" };
  }

  async #codexWorkOf(sessionId: SessionId): Promise<Extract<AdmissionWork, { provider: "codex" }>> {
    return {
      kind: "provider",
      provider: "codex",
      startsAccountService: await this.#deps.startsCodexAccountService(sessionId),
    };
  }
}

// A continue given up before its turn started, since a newer lead run took over its messages.
class ContinueTakenOverError extends Error {
  constructor(runId: RunId) {
    super(`A newer lead run took over the messages of run ${runId}`);
    this.name = "ContinueTakenOverError";
  }
}

// The Codex turn's opening: the message's words, skills and files under its own id, on the run's
// binding.
function codexAgentConfigOf(
  sessionId: SessionId,
  bindingId: string,
  agentId: AgentId,
  opening: QueueItemRecord,
): Record<string, unknown> {
  return {
    sessionId,
    bindingId,
    agentId,
    input: opening.body.content,
    ...(opening.body.attachments === undefined ? {} : { attachments: opening.body.attachments }),
    ...(opening.body.skills === undefined ? {} : { skills: opening.body.skills }),
    clientUserMessageId: opening.id,
  };
}

// A read on Codex's service that waited past the delivery timeout for memory to start it.
function codexReadTimedOut(sessionId: SessionId): DaemonDomainError {
  return new DaemonDomainError(
    "The session's Codex service could not be started within the delivery timeout",
    { code: DRIVER_TIMEOUT_CODE, detail: { sessionId } },
  );
}
