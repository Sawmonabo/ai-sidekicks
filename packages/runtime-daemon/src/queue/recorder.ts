// Records each change to a queue in its session's log, its row moving in the same write as its
// `queue_item.*` event, and tells the queue's followers the item as it now stands. A send is one
// write: its row, its `user.message`, its `queue_item.created` and, when it starts a run, the
// `run.queued` and row of that run, so an acknowledged send never exists without its transcript
// row and a refused one leaves nothing.

import type { ChildHandle } from "@ai-sidekicks/contracts/agent/tree";
import { EventEnvelopeVersionSchema } from "@ai-sidekicks/contracts/event/envelope";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { RunQueuedPayload } from "@ai-sidekicks/contracts/run/queued";
import type {
  QueueItemEventPayload,
  QueueItemId,
  RunQueueStreamChange,
  UserMessagePayload,
} from "@ai-sidekicks/contracts/run/queue";
import type { EventCursor } from "@ai-sidekicks/contracts/session/event-cursor";
import { encodeEventCursor } from "@ai-sidekicks/contracts/session/event-cursor";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { DeviceId } from "@ai-sidekicks/contracts/trust-statement";
import { canonicalizeUuid } from "@ai-sidekicks/contracts/uuid-canonical";

import type { WriteStatement } from "../database/statement.js";
import type { DatabaseWriter } from "../database/writer.js";
import {
  SessionEventAppender,
  type SessionEventAppenderDeps,
  type SessionEventDraft,
} from "../events/session/appender.js";
import { insertQueuedRunStatement } from "../session/run/projection.js";
import {
  admitUndeliveredStatement,
  insertQueueItemStatement,
  leaveQueuedStatement,
  noLiveLeadRunStatement,
  placementStatements,
  retargetStatement,
  runLiveStatement,
  currentInterruptedLeadRunStatement,
  sessionTakesMessagesStatement,
  summaryOf,
  type NewQueueItem,
  type QueueItemOutcome,
  type QueueItemReader,
  type QueueItemRecord,
} from "./store.js";

const QUEUE_EVENT_VERSION = EventEnvelopeVersionSchema.parse("1.0");

/**
 * The position among a send's statements, after its own insert, of the guard that its session still
 * takes messages: it is neither closed nor being purged.
 */
export const SEND_SESSION_GUARD_STATEMENT_INDEX = 1;

/**
 * The position of a send's route guard among its write's statements, after the session's: no lead
 * run is live for a send that starts one, the run is still live for a send into it, the run still
 * reads interrupted, the session's current lead run, for a send that continues it, and the item an
 * edit replaces is still waiting.
 */
export const SEND_GUARD_STATEMENT_INDEX = 2;

/**
 * Where one person's send goes: a run it starts, the live run it goes into, the interrupted run it
 * continues, or the place of the waiting item it edits, which goes into that item's run.
 */
type SendRoute =
  | { readonly kind: "new_run"; readonly queued: RunQueuedPayload }
  | { readonly kind: "live_run" }
  | { readonly kind: "interrupted_run" }
  | { readonly kind: "edit"; readonly replaces: QueueItemRecord };

/** One person's send as it is recorded: the new row, its device and where it goes. */
export interface RecordedSend {
  readonly item: NewQueueItem;
  readonly deviceId: DeviceId;
  readonly route: SendRoute;
}

/** Hears each change to one queue: the item as it now stands, and the cursor after its change. */
type QueueChangeListener = (change: RunQueueStreamChange) => void;

/** What the recorder writes and reads through. */
export interface QueueRecorderDeps extends SessionEventAppenderDeps {
  readonly items: QueueItemReader;
  /** The writer the session log appends through, which a change no event records goes through. */
  readonly writer: Pick<DatabaseWriter, "write">;
  /** The session's newest cursor, which a change no event records goes out at. */
  readonly readNewestCursor: (sessionId: SessionId) => EventCursor;
}

/** Writes every queue change with its event and hands each to the queue's followers. */
export class QueueRecorder {
  readonly #appender: SessionEventAppender;
  readonly #items: QueueItemReader;
  readonly #writer: Pick<DatabaseWriter, "write">;
  readonly #readNewestCursor: (sessionId: SessionId) => EventCursor;
  // Each queue's followers, by session and child handle; a queue with none holds no entry.
  readonly #followers = new Map<string, Set<QueueChangeListener>>();

