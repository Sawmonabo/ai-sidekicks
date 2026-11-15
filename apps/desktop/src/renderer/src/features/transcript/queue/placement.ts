// Where the person's messages stand in the log the transcript derives. A message waits as one of
// the transcript's last rows until the agent takes it, the agent's new rows landing above it; once
// taken it stands where the agent took it, at its admission, and the reply follows under it. A
// message sent from this window is drawn under its send's own key from the press on, so the row
// the press drew is the row that settles, and a send that failed leaves one line where its row
// stood. Only the messages this window sent and the queue items its queue reading reports move;
// every other message stands at its place in the log.

import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";
import type { QueueItemState, QueueItemSummary } from "@ai-sidekicks/contracts/run/queue";
import { USER_MESSAGE_EVENT_TYPE } from "@ai-sidekicks/contracts/transcript/operations";

import { readWireString } from "#renderer/lib/wire/strings.js";
import { type ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import { type SentMessageEntry } from "#renderer/store/session/sent-messages.js";
import { SEND_FAILED_ROW_TYPE } from "../system-messages/kinds.js";

/** A row waiting to be taken: the queue item it is, once known, and where that item stands. */
export interface WaitingRow {
  readonly queueItemId: string | undefined;
  /** The item's state as the queue reading last read it; `undefined` before it has. */
  readonly state: QueueItemState | undefined;
}

/** The log as the transcript derives it, and which of its rows wait at its end. */
export interface PlacedLog {
  readonly events: readonly ProjectedSessionEvent[];
  /** Each waiting row by its key; every one stands after every event of the log. */
  readonly waitingRowByKey: ReadonlyMap<string, WaitingRow>;
}

/**
 * Places one session's messages over its log, holding the events it made so each keeps its
 * identity from one pass to the next and the derivation reads it as the row it already drew.
 */
export class SentMessagePlacement {
  /** The log's own message events this window sent, each copied once under its send's key. */
  readonly #keyedCopies = new WeakMap<ProjectedSessionEvent, ProjectedSessionEvent>();
  /** The events made for rows the log holds no event for, by key, kept while their row stands. */
  #madeEvents = new Map<string, ProjectedSessionEvent>();

  /**
   * The log `events` with the messages placed. `entries` are this window's sends, `items` the
   * queue reading's items, and `isTailLive` whether the store's window reaches the log's end,
   * the one place waiting rows stand.
   */
  public place(
    events: readonly ProjectedSessionEvent[],
    entries: readonly SentMessageEntry[],
    items: readonly QueueItemSummary[],
    isTailLive: boolean,
  ): PlacedLog {
    if (entries.length === 0 && items.length === 0) {
      this.#madeEvents = new Map();
      return { events, waitingRowByKey: NO_WAITING_ROWS };
    }
    const sendKeyByItemId = new Map<string, string>();
    for (const entry of entries) {
      if (entry.kind === "sent" && entry.queueItemId !== undefined) {
        sendKeyByItemId.set(entry.queueItemId, entry.key);
      }
    }
    const itemById = new Map(items.map((item) => [item.id as string, item]));
    const isKnown = (queueItemId: string): boolean =>
      sendKeyByItemId.has(queueItemId) || itemById.has(queueItemId);
    const admittedItemIds = new Set<string>();
    for (const event of events) {
      const queueItemId = queueItemIdOf(event, ADMITTED_EVENT_TYPE);
      if (queueItemId !== undefined && isKnown(queueItemId)) {
        admittedItemIds.add(queueItemId);
      }
    }
    const failedAfter = new Map<string | undefined, ProjectedSessionEvent[]>();
    const madeEvents = new Map<string, ProjectedSessionEvent>();
    for (const entry of entries) {
      if (entry.kind === "failed") {
        const line = this.#madeEvent(madeEvents, entry.key, () =>
          failedLineEvent(entry.key, entry.label, entry.failedAt),
        );
        failedAfter.set(entry.afterEventId, [...(failedAfter.get(entry.afterEventId) ?? []), line]);
      }
    }

    const placed: ProjectedSessionEvent[] = [...(failedAfter.get(undefined) ?? [])];
    const takenAt = new Map<string, ProjectedSessionEvent>();
    const waitingByItemId = new Map<string, ProjectedSessionEvent>();
    const loggedItemIds = new Set<string>();
    for (const event of events) {
      const sentItemId = queueItemIdOf(event, USER_MESSAGE_EVENT_TYPE);
      const admittedItemId = queueItemIdOf(event, ADMITTED_EVENT_TYPE);
      if (sentItemId !== undefined && isKnown(sentItemId)) {
        loggedItemIds.add(sentItemId);
        const message = this.#keyed(event, sendKeyByItemId.get(sentItemId));
        const state = itemById.get(sentItemId)?.state;
        if (state === "canceled" || state === "superseded") {
          // Taken back before the agent read it: nothing of it reaches the agent or the flow.
        } else if (state === "queued" || state === "notDelivered") {
          waitingByItemId.set(sentItemId, message);
        } else if (admittedItemIds.has(sentItemId)) {
          takenAt.set(sentItemId, message);
        } else if (state === undefined && sendKeyByItemId.has(sentItemId)) {
          // Sent from here and not taken yet, though the reading has not read it.
          waitingByItemId.set(sentItemId, message);
        } else {
          placed.push(message);
        }
      } else {
        const taken = admittedItemId === undefined ? undefined : takenAt.get(admittedItemId);
        if (taken !== undefined) {
          placed.push(taken);
        }
        placed.push(event);
      }
      const lines = failedAfter.get(event.id);
      if (lines !== undefined) {
        placed.push(...lines);
      }
    }

    const waitingRowByKey = new Map<string, WaitingRow>();
    if (isTailLive) {
      const tail: WaitingTailRow[] = [];
      const sentItemIds = new Set<string>();
      entries.forEach((entry, pressOrder) => {
        if (entry.kind !== "sent") {
          return;
        }
        const queueItemId = entry.queueItemId;
        const item = queueItemId === undefined ? undefined : itemById.get(queueItemId);
        const logged = queueItemId === undefined ? undefined : waitingByItemId.get(queueItemId);
        if (queueItemId !== undefined) {
          sentItemIds.add(queueItemId);
          const isTakenBack = item?.state === "canceled" || item?.state === "superseded";
          // A message the log holds is waiting only where the pass above set it aside; one the
          // log does not hold yet waits until its event arrives.
          if (
            isTakenBack ||
            (logged === undefined &&
              (admittedItemIds.has(queueItemId) || loggedItemIds.has(queueItemId)))
          ) {
            return;
          }
        }
        const event =
          logged ??
          this.#madeEvent(madeEvents, entry.key, () =>
            waitingMessageEvent(entry.key, entry.content, entry.sentAt, placed.at(-1)),
          );
        tail.push({ event, position: item?.position, pressOrder });
        waitingRowByKey.set(entry.key, { queueItemId, state: item?.state });
      });
      for (const item of items) {
        if (sentItemIds.has(item.id) || item.kind !== "message") {
          continue;
        }
        if (item.state !== "queued" && item.state !== "notDelivered") {
          continue;
        }
        const event =
          waitingByItemId.get(item.id) ??
          this.#madeEvent(madeEvents, item.id, () =>
            waitingMessageEvent(item.id, item.content, item.createdAt, placed.at(-1)),
          );
        tail.push({ event, position: item.position, pressOrder: 0 });
        waitingRowByKey.set(event.id, { queueItemId: item.id, state: item.state });
      }
      tail.sort(compareWaitingTailRows);
      placed.push(...tail.map((waiting) => waiting.event));
    }
    this.#madeEvents = madeEvents;
    return { events: placed, waitingRowByKey };
  }

  /** `event` under `key`, the same copy on every pass, or `event` itself when it has no key. */
  #keyed(event: ProjectedSessionEvent, key: string | undefined): ProjectedSessionEvent {
    if (key === undefined) {
      return event;
    }
    const held = this.#keyedCopies.get(event);
    if (held !== undefined) {
      return held;
    }
    const copy = { ...event, id: key };
    this.#keyedCopies.set(event, copy);
    return copy;
  }

  /** The event made under `key` on the last pass, or one `make` makes, kept for this pass. */
  #madeEvent(
    madeEvents: Map<string, ProjectedSessionEvent>,
    key: string,
    make: () => ProjectedSessionEvent,
  ): ProjectedSessionEvent {
    const event = this.#madeEvents.get(key) ?? make();
    madeEvents.set(key, event);
    return event;
  }
}

