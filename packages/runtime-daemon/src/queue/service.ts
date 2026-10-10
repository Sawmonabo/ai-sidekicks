// The run queue: a person's sends to a session's lead, and the edit, removal and reorder of the
// messages still waiting. A send is written whole before anything acts on it, and goes into the
// lead run that is live or starts the next one. Every decision on a session's waiting messages is
// taken under one lock per session, so a send, a change and a run's end never interleave.
//
// A change to a message Claude Code was handed takes it back with Claude Code's own withdraw first,
// all at once; an edit takes back the message and every one after it and sends them again in order,
// and a reorder takes back every waiting message and sends them in the new order. A message Claude
// Code does not give back reads not delivered and leaves the change; a retry sends it again as a
// new message with its words and files, and it reads superseded. Codex's messages wait in the
// daemon's own hold, where a change acts on them in place. A skill picked for a Codex send is
// resolved against the skills Codex lists, before the session's lock is taken, so only a file Codex
// named reaches it. A closed session takes no message. A send while the session's current lead run
// rests interrupted continues that run; a lead run whose start failed before it ran, such as a turn
// Codex started itself whose run failed to open, leaves the run before it current.
//
// While an interrupt of a run is under way, nothing more is handed to the run, and an end of it
// seen meanwhile waits. Before the interrupt goes, Claude Code gives back what its choice keeps
// from the turn Claude Code would start with it. Its choice for the run's waiting messages, sent
// back to the draft or on as the next turn, is written with the run's end; a run that ended
// before the interrupt could end it has its choice applied to its messages all the same, those its
// end already moved on to another run among them, as long as they still wait.

import path from "node:path";

import type { Database } from "better-sqlite3";

import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import {
  QueueItemIdSchema,
  type QueueItemCancelRequest,
  type QueueItemCancelResponse,
  type QueueItemCreateRequest,
  type QueueItemCreateResponse,
  type QueueItemId,
  type QueueItemListRequest,
  type QueueItemListResponse,
  type QueueReorderRequest,
  type QueuedSkillPick,
  type RunQueueStreamChange,
} from "@ai-sidekicks/contracts/run/queue";
import type { ChildHandle } from "@ai-sidekicks/contracts/agent/tree";
import {
  decodeEventCursor,
  encodeEventCursor,
  type EventCursor,
} from "@ai-sidekicks/contracts/session/event-cursor";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { DeviceId } from "@ai-sidekicks/contracts/trust-statement";
import { canonicalizeUuid } from "@ai-sidekicks/contracts/uuid-canonical";

import type { MemoryGate } from "../admission/memory-gate.js";
import type { ServiceLogWriter } from "../daemon/service-log.js";
import type { WriteStatement } from "../database/statement.js";
import type { DatabaseWriter } from "../database/writer.js";
import type { SessionEventAppenderDeps } from "../events/session/appender.js";
import {
  resolveDriverForSessionOrThrow,
  type SessionDriverDeps,
} from "../ipc/handlers/driver/resolution.js";
import { KeyedLock } from "../keyed-lock.js";
import { describeRejection } from "../rejection.js";
import type { InterruptChoice, InterruptEnd } from "../interventions/service.js";
import type { RunEngine } from "../session/run/engine.js";
import { RunAgentReader } from "../session/run/agent.js";
import { RunStateReader } from "../session/run/read.js";
import { RunNotFoundError } from "../session/run/refusals.js";
import { isTerminalState } from "@ai-sidekicks/contracts/run/state";
import { mintUuidV7 } from "../uuid-v7.js";
import { QueueAdmission } from "./admission.js";
import { QueueDelivery } from "./delivery.js";
import type { ProviderSessions } from "./provider-session.js";
import {
  changeRefused,
  leftQueueRefusal,
  queueItemNotFound,
  skillNotListed,
  unreturnedRefusal,
} from "./refusals.js";
import { outcomeDraftOf, QueueRecorder } from "./recorder.js";
import { QueueRunLifecycle } from "./run-lifecycle.js";
import { QueueSends, refuseClosedSession, type QueueSendMessage } from "./send.js";
import {
  placementStatements,
  QueueItemReader,
  summaryOf,
  type QueueItemBody,
  type QueueItemRecord,
} from "./store.js";
import type { PickedSkill } from "../provider/driver/run-control.js";

