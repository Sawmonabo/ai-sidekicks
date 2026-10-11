// The run queue: a person's sends to a session's lead, and the edit, removal and reorder of the
// messages still waiting. A send is written whole before anything acts on it, and goes into the
// lead run that is live or starts the next one. Every decision on a session's waiting messages is
// taken under one lock per session, so a send, a change and a run's end never interleave.
//
// A change to a message Claude Code was handed takes it back with Claude Code's own withdraw
// first; an edit takes back the message and every one after it and sends them again in order, and
// a reorder takes back every waiting message and sends them in the new order. A message Claude
// Code does not give back reads not delivered and leaves the change. Codex's messages wait in the
// daemon's own hold, where a change acts on them in place. A skill picked for a Codex send is
// resolved against the skills Codex lists, so only a file Codex named reaches it.

import path from "node:path";

import type { Database } from "better-sqlite3";

import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/error-code";
import type { PickedSkill } from "@ai-sidekicks/contracts/provider/driver/intervention";
import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";
import { RunIdSchema, type RunId } from "@ai-sidekicks/contracts/run/id";
import {
  QUEUE_CHANGE_REFUSED_CODE,
  QUEUE_ITEM_NOT_FOUND_CODE,
  QUEUE_PERSISTENCE_UNAVAILABLE_CODE,
  QueueItemIdSchema,
  type QueueChangeRefusedDetails,
  type QueueChangeRefusedReason,
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
import {
  SKILL_PATH_REFUSED_CODE,
  type SkillPathRefusedDetails,
} from "@ai-sidekicks/contracts/skill";
import { canonicalizeUuid } from "@ai-sidekicks/contracts/uuid-canonical";

import type { MemoryGate } from "../admission/memory-gate.js";
import type { ServiceLogWriter } from "../daemon/service-log.js";
import { WriteRefusedError, type DatabaseWriter } from "../database/writer.js";
import type { SessionEventAppenderDeps } from "../events/session/appender.js";
import { DaemonDomainError } from "../ipc/domain-error.js";
import {
  resolveDriverForSessionOrThrow,
  type SessionDriverDeps,
} from "../ipc/handlers/driver/resolution.js";
import { KeyedLock } from "../keyed-lock.js";
import type { RunEngine } from "../session/run/engine.js";
import { RunAgentReader } from "../session/run/agent.js";
import { RunStateReader } from "../session/run/read.js";
import { mintUuidV7 } from "../uuid-v7.js";
import { QueueAdmission } from "./admission.js";
import { QueueDelivery, type QueueWithdrawal } from "./delivery.js";
import type { ProviderSessions } from "./provider-session.js";
import { QueueRecorder, SEND_GUARD_STATEMENT_INDEX, type RecordedSend } from "./recorder.js";
import { QueueRunLifecycle } from "./run-lifecycle.js";
import { QueueItemReader, summaryOf, type QueueItemBody, type QueueItemRecord } from "./store.js";

// Reads and writes of a send before a run that keeps moving under it is refused.
const SEND_ATTEMPTS = 3;

const EMPTIED_RUN_DETAIL = "Every message the run was queued for was removed before it started";

/** What the run queue reads, writes and calls. */
export interface RunQueueDeps extends SessionEventAppenderDeps {
  /** The daemon's read-only connection. */
  readonly reader: Database;
  readonly writer: Pick<DatabaseWriter, "write">;
  /** The session's newest cursor, which a change no event records goes out at. */
  readonly readNewestCursor: (sessionId: SessionId) => EventCursor;
  readonly engine: Pick<RunEngine, "startRun" | "transition">;
  readonly providerSessions: Pick<
    ProviderSessions,
    "readExecutionPosture" | "open" | "openRunBinding"
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
  readonly #agents: RunAgentReader;
  readonly #sessions: SessionDriverDeps;
  readonly #sessionLock = new KeyedLock<SessionId>(canonicalizeUuid);
  readonly #now: () => string;
  readonly #readNewestCursor: (sessionId: SessionId) => EventCursor;
  readonly #readCodexSkillFiles: RunQueueDeps["readCodexSkillFiles"];

  constructor(deps: RunQueueDeps) {
    const now = deps.now ?? (() => new Date().toISOString());
    const items = new QueueItemReader(deps.reader);
    const runs = new RunStateReader(deps.reader);
    const agents = new RunAgentReader(deps.reader);
    const readLeadAgent = (sessionId: SessionId) => agents.readLeadAgent(sessionId);
    const sessionLock = this.#sessionLock;
    this.#items = items;
    this.#runs = runs;
    this.#agents = agents;
    this.#sessions = deps.sessions;
    this.#now = now;
    this.#readNewestCursor = deps.readNewestCursor;
    this.#readCodexSkillFiles = deps.readCodexSkillFiles;
    this.recorder = new QueueRecorder({ ...deps, items });
    this.admission = new QueueAdmission({
      items,
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
      writeServiceLog: deps.writeServiceLog,
      now,
    });
    this.lifecycle = new QueueRunLifecycle({
      items,
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
  }

  /**
   * Sends one message from `deviceId` to the lead of `to`, else of `sessionId`, and answers it as
   * saved; a retry under the same key answers what the first send saved. Refuses an edit of a
   * message the agent has taken (`queue.change_refused`, `already_taken`) or Claude Code did not
   * give back (`not_delivered`), a picked skill Codex does not list
   * (`skill.path_refused`, `not_listed`), and a send the store cannot keep
   * (`queue.persistence_unavailable`), writing nothing.
   */
  async create(
    request: QueueItemCreateRequest,
    deviceId: DeviceId,
  ): Promise<QueueItemCreateResponse> {
    const sessionId = canonicalizeUuid(request.to ?? request.sessionId);
    // Refuses a session this daemon does not hold before anything is read.
    const { driverName } = resolveDriverForSessionOrThrow(this.#sessions, sessionId);
    return this.#sessionLock.run(sessionId, async () => {
      const saved = this.#items.getByIdempotencyKey(sessionId, request.clientIdempotencyKey);
      if (saved !== undefined) {
        return createdResponseOf(saved);
      }
      const body = bodyOf(
        request,
        await this.#resolveSkillPicks(sessionId, driverName, request.skills),
      );
      const itemId = QueueItemIdSchema.parse(mintUuidV7());
      const recorded =
        request.replacesQueueItemId === undefined
          ? await this.#send(sessionId, itemId, body, request.clientIdempotencyKey, deviceId)
          : await this.#edit(
              sessionId,
              canonicalizeUuid(request.replacesQueueItemId),
              { itemId, body, clientIdempotencyKey: request.clientIdempotencyKey },
              deviceId,
            );
      return createdResponseOf(recorded);
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
      const item = this.#items.get(found.id);
      if (item === undefined) {
        throw unreturnedRefusal(found.id, "taken");
      }
      const withdrawal = await this.#takeBack(item);
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
      const movable: QueueItemRecord[] = [];
      for (const item of waiting) {
        if ((await this.#takeBack(item)) === "returned") {
          movable.push(item);
        }
      }
      const movableById = new Map(movable.map((item) => [item.id, item]));
      const ordered = requested.flatMap((id) => movableById.get(id) ?? []);
      const positions = movable.map((item) => item.position).sort((left, right) => left - right);
      try {
        if (ordered.length > 0) {
          await this.recorder.recordOrder(sessionId, ordered, positions, this.#now());
        }
      } finally {
        this.#handLeadRuns(sessionId, movable);
      }
      return { items: this.#items.list(sessionId, childHandle, "queued").map(summaryOf) };
    });
  }

  // A new message: into the lead run that is live, or as the opening of the next one.
  async #send(
    sessionId: SessionId,
    itemId: QueueItemId,
    body: QueueItemBody,
    clientIdempotencyKey: string,
    deviceId: DeviceId,
  ): Promise<QueueItemRecord> {
    for (let attempt = 1; ; attempt += 1) {
      const liveRunId = this.#items.readLiveLeadRun(sessionId);
      const runId = liveRunId ?? RunIdSchema.parse(mintUuidV7());
      const send: RecordedSend = {
        item: {
          id: itemId,
          sessionId,
          body,
          targetRunId: runId,
          deviceId,
          clientIdempotencyKey,
          replacesQueueItemId: undefined,
          now: this.#now(),
        },
        deviceId,
        route:
          liveRunId === undefined
            ? {
                kind: "new_run",
                queued: {
                  sessionId,
                  runId,
                  runVersion: 0,
                  newState: "queued",
                  agentId: this.#agents.readLeadAgent(sessionId),
                },
              }
            : { kind: "live_run" },
      };
      let recorded: QueueItemRecord;
      try {
        recorded = await this.#record(send);
      } catch (error) {
        // The lead run ended or another started between the read and the write.
        if (isGuardRefusal(error) && attempt < SEND_ATTEMPTS) {
          continue;
        }
        throw error;
      }
      if (liveRunId === undefined) {
        this.admission.start(sessionId, runId);
      } else {
        this.delivery.acceptSend(recorded, runId);
      }
      return recorded;
    }
  }

  // An edit: the message takes the waiting one's place, which reads `superseded`. Claude Code
  // gives back the old message and every one after it first, and they go again in order after.
  async #edit(
    sessionId: SessionId,
    replacesQueueItemId: QueueItemId,
    message: {
      readonly itemId: QueueItemId;
      readonly body: QueueItemBody;
      readonly clientIdempotencyKey: string;
    },
    deviceId: DeviceId,
  ): Promise<QueueItemRecord> {
    const replaces = this.#items.get(replacesQueueItemId);
    const runId = replaces?.targetRunId;
    if (
      replaces === undefined ||
      runId === undefined ||
      replaces.sessionId !== sessionId ||
      replaces.childHandle !== undefined
    ) {
      throw queueItemNotFound(replacesQueueItemId);
    }
    const withdrawal = await this.#takeBack(replaces);
    if (withdrawal !== "returned") {
      throw unreturnedRefusal(replaces.id, withdrawal);
    }
    try {
      const later = this.#items
        .listWaitingForRun(runId)
        .filter((item) => item.id !== replaces.id && item.position > replaces.position);
      for (const item of later) {
        // One the provider took or kept meanwhile stays out; the rest go again after the edit.
        await this.#takeBack(item);
      }
      return await this.#record({
        item: {
          id: message.itemId,
          sessionId,
          body: message.body,
          targetRunId: runId,
          deviceId,
          clientIdempotencyKey: message.clientIdempotencyKey,
          replacesQueueItemId: replaces.id,
          now: this.#now(),
        },
        deviceId,
        route: { kind: "edit", replaces },
      });
    } catch (error) {
      if (isGuardRefusal(error)) {
        throw changeRefused("already_taken", `Queue item ${replaces.id} has left the queue`);
      }
      throw error;
    } finally {
      this.delivery.handWaiting(sessionId, runId);
    }
  }

  // Writes a send, a store that cannot keep it refused as unavailable.
  async #record(send: RecordedSend): Promise<QueueItemRecord> {
    try {
      return await this.recorder.recordSend(send);
    } catch (error) {
      if (error instanceof WriteRefusedError) {
        throw error;
      }
      throw new DaemonDomainError("The queue could not store the message; nothing was queued", {
        code: QUEUE_PERSISTENCE_UNAVAILABLE_CODE,
        cause: error,
      });
    }
  }

  // Takes `item` back from its provider ahead of a change, and says whether it is still the
  // queue's to change: waiting, not a starting run's opening, and given back by the provider.
  async #takeBack(item: QueueItemRecord): Promise<QueueWithdrawal> {
    if (item.state !== "queued" || this.admission.isOpening(item.id)) {
      return "taken";
    }
    const withdrawal = await this.delivery.withdraw(item);
    if (withdrawal !== "returned") {
      return withdrawal;
    }
    return this.#items.get(item.id)?.state === "queued" ? "returned" : "taken";
  }

  // Each pick as Codex lists it, matched by name and folder, so Codex is handed its own file; the
  // read waits at the memory gate when it starts the account's service. Claude Code takes a pick
  // as its text alone, so a Claude session keeps none.
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
      this.delivery.handWaiting(sessionId, runId);
    }
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
  return { queueItemId: item.id, state: item.state, createdAt: item.createdAt };
}

