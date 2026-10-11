// Hands a live run the messages waiting for it, each under its own queue item id. Claude Code is
// handed a message at once and holds it to its next tool boundary itself; for Codex the daemon
// holds every message and, at the thread's next tool boundary, hands the driver all it holds at
// once, in the queue's order. A message sent while the run waits on the person's input goes as the
// next turn instead, except while Claude Code holds a credits choice, which the message settles.
//
// A handed message stays `queued` until the provider has it: a Codex steer the driver sent, a
// Claude message Claude Code replays as taken, or one the run's end, a withdraw or a next turn
// shows it took. Each is admitted naming the run that took it. Until then no edit, removal or
// reorder moves it, except by Claude Code's own withdraw, which a change waits for only so long:
// one whose withdraw fails or is not answered in time reads not delivered, so a stuck process
// never holds the session's writes, and is admitted after all if Claude Code then shows it took it.
// One whose withdraw went unanswered stays handed until Claude Code answers it, since Claude Code
// may still start a turn with it.
// A message Claude Code keeps past its run's end stays queued, for the turn Claude Code starts with
// it, whose replay admits it, while the process it was handed to still runs; once that process is
// gone it goes to the next run. While an interrupt of a run is under way nothing more is handed
// to it, so the interrupt's choice decides every message still waiting. What waits for an
// interrupted run that a newer lead run took over is handed to that run as to any live run. Every
// call that hands, withdraws or settles a session's messages runs on one chain per session, so
// they reach the driver in the order the queue decided them.

import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import { QueueItemIdSchema, type QueueItemId } from "@ai-sidekicks/contracts/run/queue";
import type { RunState } from "@ai-sidekicks/contracts/run/state";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { canonicalizeUuid } from "@ai-sidekicks/contracts/uuid-canonical";
import type { DriverInterventionResult } from "@ai-sidekicks/contracts/provider/driver/intervention";

import { waitWithin } from "../bounded-wait.js";
import type { ServiceLogWriter } from "../daemon/service-log.js";
import {
  resolveDriverForSessionOrThrow,
  type SessionDriverDeps,
} from "../ipc/handlers/driver/resolution.js";
import { KeyedLock } from "../keyed-lock.js";
import type { ProviderDriver } from "../provider/driver/contract.js";
import {
  SteerTurnEndedError,
  type RunToolBoundary,
  type WaitingMessage,
} from "../provider/driver/run-control.js";
import { describeRejection } from "../rejection.js";
import type { RunStateReader } from "../session/run/read.js";
import { RunNotFoundError } from "../session/run/refusals.js";
import { isTerminalState } from "../session/run/transitions.js";
import type { QueueRecorder } from "./recorder.js";
import type { QueueItemReader, QueueItemRecord } from "./store.js";

// The run states in which Claude Code is handed a message at once.
const CLAUDE_HANDING_STATES: ReadonlySet<RunState> = new Set(["running", "waiting_for_approval"]);

// How long a change waits for Claude Code to give its handed messages back, all withdrawn at once.
// A withdraw is one control request Claude Code answers without running a turn, so an answer this
// late means the process is stuck; the request's own one-minute deadline would hold every write on
// the session for a minute.
const WITHDRAW_DEADLINE_MS = 10_000;

// A message the provider has been handed and not yet confirmed taking: by the driver, or by the
// continue of a paused run, which delivers the messages that waited for it.
interface HandedMessage {
  readonly runId: RunId;
  readonly driverName: ProviderName;
  readonly route: "driver" | "continue";
  /** The provider process it was handed to, or `undefined` while none ran. */
  readonly processId: number | undefined;
}

/**
 * What a withdraw ahead of a change found: the message is the queue's to change (`returned`), the
 * provider has it (`taken`), or its withdraw failed or was not answered in time and it now reads
 * not delivered (`not_delivered`).
 */
export type QueueWithdrawal = "returned" | "taken" | "not_delivered";

