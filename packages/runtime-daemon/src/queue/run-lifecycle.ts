// Follows every run's state changes for the run queue, from the session log's committed events,
// each session's in order. Every change weighs the memory gate again and reads the session's
// process peak into the run's reservation; a run waiting on a person gives its reservation up and
// takes it again when it runs. A run that runs again after a pause has its continue's messages
// admitted, and a Claude run that runs is handed what waits for it. At a run's end its reservation
// is released, and the lead's messages still waiting for it, but those the still-running Claude
// Code process keeps for its next turn, become the next run's, or go into the lead run another
// start made live meanwhile. A run that ended interrupted keeps its messages instead: it is
// continued with them, unless Claude Code kept some and continues it itself, and its reservation
// is parked meanwhile; once a newer lead run exists, such as a turn Codex started itself, which
// takes them over in the write that makes it run, its reservation is let go, unless a continue is
// under way, whose own end lets it go. A newer lead run whose start fails before it ran leaves the
// interrupted run current, resting for its continue again with the newer run's messages. An end
// seen while an interrupt of the run is under way waits for the interrupt's choice to be written;
// the messages an end moved on before an interrupt of the run arrived are kept by the run, so the
// interrupt's choice still decides them, until the run they went to ends. A session's close
// forgets its provider session, the interrupted run it kept a reservation for and the messages its
// runs' ends moved on.
//
// A session whose events could not all be read, and every session when the daemon starts, is
// read again from the record: a run that ended unseen is ended as above, a queued run no start
// holds is started, and a live run is handed what waits for it, its reservation parked or taken
// again as its state stands.

import type { AgentId } from "@ai-sidekicks/contracts/agent/definition";
import type { EventEnvelope } from "@ai-sidekicks/contracts/event/envelope";
import type { RunStateChangeState } from "@ai-sidekicks/contracts/run/events";
import { RunIdSchema, type RunId } from "@ai-sidekicks/contracts/run/id";
import type { QueueItemId } from "@ai-sidekicks/contracts/run/queue";
import type { RunQueuedPayload } from "@ai-sidekicks/contracts/run/queued";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { canonicalizeUuid } from "@ai-sidekicks/contracts/uuid-canonical";

import type { MemoryGate } from "../admission/memory-gate.js";
import type { ServiceLogWriter } from "../daemon/service-log.js";
import { KeyedLock } from "../keyed-lock.js";
import { describeRejection } from "../rejection.js";
import type { RunStateReader } from "../session/run/read.js";
import {
  readStoredRunStateChange,
  type StoredRunStateChange,
} from "../session/run/stored-state-change.js";
import { isTerminalState } from "../session/run/transitions.js";
import { mintUuidV7 } from "../uuid-v7.js";
import type { QueueAdmission } from "./admission.js";
import type { QueueDelivery } from "./delivery.js";
import type { ProviderSessions } from "./provider-session.js";
import type { QueueRecorder } from "./recorder.js";
import type { QueueItemReader } from "./store.js";

const CREDITS_CHOICE_REQUESTED_TYPE = "run.usage_credits_choice_requested";
const CREDITS_CHOICE_RESOLVED_TYPE = "run.usage_credits_choice_resolved";
const SESSION_CLOSED_TYPE = "session.closed";

// The run states in which a run waits on a person and holds no reservation.
const PARKED_STATES: ReadonlySet<RunStateChangeState> = new Set([
  "waiting_for_approval",
  "waiting_for_input",
  "paused",
]);

/** What the run lifecycle reads, writes and calls. */
export interface QueueRunLifecycleDeps {
  readonly items: QueueItemReader;
  readonly providerSessions: Pick<ProviderSessions, "forget">;
  readonly recorder: Pick<QueueRecorder, "recordNextRun" | "recordRetarget">;
  readonly runs: Pick<RunStateReader, "getRun">;
  readonly admission: Pick<
    QueueAdmission,
    | "start"
    | "continueRun"
    | "settled"
    | "park"
    | "parkInterrupted"
    | "resume"
    | "release"
    | "observeProcessPeak"
    | "isAdmitting"
    | "isStarting"
    | "settleOpening"
  >;
  readonly delivery: Pick<
    QueueDelivery,
    | "handWaiting"
    | "admitContinued"
    | "settle"
    | "endRun"
    | "isHanded"
    | "isMessageKeptForRun"
    | "isHeldForInterrupt"
    | "noteCreditsChoice"
  >;
  readonly memoryGate: Pick<MemoryGate, "weigh">;
  readonly readLeadAgent: (sessionId: SessionId) => AgentId;
  /** The queue's per-session lock, which every decision on a session's waiting messages takes. */
  readonly sessionLock: KeyedLock<SessionId>;
  readonly writeServiceLog: ServiceLogWriter;
  readonly now: () => string;
}

