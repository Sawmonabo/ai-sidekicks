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
// A message Claude Code keeps past its run's end stays queued, for the turn Claude Code starts with
// it, whose replay admits it, while the process it was handed to still runs; once that process is
// gone it goes to the next run. Every call that hands, withdraws or settles a session's messages
// runs on one chain per session, so they reach the driver in the order the queue decided them.

import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import { QueueItemIdSchema, type QueueItemId } from "@ai-sidekicks/contracts/run/queue";
import type { RunState } from "@ai-sidekicks/contracts/run/state";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { canonicalizeUuid } from "@ai-sidekicks/contracts/uuid-canonical";
import type { DriverInterventionResult } from "@ai-sidekicks/contracts/provider/driver/intervention";

import type { ServiceLogWriter } from "../daemon/service-log.js";
import {
  resolveDriverForSessionOrThrow,
  type SessionDriverDeps,
} from "../ipc/handlers/driver/resolution.js";
import { KeyedLock } from "../keyed-lock.js";
import type { ProviderDriver } from "../provider/driver/contract.js";
import type { RunToolBoundary, WaitingMessage } from "../provider/driver/run-control.js";
import { describeRejection } from "../rejection.js";
import type { RunStateReader } from "../session/run/read.js";
import { RunNotFoundError } from "../session/run/refusals.js";
import { isTerminalState } from "../session/run/transitions.js";
import type { QueueRecorder } from "./recorder.js";
import type { QueueItemReader, QueueItemRecord } from "./store.js";

// The run states in which Claude Code is handed a message at once.
const CLAUDE_HANDING_STATES: ReadonlySet<RunState> = new Set(["running", "waiting_for_approval"]);

// How long a change waits for Claude Code to give a handed message back. A withdraw is one control
// request Claude Code answers without running a turn, so an answer this late means the process is
// stuck; the request's own one-minute deadline, once per message of a reorder, would hold every
// write on the session for minutes.
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
  readonly writeServiceLog: ServiceLogWriter;
  readonly now: () => string;
}

/** Hands live runs their waiting messages, holds Codex's, and takes back Claude Code's. */
export class QueueDelivery {
  readonly #deps: QueueDeliveryDeps;
  readonly #handed = new Map<QueueItemId, HandedMessage>();
  // Messages sent while their run waited on input, which go as the next turn, by the run.
  readonly #nextTurnRunByItemId = new Map<QueueItemId, RunId>();
  // Runs on which Claude Code holds a credits choice that a message settles.
  readonly #creditsChoiceRunIds = new Set<RunId>();
  readonly #handChain = new KeyedLock<SessionId>(canonicalizeUuid);

  constructor(deps: QueueDeliveryDeps) {
    this.#deps = deps;
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
    if (driverName !== "claude" || !takesMessages) {
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
        const items = this.#unhandedWaiting(runId);
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
   * admitted once the run runs again.
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

  /** Admits the messages the continue of `runId` delivered, now that it runs again. */
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
   * Takes `item` back from its provider ahead of a change to it, on the session's chain, and says
   * whether it is the queue's to change; a Claude withdraw finding it delivered admits it. A
   * withdraw Claude Code failed or did not answer within the deadline leaves the message not
   * delivered, `failed`, and answers `not_delivered`.
   */
  async withdraw(item: QueueItemRecord): Promise<QueueWithdrawal> {
    return this.#handChain.run(item.sessionId, async () => {
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
      let result: Awaited<typeof withdrawing> | "timed_out";
      try {
        result = await this.#withinWithdrawDeadline(withdrawing);
      } catch (error) {
        await this.#settleUnreturned(item, `failed: ${describeRejection(error)}`);
        return "not_delivered";
      }
      if (result === "timed_out") {
        void withdrawing.then(
          (late) => {
            this.#deps.writeServiceLog(
              `run queue: Claude Code answered the withdraw of message ${item.id} after the ` +
                `deadline: ${late.status}`,
            );
            // Claude Code had read it, so the record follows what the agent got.
            if (late.status === "already_delivered") {
              this.#onChain(item.sessionId, async () => {
                await this.#admitUndelivered(item.id, handed.runId);
              });
            }
          },
          (error: unknown) => {
            this.#deps.writeServiceLog(
              `run queue: the withdraw of message ${item.id} failed after the deadline: ` +
                describeRejection(error),
            );
          },
        );
        await this.#settleUnreturned(item, "was not answered within the deadline");
        return "not_delivered";
      }
      if (result.status === "already_delivered") {
        await this.#admit(item, handed.runId);
        return "taken";
      }
      this.#handed.delete(item.id);
      return "returned";
    });
  }

  /** Settles once every hand and withdraw queued on the session's chain has settled. */
  async settle(sessionId: SessionId): Promise<void> {
    await this.#handChain.run(sessionId, () => Promise.resolve());
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
      const isKeptByClaudeCode =
        handed.route === "driver" &&
        handed.driverName === "claude" &&
        handed.processId !== undefined &&
        handed.processId === liveProcessId;
      if (handed.runId === runId && !isKeptByClaudeCode) {
        this.#handed.delete(itemId);
      }
    }
    for (const [itemId, nextTurnRunId] of [...this.#nextTurnRunByItemId]) {
      if (nextTurnRunId === runId) {
        this.#nextTurnRunByItemId.delete(itemId);
      }
    }
  }

  /** Whether the provider has been handed `itemId` and has not yet said what became of it. */
  isHanded(itemId: QueueItemId): boolean {
    return this.#handed.has(itemId);
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

  // The withdraw's answer, or `timed_out` once the deadline passes first.
  async #withinWithdrawDeadline<T>(withdrawing: Promise<T>): Promise<T | "timed_out"> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timed_out">((resolve) => {
      timer = setTimeout(() => {
        resolve("timed_out");
      }, WITHDRAW_DEADLINE_MS);
      timer.unref();
    });
    try {
      return await Promise.race([withdrawing, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  // A handed message Claude Code did not give back: whether it reaches the agent is unknown, so it
  // reads not delivered and can be sent again.
  async #settleUnreturned(item: QueueItemRecord, what: string): Promise<void> {
    this.#handed.delete(item.id);
    this.#deps.writeServiceLog(`run queue: the withdraw of message ${item.id} ${what}`);
    if (this.#deps.items.get(item.id)?.state === "queued") {
      await this.#deps.recorder.recordOutcome(
        item,
        { to: "not_delivered", reason: "failed" },
        this.#deps.now(),
      );
    }
  }

  // A hand that failed: the message was not delivered, unless its run ended first, when it waits
  // for the next run with the run's other messages.
  async #settleFailedHand(item: QueueItemRecord, runId: RunId, error: unknown): Promise<void> {
    this.#handed.delete(item.id);
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