/** What the delivery reads, writes and calls. */
export interface QueueDeliveryDeps {
  readonly items: QueueItemReader;
  readonly recorder: Pick<QueueRecorder, "recordOutcome" | "recordLateAdmission">;
  readonly runs: Pick<RunStateReader, "getRun">;
  readonly sessions: SessionDriverDeps;
  /** Whether a message is the opening of a run whose driver is being started. */
  readonly isOpening: (itemId: QueueItemId) => boolean;
  /** The queue's per-session lock, which every decision on a session's waiting messages takes. */
  readonly sessionLock: KeyedLock<SessionId>;
  /** The process id of the session's provider process, or `undefined` while none runs. */
  readonly readProviderProcessId: (sessionId: SessionId) => number | undefined;
  /**
   * Continues an interrupted run with the messages waiting for it, once the last one Claude Code
   * kept was taken in the turn the interrupt stopped; called off the session lock.
   */
  readonly continueInterruptedRun: (sessionId: SessionId, runId: RunId) => void;
  readonly writeServiceLog: ServiceLogWriter;
  readonly now: () => string;
  /** How long a change waits for Claude Code to give its handed messages back; defaults to 10 s. */
  readonly withdrawDeadlineMs?: number;
}

/** Hands live runs their waiting messages, holds Codex's, and takes back Claude Code's. */
export class QueueDelivery {
  readonly #deps: QueueDeliveryDeps;
  readonly #withdrawDeadlineMs: number;
  readonly #handed = new Map<QueueItemId, HandedMessage>();
  // Messages sent while their run waited on input, which go as the next turn, by the run.
  readonly #nextTurnRunByItemId = new Map<QueueItemId, RunId>();
  // Runs on which Claude Code holds a credits choice that a message settles.
  readonly #creditsChoiceRunIds = new Set<RunId>();
  // Runs an interrupt is under way on, which are handed nothing until it settles.
  readonly #interruptedRunIds = new Set<RunId>();
  readonly #handChain = new KeyedLock<SessionId>(canonicalizeUuid);

  constructor(deps: QueueDeliveryDeps) {
    this.#deps = deps;
    this.#withdrawDeadlineMs = deps.withdrawDeadlineMs ?? WITHDRAW_DEADLINE_MS;
  }

  /**
   * Takes a message just sent into the live run it waits for: kept for the next turn while the run
   * waits on input, else handed as the run's provider takes messages. Called under the session
   * lock.
   */
  acceptSend(item: QueueItemRecord, runId: RunId): void {
    const run = this.#deps.runs.getRun(runId);
    if (run?.state === "waiting_for_input" && !this.#creditsChoiceRunIds.has(runId)) {
      this.#nextTurnRunByItemId.set(item.id, runId);
      return;
    }
    this.handWaiting(item.sessionId, runId);
  }

  /**
   * Hands Claude Code every message waiting for `runId` it has not been handed, in the queue's
   * order, while the run is in a state that takes them; a Codex run holds them for its next tool
   * boundary. Called under the session lock, so the hands join the session's chain in that order.
   */
  handWaiting(sessionId: SessionId, runId: RunId): void {
    const run = this.#deps.runs.getRun(runId);
    if (run === undefined) {
      return;
    }
    const { driverName, driver } = resolveDriverForSessionOrThrow(this.#deps.sessions, sessionId);
    const takesMessages =
      CLAUDE_HANDING_STATES.has(run.state) ||
      (run.state === "waiting_for_input" && this.#creditsChoiceRunIds.has(runId));
    if (driverName !== "claude" || !takesMessages || this.#interruptedRunIds.has(runId)) {
      return;
    }
    const items = this.#unhandedWaiting(runId);
    if (items.length === 0) {
      return;
    }
    this.#markHanded(items, runId, driverName, "driver");
    this.#onChain(sessionId, async () => {
      for (const item of items) {
        try {
          const result = await this.#steer(driver, item, runId);
          // A message that settled a held choice started the next turn, which took it.
          if (result.deliveredRunId !== undefined) {
            await this.#admit(item, result.deliveredRunId);
          }
        } catch (error) {
          await this.#settleFailedHand(item, runId, error);
        }
      }
    });
  }