/**
 * One row of the waiting stack before it is ordered: the queue's position where the reading read
 * the item, and the press's order for a send the reading has not.
 */
interface WaitingTailRow {
  readonly event: ProjectedSessionEvent;
  readonly position: number | undefined;
  readonly pressOrder: number;
}

// The queue's order first; a send the reading has not read follows every item it has, in the
// order Send was pressed.
function compareWaitingTailRows(first: WaitingTailRow, second: WaitingTailRow): number {
  if (first.position !== undefined && second.position !== undefined) {
    return first.position - second.position;
  }
  if (first.position !== undefined || second.position !== undefined) {
    return first.position === undefined ? 1 : -1;
  }
  return first.pressOrder - second.pressOrder;
}

/** No row waits. */
const NO_WAITING_ROWS: ReadonlyMap<string, WaitingRow> = new Map();

/** The event the log records when the agent takes a queued message. */
const ADMITTED_EVENT_TYPE = "agent.queueItem.admitted" satisfies SessionEventType;

/** The queue item an event of `kind` names, or `undefined` for an event of another kind. */
function queueItemIdOf(event: ProjectedSessionEvent, kind: string): string | undefined {
  return event.kind === kind ? readWireString(event.payload?.["queueItemId"]) : undefined;
}

/**
 * A message event for a row the log holds no event for yet: its words and when it was sent. It
 * takes the position of the event before it, so a row read by position finds its neighbor's.
 */
function waitingMessageEvent(
  key: string,
  content: string,
  sentAt: string,
  before: ProjectedSessionEvent | undefined,
): ProjectedSessionEvent {
  return {
    id: key,
    sessionId: before?.sessionId ?? "",
    sequence: before?.sequence ?? 0,
    cursor: before?.cursor ?? "",
    kind: USER_MESSAGE_EVENT_TYPE,
    occurredAt: sentAt,
    payload: { message: content },
  };
}

/** The line a failed send leaves, under the send's key. */
function failedLineEvent(key: string, label: string, failedAt: string): ProjectedSessionEvent {
  return {
    id: key,
    sessionId: "",
    sequence: 0,
    cursor: "",
    kind: SEND_FAILED_ROW_TYPE,
    occurredAt: failedAt,
    payload: { label },
  };
}