  constructor(deps: QueueRecorderDeps) {
    this.#appender = new SessionEventAppender(deps, QUEUE_EVENT_VERSION);
    this.#items = deps.items;
    this.#writer = deps.writer;
    this.#readNewestCursor = deps.readNewestCursor;
  }

  /** Follows one queue's changes until the returned detach runs. */
  follow(
    sessionId: SessionId,
    childHandle: ChildHandle | undefined,
    listener: QueueChangeListener,
  ): () => void {
    const key = queueKeyOf(sessionId, childHandle);
    const listeners = this.#followers.get(key) ?? new Set<QueueChangeListener>();
    this.#followers.set(key, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && this.#followers.get(key) === listeners) {
        this.#followers.delete(key);
      }
    };
  }

  /**
   * Records `send` in one write and resolves with its row. Throws the write's `WriteRefusedError`
   * at {@link SEND_SESSION_GUARD_STATEMENT_INDEX} when the session no longer takes messages, at
   * {@link SEND_GUARD_STATEMENT_INDEX} when its route's guard no longer holds, and at its insert
   * for a key already spent in the session, writing nothing either way.
   */
  async recordSend(send: RecordedSend): Promise<QueueItemRecord> {
    const { item, route } = send;
    const statements: WriteStatement[] = [
      insertQueueItemStatement(item),
      sessionTakesMessagesStatement(item.sessionId),
    ];
    const precedingEvents: SessionEventDraft[] = [];
    switch (route.kind) {
      case "new_run":
        statements.push(
          noLiveLeadRunStatement(item.sessionId),
          insertQueuedRunStatement(route.queued),
        );
        precedingEvents.push({ type: "run.queued", payload: route.queued });
        break;
      case "live_run":
        statements.push(runLiveStatement(item.targetRunId));
        break;
      case "interrupted_run":
        statements.push(currentInterruptedLeadRunStatement(item.targetRunId));
        break;
      case "edit":
        // An edit waits for the run its old item waited for; once that run ends, the run's next
        // start takes it with the rest.
        statements.push(leaveQueuedStatement(route.replaces.id, { to: "superseded" }, item.now));
        break;
    }
    const created: QueueItemEventPayload<"queued"> = {
      sessionId: item.sessionId,
      queueItemId: item.id,
      state: "queued",
    };
    precedingEvents.push({ type: "queue_item.created", payload: created });
    if (route.kind === "edit") {
      const superseded: QueueItemEventPayload<"superseded"> = {
        sessionId: item.sessionId,
        queueItemId: route.replaces.id,
        state: "superseded",
        replacedByQueueItemId: item.id,
      };
      precedingEvents.push({ type: "queue_item.superseded", payload: superseded });
    }
    const message: UserMessagePayload = {
      sessionId: item.sessionId,
      queueItemId: item.id,
      runId: item.targetRunId,
      actor: send.deviceId,
      deviceId: send.deviceId,
      message: item.body.content,
      ...(item.body.answersQuestionId === undefined
        ? {}
        : { answersQuestionId: item.body.answersQuestionId }),
    };
    // The provider echoes the message under its queue item's id, which folds into this row.
    const receipt = await this.#appender.append("user.message", message, {
      correlationId: item.id,
      transactionalPrelude: statements,
      precedingEvents,
    });
    const cursor = encodeEventCursor(receipt.sequence);
    if (route.kind === "edit") {
      this.#publish(cursor, this.#require(route.replaces.id));
    }
    const recorded = this.#require(item.id);
    this.#publish(cursor, recorded);
    return recorded;
  }

  /**
   * Moves `item` out of `queued` to `outcome` with its event. Throws the write's
   * `WriteRefusedError` when the item has already left `queued`.
   */
  async recordOutcome(
    item: QueueItemRecord,
    outcome: QueueItemOutcome,
    now: string,
  ): Promise<void> {
    const { event, statement } = outcomeDraftOf(item, outcome, now);
    const receipt = await this.#appender.append(event.type, event.payload, {
      transactionalPrelude: [statement],
    });
    this.#publish(encodeEventCursor(receipt.sequence), this.#require(item.id));
  }

  /**
   * Admits `item`, which reads not delivered, into `runId`, the run whose turn took it after all,
   * with its event. Throws the write's `WriteRefusedError` when the item no longer reads not
   * delivered.
   */
  async recordLateAdmission(item: QueueItemRecord, runId: RunId, now: string): Promise<void> {
    const admitted: QueueItemEventPayload<"admitted"> = {
      sessionId: item.sessionId,
      queueItemId: item.id,
      state: "admitted",
      runId,
    };
    const receipt = await this.#appender.append("queue_item.admitted", admitted, {
      transactionalPrelude: [admitUndeliveredStatement(item.id, now)],
    });
    this.#publish(encodeEventCursor(receipt.sequence), this.#require(item.id));
  }

  /** Tells the queue's followers each of `itemIds` as it now stands, after a write another made. */
  publishCommitted(sessionId: SessionId, itemIds: readonly QueueItemId[]): void {
    const cursor = this.#readNewestCursor(sessionId);
    for (const itemId of itemIds) {
      this.#publish(cursor, this.#require(itemId));
    }
  }

  /**
   * Queues the run `queued` for the session's waiting `items`, pointing each at it, in one write.
   * Throws the write's `WriteRefusedError` when a lead run is live or one of them has left
   * `queued`.
   */
  async recordNextRun(
    queued: RunQueuedPayload,
    items: readonly QueueItemRecord[],
    now: string,
  ): Promise<void> {
    const receipt = await this.#appender.append("run.queued", queued, {
      transactionalPrelude: [
        noLiveLeadRunStatement(queued.sessionId),
        insertQueuedRunStatement(queued),
        ...items.map((item) => retargetStatement(item.id, queued.runId, now)),
      ],
    });
    const cursor = encodeEventCursor(receipt.sequence);
    for (const item of items) {
      this.#publish(cursor, this.#require(item.id));
    }
  }

  /**
   * Points each of the waiting `items` at `run` in one write, which no event records and no screen
   * draws: a live run, or the session's current lead run resting interrupted for a continue. Throws
   * the write's `WriteRefusedError` when the run no longer reads so or one of them has left
   * `queued`.
   */
  async recordRetarget(
    run: { readonly runId: RunId; readonly state: "live" | "interrupted" },
    items: readonly QueueItemRecord[],
    now: string,
  ): Promise<void> {
    await this.#writer.write([
      run.state === "live"
        ? runLiveStatement(run.runId)
        : currentInterruptedLeadRunStatement(run.runId),
      ...items.map((item) => retargetStatement(item.id, run.runId, now)),
    ]);
  }

  /**
   * Puts the waiting items `ordered` in that order among the places they hold, in one write, which
   * no event records. Throws the write's `WriteRefusedError` when one of them has left `queued`.
   */
  async recordOrder(
    sessionId: SessionId,
    ordered: readonly QueueItemRecord[],
    now: string,
  ): Promise<void> {
    await this.#writer.write(placementStatements(ordered, now));
    this.publishCommitted(
      sessionId,
      ordered.map((item) => item.id),
    );
  }

  #require(itemId: QueueItemId): QueueItemRecord {
    const item = this.#items.get(itemId);
    if (item === undefined) {
      throw new Error(`Queue item ${itemId} was written but cannot be read back`);
    }
    return item;
  }

  #publish(cursor: EventCursor, item: QueueItemRecord): void {
    const listeners = this.#followers.get(queueKeyOf(item.sessionId, item.childHandle));
    if (listeners === undefined) {
      return;
    }
    const change: RunQueueStreamChange = { cursor, item: summaryOf(item) };
    for (const listener of listeners) {
      listener(change);
    }
  }
}