const EMPTIED_RUN_DETAIL = "Every message the run was queued for was removed before it started";

/** What the run queue reads, writes and calls. */
export interface RunQueueDeps extends SessionEventAppenderDeps {
  /** The daemon's read-only connection. */
  readonly reader: Database;
  readonly writer: Pick<DatabaseWriter, "write">;
  /** The session's newest cursor, which a change no event records goes out at. */
  readonly readNewestCursor: (sessionId: SessionId) => EventCursor;
  readonly engine: Pick<
    RunEngine,
    "startRun" | "continueRun" | "transition" | "endRunForInterrupt"
  >;
  readonly providerSessions: Pick<
    ProviderSessions,
    "readExecutionPosture" | "open" | "openRunBinding" | "forget"
  >;
  readonly sessions: SessionDriverDeps;
  readonly memoryGate: Pick<MemoryGate, "enqueue" | "weigh">;
  /** Whether a Codex conversation on the session would start its account's service. */
  readonly startsCodexAccountService: (sessionId: SessionId) => Promise<boolean>;
  /**
   * Each skill Codex lists for the session, by its name and the file it loads it from; on a
   * session with no live conversation the read starts the account's service when none runs.
   */
  readonly readCodexSkillFiles: (sessionId: SessionId) => Promise<readonly PickedSkill[]>;
  /** The process id of the session's provider process, or `undefined` while none runs. */
  readonly readProviderProcessId: (sessionId: SessionId) => number | undefined;
  readonly writeServiceLog: ServiceLogWriter;
  /** How long a queued run waits for the memory gate; defaults to the queue's own timeout. */
  readonly deliveryTimeoutMs?: number;
  /** How long a change waits for Claude Code to give its messages back; defaults to the queue's. */
  readonly withdrawDeadlineMs?: number;
}

/**
 * The daemon's one run queue. `recorder` follows a queue's changes, `admission` and `delivery`
 * serve the drivers' reads, Codex's tool boundary and the messages Claude Code replays as taken,
 * and `lifecycle` takes every committed event and each session whose events could not be read.
 */
export class RunQueue {
  readonly recorder: QueueRecorder;
  readonly admission: QueueAdmission;
  readonly delivery: QueueDelivery;
  readonly lifecycle: QueueRunLifecycle;
  readonly #items: QueueItemReader;
  readonly #runs: RunStateReader;
  readonly #sends: QueueSends;
  readonly #sessions: SessionDriverDeps;
  readonly #sessionLock = new KeyedLock<SessionId>(canonicalizeUuid);
  readonly #now: () => string;
  readonly #readNewestCursor: (sessionId: SessionId) => EventCursor;
  readonly #readCodexSkillFiles: RunQueueDeps["readCodexSkillFiles"];
  readonly #engine: RunQueueDeps["engine"];

