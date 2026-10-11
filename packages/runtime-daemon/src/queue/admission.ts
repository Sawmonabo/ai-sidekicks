// Starts each run a send queued. The run waits its turn at the memory gate and passes the run's
// setup gates, which make the session's working folder; the session's provider session is opened
// at its first admission after them, and the driver is handed the run's first waiting message as
// the turn's opening. A run still waiting at the gate past the delivery timeout ends failed with
// its messages not delivered.
//
// The reservation the gate grants is the run's until it ends; the run lifecycle parks it while the
// run waits on a person and releases it at the run's end.

import type { AgentId } from "@ai-sidekicks/contracts/agent/definition";
import type { ExecutionPosture } from "@ai-sidekicks/contracts/provider/driver/capabilities";
import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { QueueItemId } from "@ai-sidekicks/contracts/run/queue";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { AdmissionWork, MemoryAdmission, MemoryGate } from "../admission/memory-gate.js";
import type { ServiceLogWriter } from "../daemon/service-log.js";
import type { SessionEventDraft } from "../events/session/appender.js";
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
const OPEN_FAILED_FALLBACK = "The session's provider could not be opened";

/** What the run starter reads, writes and calls. */
export interface QueueAdmissionDeps {
  readonly items: QueueItemReader;
  readonly recorder: Pick<QueueRecorder, "recordOutcome" | "publishCommitted">;
  readonly engine: Pick<RunEngine, "startRun" | "transition">;
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
  // The opening message of each run whose driver is being started, which no change may move.
  readonly #openingItemIds = new Set<QueueItemId>();
  // What Claude Code's start reads for each run whose driver is being started.
  readonly #claudeDispatchByRun = new Map<RunId, ClaudeRunDispatch>();
  // Runs released while their start still read what it weighs at the gate, which never enqueue.
  readonly #releasedBeforeEnqueue = new Set<RunId>();

  constructor(deps: QueueAdmissionDeps) {
    this.#deps = deps;
    this.#deliveryTimeoutMs = deps.deliveryTimeoutMs ?? QUEUE_DELIVERY_TIMEOUT_MS;
  }

  /** Starts the queued run `runId` in the background, once the memory gate admits it. */
  start(sessionId: SessionId, runId: RunId): void {
    const started = this.#start(sessionId, runId).catch((error: unknown) => {
      this.#deps.writeServiceLog(
        `run queue: starting run ${runId} of session ${sessionId} failed: ` +
          describeRejection(error),
      );
    });
    this.#starts.set(runId, started);
    void started.finally(() => {
      this.#starts.delete(runId);
      this.#releasedBeforeEnqueue.delete(runId);
    });
  }

  /**
   * Runs `read` on the session's Codex service, waiting first at the memory gate when the read
   * would start the account's service, as any start does, and leaving the gate once it settles.
   */
  async readOnCodexService<T>(sessionId: SessionId, read: () => Promise<T>): Promise<T> {
    const work = await this.#codexWorkOf(sessionId);
    if (!work.startsAccountService) {
      return await read();
    }
    const admission = this.#deps.memoryGate.enqueue(work);
    try {
      await admission.admitted();
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

  /** Whether `itemId` is the opening of a run whose driver is being started. */
  isOpening(itemId: QueueItemId): boolean {
    return this.#openingItemIds.has(itemId);
  }

  /** Gives up the run's reservation while it waits on a person; a run holding none is left. */
  park(runId: RunId): void {
    const admission = this.#admissions.get(runId);
    if (admission?.state === "admitted") {
      admission.park();
    }
  }

  /** Puts a parked run back in the gate's line; a run not parked is left. */
  resume(runId: RunId): void {
    const admission = this.#admissions.get(runId);
    if (admission?.state === "parked") {
      admission.resume();
    }
  }

  /** Reads the peak of the session's provider process into the run's place at the gate. */
  async observeProcessPeak(sessionId: SessionId, runId: RunId): Promise<void> {
    const admission = this.#admissions.get(runId);
    if (admission?.state !== "admitted" && admission?.state !== "parked") {
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

    let executionPosture: ExecutionPosture;
    try {
      executionPosture = await this.#deps.providerSessions.readExecutionPosture(sessionId);
    } catch (postureError) {
      this.release(runId);
      const detail = boundFailureDetail(describeRejection(postureError), OPEN_FAILED_FALLBACK);
      await this.#endUndelivered(sessionId, runId, "failed", detail);
      throw postureError;
    }

    // Taken under the lock, so a removal either lands first or finds the opening taken.
    const opening = await this.#deps.sessionLock.run(sessionId, () => {
      const head =
        admission.state === "released" ? undefined : this.#deps.items.listWaitingForRun(runId)[0];
      if (head !== undefined) {
        this.#openingItemIds.add(head.id);
      }
      return Promise.resolve(head);
    });
    if (opening === undefined) {
      return;
    }

    try {
      try {
        await this.#deps.engine.startRun({
          runId,
          queueItem: summaryOf(opening),
          provider: driverName,
          outputSpeed: opening.body.outputSpeedForTurn,
          executionPosture,
          startDriver: async (resolvedPosture) => {
            await this.#startDriver(sessionId, runId, driverName, driver, opening, resolvedPosture);
          },
        });
      } catch (startError) {
        // The engine has ended the run; the opening never reached the provider's turn.
        await this.#deps.recorder.recordOutcome(
          opening,
          { to: "not_delivered", reason: "failed" },
          this.#deps.now(),
        );
        throw startError;
      }
      await this.#deps.recorder.recordOutcome(opening, { to: "admitted", runId }, this.#deps.now());
    } finally {
      this.#openingItemIds.delete(opening.id);
    }
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

  // Whether the gate admitted the run before the timeout; a release meanwhile answers `false` too.
  async #waitForAdmission(admission: MemoryAdmission): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timed_out">((resolve) => {
      timer = setTimeout(() => {
        resolve("timed_out");
      }, this.#deliveryTimeoutMs);
      timer.unref();
    });
    try {
      await Promise.race([admission.admitted(), timedOut]);
    } finally {
      clearTimeout(timer);
    }
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

  async #workOf(driverName: ProviderName, sessionId: SessionId): Promise<AdmissionWork> {
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