// The lead's messages an ended run's end moved on, and the session and run they went to.
interface MovedLeftovers {
  readonly sessionId: SessionId;
  readonly toRunId: RunId;
  readonly itemIds: readonly QueueItemId[];
}

/** Keeps the queue's reservations and waiting messages in step with each run's state. */
export class QueueRunLifecycle {
  readonly #deps: QueueRunLifecycleDeps;
  // Each session's changes are applied one at a time, in the log's order.
  readonly #changeChain = new KeyedLock<SessionId>(canonicalizeUuid);
  // Runs whose end was seen while an interrupt of them was under way, settled once it is.
  readonly #endsAwaitingInterrupt = new Set<RunId>();
  // Each session's interrupted lead run whose end is settled, which a continue may take on.
  readonly #restingRunBySession = new Map<SessionId, RunId>();
  // What each ended run's end moved on, by the ended run, until the run they went to ends.
  readonly #movedLeftoversByRun = new Map<RunId, MovedLeftovers>();
  // Each session's interrupted lead run whose continue was under way when a newer lead run
  // superseded it, until a run's end has waited for that continue.
  readonly #supersededContinueBySession = new Map<SessionId, RunId>();

  constructor(deps: QueueRunLifecycleDeps) {
    this.#deps = deps;
  }

  /**
   * Takes one committed session event, as the event log's every-session follow delivers it. Its
   * work runs after the events of its session before it; a failure is written to the service log.
   */
  observe(event: EventEnvelope): void {
    const { sessionId } = event;
    const change = readStoredRunStateChange(event);
    if (change !== undefined) {
      this.#deps.memoryGate.weigh();
      this.#onChain(sessionId, async () => {
        await this.#apply(sessionId, change);
      });
      return;
    }
    if (event.type === SESSION_CLOSED_TYPE) {
      this.#deps.providerSessions.forget(sessionId);
      this.#letGoRestingRun(sessionId);
      this.#supersededContinueBySession.delete(canonicalizeUuid(sessionId));
      for (const [runId, moved] of [...this.#movedLeftoversByRun]) {
        if (canonicalizeUuid(moved.sessionId) === canonicalizeUuid(sessionId)) {
          this.#movedLeftoversByRun.delete(runId);
        }
      }
      return;
    }
    if (
      event.type === CREDITS_CHOICE_REQUESTED_TYPE ||
      event.type === CREDITS_CHOICE_RESOLVED_TYPE
    ) {
      const runId = RunIdSchema.parse(event.payload["runId"]);
      const isHeld = event.type === CREDITS_CHOICE_REQUESTED_TYPE;
      this.#onChain(sessionId, () => {
        this.#deps.delivery.noteCreditsChoice(runId, isHeld);
        return Promise.resolve();
      });
    }
  }

  /**
   * Reads the session's waiting messages again from the record, after its events could not all be
   * read or when the daemon starts: a run they wait for that ended is ended as at its end, and a
   * queued run no start holds is started. Runs after the session's changes before it; a failure is
   * written to the service log.
   */
  async reconcile(sessionId: SessionId): Promise<void> {
    await this.#changeChain
      .run(sessionId, async () => {
        await this.#reconcile(sessionId);
      })
      .catch((error: unknown) => {
        this.#deps.writeServiceLog(
          `run queue: reading the waiting messages of session ${sessionId} again failed: ` +
            describeRejection(error),
        );
      });
  }

  async #reconcile(sessionId: SessionId): Promise<void> {
    const { admission, delivery, items, runs, sessionLock } = this.#deps;
    const waiting = items.list(sessionId, undefined, "queued");
    const runIds = new Set(waiting.flatMap((item) => item.targetRunId ?? []));
    const liveRunId = items.readLiveLeadRun(sessionId);
    if (liveRunId !== undefined) {
      runIds.add(liveRunId);
    }
    for (const runId of runIds) {
      const state = runs.getRun(runId)?.state;
      if (state === undefined) {
        continue;
      }
      if (isTerminalState(state)) {
        await this.#endRun(sessionId, runId);
      } else if (state === "queued") {
        if (!admission.isAdmitting(runId)) {
          admission.start(sessionId, runId);
        }
      } else if (PARKED_STATES.has(state)) {
        admission.park(runId);
      } else if (state === "running") {
        admission.resume(runId);
        await admission.settled(runId);
        await sessionLock.run(sessionId, async () => {
          // A continue that went while the queue read nothing has run, so its messages are taken.
          await delivery.admitContinued(runId);
          delivery.handWaiting(sessionId, runId);
        });
      }
    }
  }

  async #apply(sessionId: SessionId, change: StoredRunStateChange): Promise<void> {
    const { admission, delivery, sessionLock } = this.#deps;
    const { runId, newState, previousState } = change;
    await admission.observeProcessPeak(sessionId, runId);
    if (isTerminalState(newState)) {
      await this.#endRun(sessionId, runId);
      return;
    }
    if (PARKED_STATES.has(newState)) {
      admission.park(runId);
      return;
    }
    this.#letGoSupersededRestingRun(sessionId);
    if (newState !== "running") {
      return;
    }
    if (this.#restingRunBySession.get(canonicalizeUuid(sessionId)) === runId) {
      this.#restingRunBySession.delete(canonicalizeUuid(sessionId));
    }
    admission.resume(runId);
    // The start writes its opening's outcome first, so the opening is never handed again.
    await admission.settled(runId);
    await sessionLock.run(sessionId, async () => {
      if (previousState === "pausing" || previousState === "paused") {
        await delivery.admitContinued(runId);
      }
      delivery.handWaiting(sessionId, runId);
    });
  }

  /**
   * Settles the end of `runId` that was seen while an interrupt of it was under way, once the
   * interrupt's choice for its messages is written and its hold released; a run whose end was not
   * seen is left to its own. Called under the session lock.
   */
  async settleEndAfterInterrupt(sessionId: SessionId, runId: RunId): Promise<void> {
    if (this.#endsAwaitingInterrupt.delete(runId)) {
      await this.#settleEnd(sessionId, runId);
    }
  }

  /**
   * Takes the ids of the lead's messages the end of `runId` moved on to another run, which an
   * interrupt of the run still decides, or `undefined` when its end moved none or the run they went
   * to has ended. Called under the session lock.
   */
  takeMovedLeftovers(runId: RunId): readonly QueueItemId[] | undefined {
    const moved = this.#movedLeftoversByRun.get(runId);
    this.#movedLeftoversByRun.delete(runId);
    return moved?.itemIds;
  }

  /**
   * Continues the interrupted run `runId` with the lead's messages waiting for it, once its end is
   * settled, unless none waits, an interrupt of it is under way, or Claude Code may still hold one,
   * which it continues the run with itself. Called under the session lock.
   */
  continueInterruptedRun(sessionId: SessionId, runId: RunId): void {
    const { admission, delivery, items, runs } = this.#deps;
    if (
      this.#letGoSupersededRestingRun(sessionId) !== runId ||
      runs.getRun(runId)?.state !== "interrupted" ||
      delivery.isHeldForInterrupt(runId)
    ) {
      return;
    }
    const waiting = items.listWaitingForRun(runId).filter((item) => item.childHandle === undefined);
    if (waiting.length > 0 && !delivery.isMessageKeptForRun(sessionId, runId)) {
      admission.continueRun(sessionId, runId);
    }
  }

  // Lets the session's resting interrupted run go, with its parked reservation, once a newer lead
  // run exists, and answers the one still resting. A continue under way keeps the reservation,
  // which the continue's own end lets go.
  #letGoSupersededRestingRun(sessionId: SessionId): RunId | undefined {
    const sessionKey = canonicalizeUuid(sessionId);
    const restingRunId = this.#restingRunBySession.get(sessionKey);
    if (
      restingRunId !== undefined &&
      this.#deps.items.readCurrentLeadRun(sessionId)?.runId !== restingRunId
    ) {
      if (this.#deps.admission.isStarting(restingRunId)) {
        this.#restingRunBySession.delete(sessionKey);
        this.#supersededContinueBySession.set(sessionKey, restingRunId);
      } else {
        this.#letGoRestingRun(sessionId);
      }
      return undefined;
    }
    return restingRunId;
  }

  #letGoRestingRun(sessionId: SessionId): void {
    const sessionKey = canonicalizeUuid(sessionId);
    const restingRunId = this.#restingRunBySession.get(sessionKey);
    if (restingRunId !== undefined) {
      this.#restingRunBySession.delete(sessionKey);
      this.#deps.admission.release(restingRunId);
    }
  }

  async #endRun(sessionId: SessionId, runId: RunId): Promise<void> {
    await this.#deps.admission.settled(runId);
    // Outside the lock, which a failed continue takes: once it has settled, the end's messages go
    // to the run it made live rather than to a next run beside it.
    await this.#settleSupersededContinue(sessionId);
    await this.#deps.sessionLock.run(sessionId, async () => {
      // The interrupt's choice for the run's messages is written first.
      if (this.#deps.delivery.isHeldForInterrupt(runId)) {
        this.#endsAwaitingInterrupt.add(runId);
        return;
      }
      await this.#settleEnd(sessionId, runId);
    });
  }

  async #settleSupersededContinue(sessionId: SessionId): Promise<void> {
    const sessionKey = canonicalizeUuid(sessionId);
    const continuingRunId = this.#supersededContinueBySession.get(sessionKey);
    if (continuingRunId === undefined) {
      return;
    }
    await this.#deps.admission.settled(continuingRunId);
    if (this.#supersededContinueBySession.get(sessionKey) === continuingRunId) {
      this.#supersededContinueBySession.delete(sessionKey);
    }
  }

  // Under the session lock: what a run's end leaves of its reservation and its waiting messages.
  async #settleEnd(sessionId: SessionId, runId: RunId): Promise<void> {
    const { admission, delivery, items, recorder } = this.#deps;
    const state = this.#deps.runs.getRun(runId)?.state;
    // A run continued since is handed its messages as it runs.
    if (state === undefined || !isTerminalState(state)) {
      return;
    }
    const sessionKey = canonicalizeUuid(sessionId);
    if (this.#restingRunBySession.get(sessionKey) === runId) {
      this.#restingRunBySession.delete(sessionKey);
    }
    // Messages moved on to this run went with it, beyond an interrupt of the run they left.
    for (const [endedRunId, moved] of [...this.#movedLeftoversByRun]) {
      if (moved.toRunId === runId) {
        this.#movedLeftoversByRun.delete(endedRunId);
      }
    }
    // Only the session's current lead run rests interrupted for a continue; an older one's messages
    // go on as any ended run's do.
    const current = items.readCurrentLeadRun(sessionId);
    const isResting = state === "interrupted" && current?.runId === runId;
    if (isResting) {
      admission.parkInterrupted(sessionId, runId);
    } else {
      admission.release(runId);
    }
    await admission.settleOpening(runId);
    await delivery.settle(sessionId);
    delivery.endRun(sessionId, runId);
    if (isResting) {
      this.#letGoRestingRun(sessionId);
      this.#restingRunBySession.set(sessionKey, runId);
      this.continueInterruptedRun(sessionId, runId);
      return;
    }
    // A message Claude Code keeps for its next turn is not sent again.
    const waiting = items
      .listWaitingForRun(runId)
      .filter((item) => item.childHandle === undefined && !delivery.isHanded(item.id));
    // A lead run newer than the current one failed to start, such as a turn Codex started itself
    // whose run failed to open: the interrupted run before it is current again, so it rests for its
    // continue once more and takes this run's messages.
    const restingAgainRunId =
      current?.state === "interrupted" && current.runId < runId ? current.runId : undefined;
    if (restingAgainRunId !== undefined) {
      if (this.#restingRunBySession.get(sessionKey) !== restingAgainRunId) {
        this.#letGoRestingRun(sessionId);
        this.#restingRunBySession.set(sessionKey, restingAgainRunId);
      }
      if (waiting.length > 0) {
        await recorder.recordRetarget(
          { runId: restingAgainRunId, state: "interrupted" },
          waiting,
          this.#deps.now(),
        );
        this.#movedLeftoversByRun.set(runId, {
          sessionId,
          toRunId: restingAgainRunId,
          itemIds: waiting.map((item) => item.id),
        });
      }
      this.continueInterruptedRun(sessionId, restingAgainRunId);
      return;
    }
    if (waiting.length === 0) {
      return;
    }
    const now = this.#deps.now();
    const itemIds = waiting.map((item) => item.id);
    const liveRunId = items.readLiveLeadRun(sessionId);
    if (liveRunId !== undefined) {
      await recorder.recordRetarget({ runId: liveRunId, state: "live" }, waiting, now);
      this.#movedLeftoversByRun.set(runId, { sessionId, toRunId: liveRunId, itemIds });
      delivery.handWaiting(sessionId, liveRunId);
      return;
    }
    const queued: RunQueuedPayload = {
      sessionId,
      runId: RunIdSchema.parse(mintUuidV7()),
      runVersion: 0,
      newState: "queued",
      agentId: this.#deps.readLeadAgent(sessionId),
    };
    await recorder.recordNextRun(queued, waiting, now);
    this.#movedLeftoversByRun.set(runId, { sessionId, toRunId: queued.runId, itemIds });
    admission.start(sessionId, queued.runId);
  }

  #onChain(sessionId: SessionId, task: () => Promise<void>): void {
    void this.#changeChain.run(sessionId, task).catch((error: unknown) => {
      this.#deps.writeServiceLog(
        `run queue: following the runs of session ${sessionId} failed: ${describeRejection(error)}`,
      );
    });
  }
}