  /**
   * Hands the driver every message the run's queue holds, at once and in the queue's order, at a
   * tool boundary of a Codex run's turn; each the driver sent is admitted. Failures are written to
   * the messages and the service log.
   */
  onToolBoundary(boundary: RunToolBoundary): void {
    const { sessionId, runId } = boundary;
    void this.#deps.sessionLock
      .run(sessionId, () => {
        const items = this.#interruptedRunIds.has(runId) ? [] : this.#unhandedWaiting(runId);
        if (items.length === 0) {
          return Promise.resolve();
        }
        const { driverName, driver } = resolveDriverForSessionOrThrow(
          this.#deps.sessions,
          sessionId,
        );
        this.#markHanded(items, runId, driverName, "driver");
        this.#onChain(sessionId, async () => {
          // Every steer is handed over before any is awaited; the driver sends them in that order.
          const steers = items.map((item) => this.#steer(driver, item, runId));
          const results = await Promise.allSettled(steers);
          for (const [index, item] of items.entries()) {
            const result = results[index];
            if (result?.status === "fulfilled") {
              await this.#admit(item, runId);
            } else {
              await this.#settleFailedHand(item, runId, result?.reason);
            }
          }
        });
        return Promise.resolve();
      })
      .catch((error: unknown) => {
        this.#deps.writeServiceLog(
          `run queue: the tool boundary of run ${runId} could not hand its messages: ` +
            describeRejection(error),
        );
      });
  }

  /**
   * The messages waiting for a paused run that its continue delivers, in the queue's order; each is
   * admitted once the driver continued the run with them, and given back when it did not.
   */
  readWaitingMessages(runId: RunId): WaitingMessage[] {
    // A continue that did not go delivered nothing, so a later one delivers the same messages.
    const items = this.#unhandedWaiting(runId, "continue");
    const [first] = items;
    if (first !== undefined) {
      const { driverName } = resolveDriverForSessionOrThrow(this.#deps.sessions, first.sessionId);
      this.#markHanded(items, runId, driverName, "continue");
    }
    return items.map((item) => ({
      id: item.id,
      content: item.body.content,
      ...(item.body.attachments === undefined ? {} : { attachments: [...item.body.attachments] }),
      ...(item.body.skills === undefined ? {} : { skills: item.body.skills }),
    }));
  }

  /** Gives back the messages a continue of `runId` read and did not deliver, as it was refused. */
  releaseContinued(runId: RunId): void {
    for (const [itemId, handed] of [...this.#handed]) {
      if (handed.runId === runId && handed.route === "continue") {
        this.#handed.delete(itemId);
      }
    }
  }

  /** Admits the messages the continue of `runId` delivered, once the driver continued it. */
  async admitContinued(runId: RunId): Promise<void> {
    for (const [itemId, handed] of [...this.#handed]) {
      if (handed.runId === runId && handed.route === "continue") {
        const item = this.#deps.items.get(itemId);
        if (item !== undefined) {
          await this.#admit(item, runId);
        }
      }
    }
  }

  /**
   * Admits a message Claude Code replayed as taken, into `runId`, the run whose turn took it, and
   * one of the session's that reads not delivered after its withdraw went unanswered, since the
   * agent took it after all. Any other message is left as it is.
   */
  messageTaken(sessionId: SessionId, messageId: string, runId: RunId): void {
    const parsedId = QueueItemIdSchema.safeParse(messageId);
    if (!parsedId.success) {
      return;
    }
    const itemId = parsedId.data;
    this.#onChain(sessionId, async () => {
      const item = this.#deps.items.get(itemId);
      const handed = this.#handed.get(itemId);
      if (handed?.route === "driver" && handed.driverName === "claude") {
        if (item?.state === "queued") {
          await this.#admit(item, runId);
        } else {
          this.#handed.delete(itemId);
          // One whose withdraw went unanswered reads not delivered; the agent took it after all.
          await this.#admitUndelivered(itemId, runId);
        }
        // Claude Code keeps no turn for a run whose kept messages it took before the interrupt.
        if (this.#deps.runs.getRun(handed.runId)?.state === "interrupted") {
          this.#deps.continueInterruptedRun(sessionId, handed.runId);
        }
        return;
      }
      if (
        handed === undefined &&
        item !== undefined &&
        canonicalizeUuid(item.sessionId) === canonicalizeUuid(sessionId)
      ) {
        await this.#admitUndelivered(itemId, runId);
      }
    });
  }

  /**
   * Takes `items`, all of one session, back from their provider ahead of a change to them, on the
   * session's chain, the wait for the chain and every withdraw at once under one deadline, and says
   * of each whether it is still the queue's to change: waiting, not a starting run's opening, and
   * given back. A Claude withdraw finding one delivered admits it, and one whose withdraw Claude
   * Code failed or did not answer within the deadline, or that the chain did not reach by then,
   * reads not delivered, `failed`, and answers `not_delivered`.
   */
  async takeBack(
    sessionId: SessionId,
    items: readonly QueueItemRecord[],
  ): Promise<ReadonlyMap<QueueItemId, QueueWithdrawal>> {
    const candidates = items.filter(
      (item) => item.state === "queued" && !this.#deps.isOpening(item.id),
    );
    const deadline = AbortSignal.timeout(this.#withdrawDeadlineMs);
    let hasStarted = false;
    const withdrawing = this.#handChain.run(sessionId, async () => {
      // A take-back the chain reached too late was already answered.
      if (deadline.aborted) {
        return undefined;
      }
      hasStarted = true;
      return new Map(
        await Promise.all(
          candidates.map(async (item) => [item.id, await this.#withdraw(item, deadline)] as const),
        ),
      );
    });
    const isReached =
      (await waitWithin(withdrawing, this.#withdrawDeadlineMs, deadline)) || hasStarted;
    const withdrawals =
      (isReached ? await withdrawing : undefined) ??
      new Map(
        await Promise.all(
          candidates.map(async (item) => {
            await this.#recordUnreturned(item, "waited past the deadline behind earlier hands");
            return [item.id, "not_delivered"] as const;
          }),
        ),
      );
    return new Map(
      items.map((item): [QueueItemId, QueueWithdrawal] => {
        const withdrawal = withdrawals.get(item.id) ?? "taken";
        if (withdrawal !== "returned") {
          return [item.id, withdrawal];
        }
        return [item.id, this.#deps.items.get(item.id)?.state === "queued" ? "returned" : "taken"];
      }),
    );
  }

  /**
   * Forgets that the provider was handed any of `itemIds` or that one waits for a next turn, once
   * they have left the queue in a write another made.
   */
  forget(itemIds: readonly QueueItemId[]): void {
    for (const itemId of itemIds) {
      this.#handed.delete(itemId);
      this.#nextTurnRunByItemId.delete(itemId);
    }
  }

  /** Settles once every hand and withdraw queued on the session's chain has settled. */
  async settle(sessionId: SessionId): Promise<void> {
    await this.#handChain.run(sessionId, () => Promise.resolve());
  }

  /**
   * Runs `task` on the session's chain, once every hand and withdraw queued before it has settled
   * and before any queued after it, so no message changes state while it reads and writes.
   */
  async runBetweenHands<T>(sessionId: SessionId, task: () => Promise<T>): Promise<T> {
    return await this.#handChain.run(sessionId, task);
  }

  /**
   * Holds back every hand to `runId` while an interrupt of it is under way, until
   * {@link releaseInterruptHold}. Called under the session lock.
   */
  holdForInterrupt(runId: RunId): void {
    this.#interruptedRunIds.add(runId);
  }

  /** Ends an interrupt's hold on `runId`, answering whether one was held. */
  releaseInterruptHold(runId: RunId): boolean {
    return this.#interruptedRunIds.delete(runId);
  }

  /** Whether an interrupt of `runId` is under way. */
  isHeldForInterrupt(runId: RunId): boolean {
    return this.#interruptedRunIds.has(runId);
  }

  /** Records whether Claude Code holds a credits choice on `runId`, which a message settles. */
  noteCreditsChoice(runId: RunId, isHeld: boolean): void {
    if (isHeld) {
      this.#creditsChoiceRunIds.add(runId);
    } else {
      this.#creditsChoiceRunIds.delete(runId);
    }
  }

  /**
   * Settles what was handed to the ended run `runId`: a Codex steer the driver did not send and a
   * continue that never ran delivered nothing. A message Claude Code was handed and has not
   * replayed stays queued and handed while the process it was handed to still runs, since Claude
   * Code keeps it for its next turn, whose replay admits it; one whose process is gone delivered
   * nothing. The run's other waiting messages are left for the next run. Called after
   * {@link settle}.
   */
  endRun(sessionId: SessionId, runId: RunId): void {
    this.#creditsChoiceRunIds.delete(runId);
    const liveProcessId = this.#deps.readProviderProcessId(sessionId);
    for (const [itemId, handed] of [...this.#handed]) {
      if (handed.runId === runId && !isKeptByProcess(handed, liveProcessId)) {
        this.#handed.delete(itemId);
      }
    }
    for (const [itemId, nextTurnRunId] of [...this.#nextTurnRunByItemId]) {
      if (nextTurnRunId === runId) {
        this.#nextTurnRunByItemId.delete(itemId);
      }
    }
  }

  /**
   * Forgets each message of `sessionId` Claude Code kept past its run's end in a process that is
   * no longer the session's, which delivered nothing, and answers the ended runs they waited for.
   */
  forgetKeptByGoneProcess(sessionId: SessionId): RunId[] {
    const liveProcessId = this.#deps.readProviderProcessId(sessionId);
    const endedRunIds = new Set<RunId>();
    for (const [itemId, handed] of [...this.#handed]) {
      const item = this.#deps.items.get(itemId);
      const state = this.#deps.runs.getRun(handed.runId)?.state;
      if (
        item !== undefined &&
        canonicalizeUuid(item.sessionId) === canonicalizeUuid(sessionId) &&
        state !== undefined &&
        isTerminalState(state) &&
        handed.route === "driver" &&
        handed.driverName === "claude" &&
        !isKeptByProcess(handed, liveProcessId)
      ) {
        this.#handed.delete(itemId);
        endedRunIds.add(handed.runId);
      }
    }
    return [...endedRunIds];
  }

  /** Whether the provider has been handed `itemId` and has not yet said what became of it. */
  isHanded(itemId: QueueItemId): boolean {
    return this.#handed.has(itemId);
  }

  /**
   * Whether the Claude Code process of `sessionId` may still hold a message handed for `runId`,
   * which it starts a turn of its own with: one waiting, or one that reads not delivered because
   * its withdraw has not been answered.
   */
  isMessageKeptForRun(sessionId: SessionId, runId: RunId): boolean {
    const liveProcessId = this.#deps.readProviderProcessId(sessionId);
    for (const handed of this.#handed.values()) {
      if (handed.runId === runId && isKeptByProcess(handed, liveProcessId)) {
        return true;
      }
    }
    return false;
  }

  // The lead's messages waiting for the run that go now: not handed, except by the route
  // `rehanded`, not kept for the next turn, and not a run's opening. A child's steer box delivers
  // the child's own.
  #unhandedWaiting(runId: RunId, rehanded?: HandedMessage["route"]): QueueItemRecord[] {
    return this.#deps.items.listWaitingForRun(runId).filter((item) => {
      const handed = this.#handed.get(item.id);
      return (
        item.childHandle === undefined &&
        (handed === undefined || handed.route === rehanded) &&
        !this.#nextTurnRunByItemId.has(item.id) &&
        !this.#deps.isOpening(item.id)
      );
    });
  }

  #markHanded(
    items: readonly QueueItemRecord[],
    runId: RunId,
    driverName: ProviderName,
    route: HandedMessage["route"],
  ): void {
    for (const item of items) {
      const processId = this.#deps.readProviderProcessId(item.sessionId);
      this.#handed.set(item.id, { runId, driverName, route, processId });
    }
  }

  // Joins the session's chain now, in call order; a failure the task left is logged.
  #onChain(sessionId: SessionId, task: () => Promise<void>): void {
    void this.#handChain.run(sessionId, task).catch((error: unknown) => {
      this.#deps.writeServiceLog(
        `run queue: delivering messages on session ${sessionId} failed: ${describeRejection(error)}`,
      );
    });
  }

  async #steer(
    driver: ProviderDriver,
    item: QueueItemRecord,
    runId: RunId,
  ): Promise<DriverInterventionResult> {
    const run = this.#deps.runs.getRun(runId);
    if (run === undefined) {
      throw new RunNotFoundError(runId);
    }
    return driver.applyIntervention({
      type: "steer",
      targetRunId: runId,
      expectedRunVersion: run.version,
      clientIdempotencyKey: item.id,
      payload: {
        content: item.body.content,
        ...(item.body.attachments === undefined ? {} : { attachments: [...item.body.attachments] }),
        ...(item.body.skills === undefined ? {} : { skills: [...item.body.skills] }),
      },
    });
  }

  // One withdraw of a `takeBack`, on the session's chain.
  async #withdraw(item: QueueItemRecord, deadline: AbortSignal): Promise<QueueWithdrawal> {
    const handed = this.#handed.get(item.id);
    if (handed === undefined) {
      return "returned";
    }
    if (handed.route === "continue" || handed.driverName !== "claude") {
      return "taken";
    }
    const { driver } = resolveDriverForSessionOrThrow(this.#deps.sessions, item.sessionId);
    const withdrawing = driver.withdrawQueuedMessage({
      sessionId: item.sessionId,
      runId: handed.runId,
      clientIdempotencyKey: item.id,
    });
    if (!(await waitWithin(withdrawing, this.#withdrawDeadlineMs, deadline))) {
      void withdrawing.then(
        (late) => {
          this.#deps.writeServiceLog(
            `run queue: Claude Code answered the withdraw of message ${item.id} after the ` +
              `deadline: ${late.status}`,
          );
          this.#onChain(item.sessionId, async () => {
            await this.#settleLateWithdraw(item, handed, late.status === "already_delivered");
          });
        },
        (error: unknown) => {
          this.#deps.writeServiceLog(
            `run queue: the withdraw of message ${item.id} failed after the deadline: ` +
              describeRejection(error),
          );
          this.#onChain(item.sessionId, async () => {
            await this.#settleLateWithdraw(item, handed, false);
          });
        },
      );
      // Still handed: Claude Code may yet start a turn with it, which no continue may race.
      await this.#recordUnreturned(item, "was not answered within the deadline");
      return "not_delivered";
    }
    let result: Awaited<typeof withdrawing>;
    try {
      result = await withdrawing;
    } catch (error) {
      this.#handed.delete(item.id);
      await this.#recordUnreturned(item, `failed: ${describeRejection(error)}`);
      return "not_delivered";
    }
    if (result.status === "already_delivered") {
      await this.#admit(item, handed.runId);
      return "taken";
    }
    this.#handed.delete(item.id);
    return "returned";
  }

  // Admits an item that reads not delivered into `runId`, unless something moved it meanwhile.
  async #admitUndelivered(itemId: QueueItemId, runId: RunId): Promise<void> {
    const item = this.#deps.items.get(itemId);
    if (item?.state === "not_delivered") {
      await this.#deps.recorder.recordLateAdmission(item, runId, this.#deps.now());
    }
  }

  async #admit(item: QueueItemRecord, runId: RunId): Promise<void> {
    this.#handed.delete(item.id);
    await this.#deps.recorder.recordOutcome(item, { to: "admitted", runId }, this.#deps.now());
  }

  // Settles a withdraw Claude Code answered after the deadline, unless the message's replay settled
  // it first: one it had taken is admitted, and with the message no longer Claude Code's to keep,
  // its interrupted run is continued with what waits for it.
  async #settleLateWithdraw(
    item: QueueItemRecord,
    handed: HandedMessage,
    isDelivered: boolean,
  ): Promise<void> {
    if (this.#handed.get(item.id) !== handed) {
      return;
    }
    this.#handed.delete(item.id);
    if (isDelivered) {
      await this.#admitUndelivered(item.id, handed.runId);
    }
    if (this.#deps.runs.getRun(handed.runId)?.state === "interrupted") {
      this.#deps.continueInterruptedRun(item.sessionId, handed.runId);
    }
  }

  // A handed message Claude Code did not give back: whether it reaches the agent is unknown, so it
  // reads not delivered and can be sent again.
  async #recordUnreturned(item: QueueItemRecord, what: string): Promise<void> {
    this.#deps.writeServiceLog(`run queue: the withdraw of message ${item.id} ${what}`);
    if (this.#deps.items.get(item.id)?.state === "queued") {
      await this.#deps.recorder.recordOutcome(
        item,
        { to: "not_delivered", reason: "failed" },
        this.#deps.now(),
      );
    }
  }

  // A hand that failed: the message was not delivered, unless its turn or its run ended first,
  // when it waits for the run's next turn or the next run with the run's other messages.
  async #settleFailedHand(item: QueueItemRecord, runId: RunId, error: unknown): Promise<void> {
    this.#handed.delete(item.id);
    if (error instanceof SteerTurnEndedError) {
      return;
    }
    this.#deps.writeServiceLog(
      `run queue: message ${item.id} could not be handed to run ${runId}: ` +
        describeRejection(error),
    );
    const run = this.#deps.runs.getRun(runId);
    if (run !== undefined && !isTerminalState(run.state)) {
      await this.#deps.recorder.recordOutcome(
        item,
        { to: "not_delivered", reason: "failed" },
        this.#deps.now(),
      );
    }
  }
}

// Whether `handed` is a message Claude Code holds in the process it was handed to, which is still
// the session's process `liveProcessId`.
function isKeptByProcess(handed: HandedMessage, liveProcessId: number | undefined): boolean {
  return (
    handed.route === "driver" &&
    handed.driverName === "claude" &&
    handed.processId !== undefined &&
    handed.processId === liveProcessId
  );
}