  constructor(deps: RunQueueDeps) {
    const now = deps.now ?? (() => new Date().toISOString());
    const items = new QueueItemReader(deps.reader);
    const runs = new RunStateReader(deps.reader);
    const agents = new RunAgentReader(deps.reader);
    const readLeadAgent = (sessionId: SessionId) => agents.readLeadAgent(sessionId);
    const sessionLock = this.#sessionLock;
    this.#items = items;
    this.#runs = runs;
    this.#sessions = deps.sessions;
    this.#now = now;
    this.#readNewestCursor = deps.readNewestCursor;
    this.#readCodexSkillFiles = deps.readCodexSkillFiles;
    this.#engine = deps.engine;
    this.recorder = new QueueRecorder({ ...deps, items });
    this.admission = new QueueAdmission({
      items,
      runs,
      recorder: this.recorder,
      engine: deps.engine,
      providerSessions: deps.providerSessions,
      sessions: deps.sessions,
      readLeadAgent,
      memoryGate: deps.memoryGate,
      startsCodexAccountService: deps.startsCodexAccountService,
      readProviderProcessId: deps.readProviderProcessId,
      sessionLock,
      writeServiceLog: deps.writeServiceLog,
      now,
      ...(deps.deliveryTimeoutMs === undefined
        ? {}
        : { deliveryTimeoutMs: deps.deliveryTimeoutMs }),
    });
    const admission = this.admission;
    this.delivery = new QueueDelivery({
      items,
      recorder: this.recorder,
      runs,
      sessions: deps.sessions,
      isOpening: (itemId) => admission.isOpening(itemId),
      sessionLock,
      readProviderProcessId: deps.readProviderProcessId,
      continueInterruptedRun: (sessionId, runId) => {
        void sessionLock
          .run(sessionId, () => {
            this.lifecycle.continueInterruptedRun(sessionId, runId);
            return Promise.resolve();
          })
          .catch((error: unknown) => {
            deps.writeServiceLog(
              `run queue: continuing run ${runId} of session ${sessionId} failed: ` +
                describeRejection(error),
            );
          });
      },
      writeServiceLog: deps.writeServiceLog,
      now,
      ...(deps.withdrawDeadlineMs === undefined
        ? {}
        : { withdrawDeadlineMs: deps.withdrawDeadlineMs }),
    });
    this.lifecycle = new QueueRunLifecycle({
      items,
      providerSessions: deps.providerSessions,
      recorder: this.recorder,
      runs,
      admission,
      delivery: this.delivery,
      memoryGate: deps.memoryGate,
      readLeadAgent,
      sessionLock,
      writeServiceLog: deps.writeServiceLog,
      now,
    });
    this.#sends = new QueueSends({
      items,
      recorder: this.recorder,
      delivery: this.delivery,
      admission,
      lifecycle: this.lifecycle,
      readLeadAgent,
      handOrContinue: (sessionId, runId) => {
        this.#handOrContinue(sessionId, runId);
      },
      now,
    });
  }

  /**
   * Sends one message from `deviceId` to the lead of `to`, else of `sessionId`, and answers it as
   * saved; a send again under the same key answers what the first send saved. `replacesQueueItemId`
   * edits a waiting message, or sends one not delivered again. Refuses a session that is closed
   * (`session.already_closed`) or being purged (`session.change_refused`), an edit of a message the
   * agent has taken (`queue.change_refused`, `already_taken`) or Claude Code did not give back
   * (`not_delivered`), a retry in other words than the failed message's (`not_delivered`), a
   * picked skill Codex does not list (`skill.path_refused`,
   * `not_listed`), a pick whose read waited past the delivery timeout for Codex's service
   * (`driver.timeout`), a send the store cannot keep (`queue.persistence_unavailable`) and one
   * whose session's lead run kept moving under it (`queue.run_changed`), writing nothing.
   */
  async create(
    request: QueueItemCreateRequest,
    deviceId: DeviceId,
  ): Promise<QueueItemCreateResponse> {
    const sessionId = canonicalizeUuid(request.to ?? request.sessionId);
    // Refuses a session this daemon does not hold before anything is read.
    const { driverName } = resolveDriverForSessionOrThrow(this.#sessions, sessionId);
    const saved = this.#items.getByIdempotencyKey(sessionId, request.clientIdempotencyKey);
    if (saved !== undefined) {
      return createdResponseOf(saved);
    }
    refuseClosedSession(this.#items, sessionId);
    // Resolved before the lock: a read that waits at the memory gate never holds the session's
    // writes, which the run ahead of it at the gate needs to start.
    const skills = await this.#resolveSkillPicks(sessionId, driverName, request.skills);
    return this.#sessionLock.run(sessionId, async () => {
      const savedMeanwhile = this.#items.getByIdempotencyKey(
        sessionId,
        request.clientIdempotencyKey,
      );
      if (savedMeanwhile !== undefined) {
        return createdResponseOf(savedMeanwhile);
      }
      const message: QueueSendMessage = {
        itemId: QueueItemIdSchema.parse(mintUuidV7()),
        body: bodyOf(request, skills),
        clientIdempotencyKey: request.clientIdempotencyKey,
      };
      const recorded =
        request.replacesQueueItemId === undefined
          ? await this.#sends.send(sessionId, message, deviceId)
          : await this.#sends.replace(
              sessionId,
              canonicalizeUuid(request.replacesQueueItemId),
              message,
              deviceId,
            );
      return createdResponseOf(recorded);
    });
  }

  /**
   * Holds every hand to the run `choice.runId`, and the settling of an end of it seen meanwhile,
   * while an interrupt of it is under way, until {@link endRunForInterrupt} writes the interrupt's
   * choice or {@link releaseInterrupt} lets the hold go. A run whose end already moved the lead's
   * messages waiting for it on to another run has the choice applied to those still waiting now,
   * before that run can start with them.
   */
  async holdForInterrupt(choice: InterruptChoice): Promise<void> {
    const sessionId = this.#sessionOfRun(choice.runId);
    await this.#sessionLock.run(sessionId, async () => {
      this.delivery.holdForInterrupt(choice.runId);
      const moved = (this.lifecycle.takeMovedLeftovers(choice.runId) ?? []).flatMap((itemId) => {
        const item = this.#items.get(itemId);
        return item?.state === "queued" ? [item] : [];
      });
      if (moved.length > 0) {
        await this.#applyChoiceToWaiting(sessionId, choice, moved);
      }
    });
  }

  /**
   * Takes back, ahead of an interrupt of `choice.runId`, what Claude Code holds that the
   * interrupt's choice keeps from the turn Claude Code would start with it: every message for
   * `returnToDraft`, and every one for `nextTurn` when `deliverFirst` names one that is not the
   * first of them, so the next turn goes in the named order. A message Claude Code had already
   * taken stays the run's, and one it did not give back reads not delivered.
   */
  async withdrawForInterrupt(choice: InterruptChoice): Promise<void> {
    const sessionId = this.#sessionOfRun(choice.runId);
    await this.#sessionLock.run(sessionId, async () => {
      const handed = this.#items
        .listWaitingForRun(choice.runId)
        .filter((item) => item.childHandle === undefined && this.delivery.isHanded(item.id));
      const deliverFirst =
        choice.deliverFirst === undefined ? undefined : canonicalizeUuid(choice.deliverFirst);
      const isReordered =
        choice.pending === "nextTurn" &&
        deliverFirst !== undefined &&
        handed[0] !== undefined &&
        handed[0].id !== deliverFirst;
      if (choice.pending === "returnToDraft" || isReordered) {
        await this.delivery.takeBack(sessionId, handed);
      }
    });
  }

  /**
   * Ends the run `interrupted` with the interrupt's verdict and its choice for the lead's messages
   * waiting for the run, in one write, and lets the interrupt's hold go: `returnToDraft` cancels
   * them, and `nextTurn` puts the one `deliverFirst` names first, ahead of the rest in their order,
   * for the turn that continues the run. A message the provider still holds, which only a
   * `returnToDraft` it applied drops, is left as it is; a starting run's opening never reached the
   * provider and goes with the rest. Resolves `false`, with nothing written and the hold kept for
   * {@link releaseInterrupt}, when the run has ended since the interrupt was accepted.
   */
  async endRunForInterrupt(end: InterruptEnd): Promise<boolean> {
    const sessionId = this.#sessionOfRun(end.runId);
    return this.#sessionLock.run(sessionId, async () => {
      // On the hand chain, so no hand, withdraw or replay moves a message under the write.
      const hasEnded = await this.delivery.runBetweenHands(sessionId, async () => {
        const isStarting = this.#runs.getRun(end.runId)?.state === "starting";
        const isHandedKept = end.pending === "nextTurn" || end.isDegraded;
        const waiting = this.#items
          .listWaitingForRun(end.runId)
          .filter(
            (item) =>
              item.childHandle === undefined &&
              (isStarting || !this.admission.isOpening(item.id)) &&
              !(isHandedKept && this.delivery.isHanded(item.id)),
          );
        const now = this.#now();
        const drafts =
          end.pending === "returnToDraft"
            ? waiting.map((item) => outcomeDraftOf(item, { to: "canceled" }, now))
            : [];
        const places =
          end.pending === "nextTurn" ? placementsOf(waiting, end.deliverFirst, now) : [];
        const isEnded = await this.#engine.endRunForInterrupt(end.runId, end.acceptedRunVersion, {
          statements: [
            ...(end.verdict.statements ?? []),
            ...drafts.map((draft) => draft.statement),
            ...places,
          ],
          precedingEvents: [
            ...(end.verdict.precedingEvents ?? []),
            ...drafts.map((draft) => draft.event),
          ],
        });
        if (isEnded && drafts.length > 0) {
          const itemIds = waiting.map((item) => item.id);
          // No provider takes these messages from the run that ended.
          this.delivery.forget(itemIds);
          this.recorder.publishCommitted(sessionId, itemIds);
        } else if (isEnded && places.length > 0) {
          this.recorder.publishCommitted(
            sessionId,
            waiting.map((item) => item.id),
          );
        }
        return isEnded;
      });
      if (hasEnded) {
        await this.#releaseHold(sessionId, end.runId);
      }
      return hasEnded;
    });
  }

  /**
   * Lets go the hold of an interrupt of `choice.runId` that wrote no end of the run; one whose end
   * was written holds nothing. A run that ended before the interrupt could end it has its choice
   * applied to the lead's messages still waiting for it: `returnToDraft` takes back what Claude
   * Code holds and cancels them, never sending them as a next run, and `nextTurn` puts the one
   * `deliverFirst` names first. A live run is handed what waits for it.
   */
  async releaseInterrupt(choice: InterruptChoice): Promise<void> {
    const sessionId = this.#sessionOfRun(choice.runId);
    await this.#sessionLock.run(sessionId, async () => {
      if (!this.delivery.isHeldForInterrupt(choice.runId)) {
        return;
      }
      try {
        const state = this.#runs.getRun(choice.runId)?.state;
        if (state !== undefined && isTerminalState(state)) {
          const waiting = this.#items
            .listWaitingForRun(choice.runId)
            .filter((item) => item.childHandle === undefined);
          await this.#applyChoiceToWaiting(sessionId, choice, waiting);
        }
      } finally {
        await this.#releaseHold(sessionId, choice.runId);
      }
    });
  }

  /**
   * Reads every session's waiting messages again from the record, once the daemon has started and
   * its recovery has settled the runs it found live: a run they wait for that ended before the
   * restart is ended as at its end, and a queued run is started.
   */
  async recover(): Promise<void> {
    await Promise.all(
      this.#items
        .listSessionsWithUnstartedWaiting()
        .map(async (sessionId) => await this.lifecycle.reconcile(sessionId)),
    );
  }

  /**
   * What a queue's stream replays for a screen returning at `afterCursor`: each item that changed
   * after it, at the cursor of its newest change, and each item still waiting that nothing changed,
   * which a reorder may have moved, at the session's newest cursor; oldest first.
   */
  readChangesAfter(
    sessionId: SessionId,
    childHandle: ChildHandle | undefined,
    afterCursor: EventCursor,
  ): RunQueueStreamChange[] {
    const newestCursor = this.#readNewestCursor(sessionId);
    return this.#items
      .listChangedAfter(canonicalizeUuid(sessionId), childHandle, decodeEventCursor(afterCursor))
      .map(({ item, sequence }) => ({
        sequence: sequence ?? decodeEventCursor(newestCursor),
        change: {
          cursor: sequence === undefined ? newestCursor : encodeEventCursor(sequence),
          item: summaryOf(item),
        },
      }))
      .sort((left, right) => left.sequence - right.sequence)
      .map(({ change }) => change);
  }

  /** A queue, the lead's or a child's, in its order, only the items in `state` when it is given. */
  list(request: QueueItemListRequest): QueueItemListResponse {
    return {
      items: this.#items
        .list(canonicalizeUuid(request.sessionId), request.childHandle, request.state)
        .map(summaryOf),
    };
  }

  /**
   * Removes a waiting message, after which nothing reaches the agent. Refuses an item the queue
   * does not hold (`queue.item_not_found`), one the agent has taken (`queue.change_refused`,
   * `already_taken`) and one Claude Code did not give back, which then reads not delivered
   * (`not_delivered`). Removing the last message of a run that has not started ends that run
   * `failed` in the same write.
   */
  async cancel(request: QueueItemCancelRequest): Promise<QueueItemCancelResponse> {
    const found = this.#items.get(canonicalizeUuid(request.queueItemId));
    if (found === undefined || found.childHandle !== request.childHandle) {
      throw queueItemNotFound(request.queueItemId);
    }
    return this.#sessionLock.run(found.sessionId, async () => {
      // A purge of the session while the removal waited took its rows.
      const item = this.#items.get(found.id);
      if (item === undefined) {
        throw queueItemNotFound(request.queueItemId);
      }
      if (item.state !== "queued") {
        throw leftQueueRefusal(item);
      }
      const withdrawal =
        (await this.delivery.takeBack(item.sessionId, [item])).get(item.id) ?? "taken";
      if (withdrawal !== "returned") {
        throw unreturnedRefusal(item.id, withdrawal);
      }
      const runId = item.targetRunId;
      const isLastOfQueuedRun =
        runId !== undefined &&
        this.#runs.getRun(runId)?.state === "queued" &&
        this.#items.listWaitingForRun(runId).every((waiting) => waiting.id === item.id);
      if (isLastOfQueuedRun) {
        await this.admission.endQueuedRun(
          item.sessionId,
          runId,
          [{ item, outcome: { to: "canceled" } }],
          EMPTIED_RUN_DETAIL,
        );
      } else {
        await this.recorder.recordOutcome(item, { to: "canceled" }, this.#now());
        // A message Claude Code kept no longer holds back the interrupted run's continue.
        if (runId !== undefined && item.childHandle === undefined) {
          this.lifecycle.continueInterruptedRun(item.sessionId, runId);
        }
      }
      return { queueItemId: item.id, state: "canceled" };
    });
  }

  /**
   * Puts a queue's waiting messages in the order `queueItemIds` names and answers them in it.
   * Refuses a list that is not exactly the waiting items (`queue.change_refused`,
   * `order_mismatch`); a message the agent takes meanwhile keeps its place.
   */
  async reorder(request: QueueReorderRequest): Promise<QueueItemListResponse> {
    const sessionId = canonicalizeUuid(request.sessionId);
    const { childHandle } = request;
    return this.#sessionLock.run(sessionId, async () => {
      const waiting = this.#items.list(sessionId, childHandle, "queued");
      const requested = request.queueItemIds.map((id) => canonicalizeUuid(id));
      const waitingIds = new Set(waiting.map((item) => item.id));
      if (requested.length !== waiting.length || !requested.every((id) => waitingIds.has(id))) {
        throw changeRefused(
          "order_mismatch",
          "The new order does not name exactly the waiting messages",
        );
      }
      const withdrawals = await this.delivery.takeBack(sessionId, waiting);
      const movable = waiting.filter((item) => withdrawals.get(item.id) === "returned");
      const movableById = new Map(movable.map((item) => [item.id, item]));
      const ordered = requested.flatMap((id) => movableById.get(id) ?? []);
      try {
        if (ordered.length > 0) {
          await this.recorder.recordOrder(sessionId, ordered, this.#now());
        }
      } finally {
        this.#handLeadRuns(sessionId, movable);
      }
      return { items: this.#items.list(sessionId, childHandle, "queued").map(summaryOf) };
    });
  }

  // Each pick as Codex lists it, matched by name and folder, so Codex is handed its own file; the
  // read follows a start of the session's queued run, and waits at the memory gate when it would
  // start the account's service itself. Claude Code takes a pick as its text alone, so a Claude
  // session keeps none.
  async #resolveSkillPicks(
    sessionId: SessionId,
    driverName: ProviderName,
    picks: readonly QueuedSkillPick[] | undefined,
  ): Promise<readonly PickedSkill[] | undefined> {
    if (driverName !== "codex" || picks === undefined || picks.length === 0) {
      return undefined;
    }
    const listed = await this.admission.readOnCodexService(sessionId, () =>
      this.#readCodexSkillFiles(sessionId),
    );
    return picks.map((pick) => {
      const folderPath = path.resolve(pick.folderPath);
      const file = listed.find(
        (candidate) => candidate.name === pick.name && path.dirname(candidate.path) === folderPath,
      );
      if (file === undefined) {
        throw skillNotListed(pick);
      }
      return file;
    });
  }

  // Hands each lead run among `items` what waits for it, after a change took messages back.
  #handLeadRuns(sessionId: SessionId, items: readonly QueueItemRecord[]): void {
    const runIds = new Set<RunId>();
    for (const item of items) {
      if (item.childHandle === undefined && item.targetRunId !== undefined) {
        runIds.add(item.targetRunId);
      }
    }
    for (const runId of runIds) {
      this.#handOrContinue(sessionId, runId);
    }
  }

  // Hands a live lead run what waits for it, continues an interrupted one with it, or moves it on
  // from a run that ended while Claude Code kept it.
  #handOrContinue(sessionId: SessionId, runId: RunId): void {
    this.delivery.handWaiting(sessionId, runId);
    this.lifecycle.continueInterruptedRun(sessionId, runId);
    this.lifecycle.settleEndedRun(sessionId, runId);
  }

  // Applies an interrupt's choice to `waiting`, lead messages that waited for its run when the run
  // ended before the interrupt could end it. Cancels that leave a queued run they were moved on to
  // with no message to start with end that run, as a removal of its last message does.
  async #applyChoiceToWaiting(
    sessionId: SessionId,
    choice: InterruptChoice,
    waiting: readonly QueueItemRecord[],
  ): Promise<void> {
    if (choice.pending === "nextTurn") {
      // What Claude Code holds goes first in the turn it starts with it.
      const movable = waiting.filter((item) => !this.delivery.isHanded(item.id));
      const ordered = reorderedOf(movable, choice.deliverFirst);
      if (ordered !== movable) {
        await this.recorder.recordOrder(sessionId, ordered, this.#now());
      }
      return;
    }
    const withdrawals = await this.delivery.takeBack(sessionId, waiting);
    const canceled = waiting.filter((item) => withdrawals.get(item.id) === "returned");
    for (const item of canceled) {
      await this.recorder.recordOutcome(item, { to: "canceled" }, this.#now());
    }
    for (const runId of new Set(canceled.flatMap((item) => item.targetRunId ?? []))) {
      if (
        this.#runs.getRun(runId)?.state === "queued" &&
        this.#items.listWaitingForRun(runId).length === 0
      ) {
        await this.admission.endQueuedRun(sessionId, runId, [], EMPTIED_RUN_DETAIL);
      }
    }
  }

  // Ends an interrupt's hold on the run and settles what it held back: an end of the run seen
  // meanwhile, else the messages a live run is handed.
  async #releaseHold(sessionId: SessionId, runId: RunId): Promise<void> {
    this.delivery.releaseInterruptHold(runId);
    await this.lifecycle.settleEndAfterInterrupt(sessionId, runId);
    this.delivery.handWaiting(sessionId, runId);
  }

  #sessionOfRun(runId: RunId): SessionId {
    const run = this.#runs.getRun(runId);
    if (run === undefined) {
      throw new RunNotFoundError(runId);
    }
    return run.sessionId;
  }
}