function isGuardRefusal(error: unknown): boolean {
  return error instanceof WriteRefusedError && error.statementIndex === SEND_GUARD_STATEMENT_INDEX;
}

function changeRefused(reason: QueueChangeRefusedReason, message: string): DaemonDomainError {
  const detail: QueueChangeRefusedDetails = { reason };
  return new DaemonDomainError(message, {
    code: QUEUE_CHANGE_REFUSED_CODE,
    jsonRpcCode: JsonRpcErrorCode.InvalidRequest,
    detail: { ...detail },
  });
}

// The refusal of a change to an item its provider did not give back.
function unreturnedRefusal(
  queueItemId: QueueItemId,
  withdrawal: Exclude<QueueWithdrawal, "returned">,
): DaemonDomainError {
  return withdrawal === "taken"
    ? changeRefused("already_taken", `Queue item ${queueItemId} has been taken by the agent`)
    : changeRefused(
        "not_delivered",
        `Queue item ${queueItemId} was not given back by the provider and reads not delivered`,
      );
}

function skillNotListed(pick: QueuedSkillPick): DaemonDomainError {
  const detail: SkillPathRefusedDetails = { path: pick.folderPath, reason: "not_listed" };
  return new DaemonDomainError(
    `The skill ${pick.name} in ${pick.folderPath} is not one the session's provider lists`,
    { code: SKILL_PATH_REFUSED_CODE, detail: { ...detail } },
  );
}

function queueItemNotFound(queueItemId: QueueItemId): DaemonDomainError {
  return new DaemonDomainError(`Queue item ${queueItemId} is not in this queue`, {
    code: QUEUE_ITEM_NOT_FOUND_CODE,
    jsonRpcCode: JsonRpcErrorCode.InvalidParams,
    detail: { queueItemId },
  });
}
