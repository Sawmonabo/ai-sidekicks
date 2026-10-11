// Follows every run's state changes for the run queue, from the session log's committed events,
// each session's in order. Every change weighs the memory gate again and reads the session's
// process peak into the run's reservation; a run waiting on a person gives its reservation up and
// takes it again when it runs. A run that runs again after a pause has its continue's messages
// admitted, and a Claude run that runs is handed what waits for it. At a run's end its reservation
// is released, and the lead's messages still waiting for it, but those the still-running Claude
// Code process keeps for its next turn, become the next run's, or go into the lead run another start made live meanwhile.
//
// A session whose events could not all be read, and every session when the daemon starts, is
// read again from the record: a run that ended unseen is ended as above, and a queued run no start
// holds is started.

import type { AgentId } from "@ai-sidekicks/contracts/agent/definition";
import type { EventEnvelope } from "@ai-sidekicks/contracts/event/envelope";
import type { RunStateChangeState } from "@ai-sidekicks/contracts/run/events";
import { RunIdSchema, type RunId } from "@ai-sidekicks/contracts/run/id";
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
import type { QueueRecorder } from "./recorder.js";
import type { QueueItemReader } from "./store.js";

const CREDITS_CHOICE_REQUESTED_TYPE = "run.usage_credits_choice_requested";
const CREDITS_CHOICE_RESOLVED_TYPE = "run.usage_credits_choice_resolved";

// The run states in which a run waits on a person and holds no reservation.
const PARKED_STATES: ReadonlySet<RunStateChangeState> = new Set([
  "waiting_for_approval",
  "waiting_for_input",
  "paused",
]);

/** What the run lifecycle reads, writes and calls. */
export interface QueueRunLifecycleDeps {
  readonly items: QueueItemReader;
  readonly recorder: Pick<QueueRecorder, "recordNextRun" | "recordRetarget">;
  readonly runs: Pick<RunStateReader, "getRun">;
  readonly admission: Pick<
    QueueAdmission,
    "start" | "settled" | "park" | "resume" | "release" | "observeProcessPeak" | "isAdmitting"
  >;
  readonly delivery: Pick<
    QueueDelivery,
    "handWaiting" | "admitContinued" | "settle" | "endRun" | "isHanded" | "noteCreditsChoice"
  >;
  readonly memoryGate: Pick<MemoryGate, "weigh">;
  readonly readLeadAgent: (sessionId: SessionId) => AgentId;
  /** The queue's per-session lock, which every decision on a session's waiting messages takes. */
  readonly sessionLock: KeyedLock<SessionId>;
  readonly writeServiceLog: ServiceLogWriter;
  readonly now: () => string;
}

/** Keeps the queue's reservations and waiting messages in step with each run's state. */
export class QueueRunLifecycle {
  readonly #deps: QueueRunLifecycleDeps;
  // Each session's changes are applied one at a time, in the log's order.
  readonly #changeChain = new KeyedLock<SessionId>(canonicalizeUuid);

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
    const { admission, items, runs } = this.#deps;
    const waiting = items.list(sessionId, undefined, "queued");
    const runIds = new Set(waiting.flatMap((item) => item.targetRunId ?? []));
    for (const runId of runIds) {
      const state = runs.getRun(runId)?.state;
      if (state !== undefined && isTerminalState(state)) {
        await this.#endRun(sessionId, runId);
      } else if (state === "queued" && !admission.isAdmitting(runId)) {
        admission.start(sessionId, runId);
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
    if (newState !== "running") {
      return;
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

  async #endRun(sessionId: SessionId, runId: RunId): Promise<void> {
    const { admission, delivery, items, recorder } = this.#deps;
    await admission.settled(runId);
    admission.release(runId);
    await this.#deps.sessionLock.run(sessionId, async () => {
      await delivery.settle(sessionId);
      delivery.endRun(sessionId, runId);
      // A message Claude Code keeps for its next turn is not sent again.
      const waiting = items
        .listWaitingForRun(runId)
        .filter((item) => item.childHandle === undefined && !delivery.isHanded(item.id));
      if (waiting.length === 0) {
        return;
      }
      const now = this.#deps.now();
      const liveRunId = items.readLiveLeadRun(sessionId);
      if (liveRunId !== undefined) {
        await recorder.recordRetarget(liveRunId, waiting, now);
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
      admission.start(sessionId, queued.runId);
    });
  }

  #onChain(sessionId: SessionId, task: () => Promise<void>): void {
    void this.#changeChain.run(sessionId, task).catch((error: unknown) => {
      this.#deps.writeServiceLog(
        `run queue: following the runs of session ${sessionId} failed: ${describeRejection(error)}`,
      );
    });
  }
}