function bodyOf(
  request: QueueItemCreateRequest,
  skills: readonly PickedSkill[] | undefined,
): QueueItemBody {
  return {
    content: request.content,
    ...(request.attachments === undefined ? {} : { attachments: request.attachments }),
    ...(skills === undefined ? {} : { skills }),
    ...(request.answersQuestionId === undefined
      ? {}
      : { answersQuestionId: request.answersQuestionId }),
    ...(request.outputSpeedForTurn === undefined
      ? {}
      : { outputSpeedForTurn: request.outputSpeedForTurn }),
    ...(request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId }),
  };
}

function createdResponseOf(item: QueueItemRecord): QueueItemCreateResponse {
  return {
    queueItemId: item.id,
    state: item.state,
    createdAt: item.createdAt,
    ...(item.notDeliveredReason === undefined
      ? {}
      : { notDeliveredReason: item.notDeliveredReason }),
  };
}

// `waiting` with the item `deliverFirst` names moved first, the rest in their order; `waiting` as
// it is when it names none of them.
function reorderedOf(
  waiting: readonly QueueItemRecord[],
  deliverFirst: QueueItemId | undefined,
): readonly QueueItemRecord[] {
  const firstId = deliverFirst === undefined ? undefined : canonicalizeUuid(deliverFirst);
  const first = waiting.find((item) => item.id === firstId);
  return first === undefined ? waiting : [first, ...waiting.filter((item) => item !== first)];
}

// The placement statements that put the item `deliverFirst` names first; none when it names none
// of `waiting`.
function placementsOf(
  waiting: readonly QueueItemRecord[],
  deliverFirst: QueueItemId | undefined,
  now: string,
): WriteStatement[] {
  const ordered = reorderedOf(waiting, deliverFirst);
  return ordered === waiting ? [] : placementStatements(ordered, now);
}