/** The event and the row move that take `item` out of `queued`, for a write another makes. */
export function outcomeDraftOf(
  item: QueueItemRecord,
  outcome: QueueItemOutcome,
  now: string,
): { readonly event: SessionEventDraft; readonly statement: WriteStatement } {
  const base = { sessionId: item.sessionId, queueItemId: item.id };
  let event: SessionEventDraft;
  switch (outcome.to) {
    case "admitted": {
      const payload: QueueItemEventPayload<"admitted"> = {
        ...base,
        state: "admitted",
        runId: outcome.runId,
      };
      event = { type: "queue_item.admitted", payload };
      break;
    }
    case "canceled": {
      const payload: QueueItemEventPayload<"canceled"> = { ...base, state: "canceled" };
      event = { type: "queue_item.canceled", payload };
      break;
    }
    case "not_delivered": {
      const payload: QueueItemEventPayload<"not_delivered"> = {
        ...base,
        state: "not_delivered",
        notDeliveredReason: outcome.reason,
      };
      event = { type: "queue_item.not_delivered", payload };
      break;
    }
  }
  return { event, statement: leaveQueuedStatement(item.id, outcome, now) };
}

function queueKeyOf(sessionId: SessionId, childHandle: ChildHandle | undefined): string {
  return `${canonicalizeUuid(sessionId)} ${childHandle ?? ""}`;
}
