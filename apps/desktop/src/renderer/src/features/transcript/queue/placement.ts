// Where the person's messages stand in the log the transcript derives. A message waits as one of
// the transcript's last rows until the agent takes it, the agent's new rows landing above it; once
// taken it stands where the agent took it, at its admission, and the reply follows under it. A
// message sent from this window is drawn under its send's own key from the press on, so the row
// the press drew is the row that settles, and a send that failed leaves one line where its row
// stood. A message the service hands back after taking it, a turn too long for the context window,
// leaves the flow the same way. Only the messages this window sent and the queue items its queue
// reading reports move; every other message stands at its place in the log.

import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";
import type { AgentRunFailedPayload } from "@ai-sidekicks/contracts/run/events";
import type { QueueItemSummary } from "@ai-sidekicks/contracts/run/queue";
import { USER_MESSAGE_EVENT_TYPE } from "@ai-sidekicks/contracts/transcript/operations";

import { readWireString } from "#renderer/lib/wire/strings.js";
import { type ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import { type SentMessage, type SentMessageEntry } from "#renderer/store/session/sent-messages.js";
import { SEND_FAILED_ROW_TYPE } from "../system-messages/kinds.js";

/** A row waiting to be taken: the queue item it is, once known, as the queue reading read it. */
export interface WaitingRow {
  readonly queueItemId: string | undefined;
  /** The item as the queue reading last read it; `undefined` before it has. */
  readonly item: QueueItemSummary | undefined;
}

/** The log as the transcript derives it, which of its rows wait at its end, and what may go. */
export interface PlacedLog {
  readonly events: readonly ProjectedSessionEvent[];
  /** Each waiting row by its key, in the order drawn; every one stands after every event. */
  readonly waitingRowByKey: ReadonlyMap<string, WaitingRow>;
  /** The keys of sent messages no row of the store's window reads any longer. */
  readonly releasableKeys: ReadonlySet<string>;
}

/**
 * Places one session's messages over its log, holding the events it made so each keeps its
 * identity from one pass to the next and the derivation reads it as the row it already drew.
 */
export class SentMessagePlacement {
  /** The log's own events this window drew under another key or kind, each copied once. */
  readonly #copies = new WeakMap<ProjectedSessionEvent, ProjectedSessionEvent>();
  /** The events made for rows the log holds no event for, by key, kept while their row stands. */
  #madeEvents = new Map<string, ProjectedSessionEvent>();
  /** The items of this window's sends whose message the log has held, until the send goes. */
  #loggedSendItemIds = new Set<string>();

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
    const handedBack = handedBackLinesOf(events);
    if (entries.length === 0 && items.length === 0 && handedBack.size === 0) {
      this.#madeEvents = new Map();
      return { events, waitingRowByKey: NO_WAITING_ROWS, releasableKeys: NO_KEYS };
    }
    const itemById = new Map(items.map((item) => [item.id as string, item]));
    const sends = tieUnansweredSends(entries, events, items);
    const sendKeyByItemId = new Map<string, string>();
    for (const send of sends) {
      if (send.queueItemId !== undefined) {
        sendKeyByItemId.set(send.queueItemId, send.key);
      }
    }
    const isKnown = (queueItemId: string): boolean =>
      sendKeyByItemId.has(queueItemId) || itemById.has(queueItemId) || handedBack.has(queueItemId);
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
        const line = this.#madeEvent(madeEvents, entry.key, undefined, () =>
          failedLineEvent(entry.key, entry.label, entry.failedAt),
        );
        failedAfter.set(entry.afterEventId, [...(failedAfter.get(entry.afterEventId) ?? []), line]);
      }
    }

    const placed: ProjectedSessionEvent[] = [...(failedAfter.get(undefined) ?? [])];
    const takenAt = new Map<string, ProjectedSessionEvent>();
    const waitingByItemId = new Map<string, ProjectedSessionEvent>();
    const loggedItemIds = new Set<string>();
    const handedBackDrawn = new Set<string>();
    for (const event of events) {
      const sentItemId = queueItemIdOf(event, USER_MESSAGE_EVENT_TYPE);
      const admittedItemId = queueItemIdOf(event, ADMITTED_EVENT_TYPE);
      const handedBackItemId = handedBackItemIdOf(event);
      if (sentItemId !== undefined && isKnown(sentItemId)) {
        loggedItemIds.add(sentItemId);
        const message = this.#copied(event, sendKeyByItemId.get(sentItemId));
        const state = itemById.get(sentItemId)?.state;
        const line = handedBack.get(sentItemId);
        if (line !== undefined) {
          // Handed back: the line stands where the message stood, and the message is out.
          placed.push(this.#copied(line.event, undefined, line.label));
          handedBackDrawn.add(sentItemId);
        } else if (state === "canceled" || state === "superseded") {
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
      } else if (handedBackItemId !== undefined) {
        const line = handedBack.get(handedBackItemId);
        // A message the window no longer holds leaves its line where the turn ended.
        if (line !== undefined && !handedBackDrawn.has(handedBackItemId)) {
          placed.push(this.#copied(line.event, undefined, line.label));
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

    const releasableKeys = new Set<string>();
    const loggedSendItemIds = new Set<string>();
    const waitingRowByKey = new Map<string, WaitingRow>();
    if (isTailLive) {
      const tail: WaitingTailRow[] = [];
      const sentItemIds = new Set<string>();
      sends.forEach((send, pressOrder) => {
        const queueItemId = send.queueItemId;
        const item = queueItemId === undefined ? undefined : itemById.get(queueItemId);
        const logged = queueItemId === undefined ? undefined : waitingByItemId.get(queueItemId);
        if (send.editOf !== undefined) {
          // The edited item's own row is this one until the item that replaced it is read.
          sentItemIds.add(send.editOf);
        }
        if (queueItemId !== undefined) {
          sentItemIds.add(queueItemId);
          const wasLogged = this.#loggedSendItemIds.has(queueItemId);
          if (wasLogged || loggedItemIds.has(queueItemId)) {
            loggedSendItemIds.add(queueItemId);
          }
          const isTakenBack = item?.state === "canceled" || item?.state === "superseded";
          const isTaken = admittedItemIds.has(queueItemId) || item?.state === "admitted";
          // A send whose row went, or whose taken message has left the store's window, is let go.
          if (isTakenBack || (isTaken && wasLogged && !loggedItemIds.has(queueItemId))) {
            releasableKeys.add(send.key);
          }
          // A message the log holds is waiting only where the pass above set it aside; one the
          // log does not hold yet waits until its event arrives.
          if (
            isTakenBack ||
            handedBack.has(queueItemId) ||
            (logged === undefined &&
              (admittedItemIds.has(queueItemId) || loggedItemIds.has(queueItemId)))
          ) {
            return;
          }
        }
        const event =
          logged ??
          this.#madeEvent(madeEvents, send.key, send.content, () =>
            waitingMessageEvent(send.key, send.content, send.sentAt, placed.at(-1)),
          );
        const edited = send.editOf === undefined ? undefined : itemById.get(send.editOf);
        tail.push({
          event,
          position: (item ?? edited)?.position,
          pressOrder,
          waitingRow: { queueItemId, item },
        });
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
          this.#madeEvent(madeEvents, item.id, item.content, () =>
            waitingMessageEvent(item.id, item.content, item.createdAt, placed.at(-1)),
          );
        tail.push({
          event,
          position: item.position,
          pressOrder: 0,
          waitingRow: { queueItemId: item.id, item },
        });
      }
      tail.sort(compareWaitingTailRows);
      for (const waiting of tail) {
        placed.push(waiting.event);
        waitingRowByKey.set(waiting.event.id, waiting.waitingRow);
      }
    }
    this.#madeEvents = madeEvents;
    if (isTailLive) {
      this.#loggedSendItemIds = loggedSendItemIds;
    }
    return { events: placed, waitingRowByKey, releasableKeys };
  }

  /**
   * `event` under `key`, or drawn as a failed send's line reading `label`, the same copy on every
   * pass; `event` itself when neither is asked.
   */
  #copied(
    event: ProjectedSessionEvent,
    key: string | undefined,
    label?: string,
  ): ProjectedSessionEvent {
    if (key === undefined && label === undefined) {
      return event;
    }
    const held = this.#copies.get(event);
    if (held !== undefined) {
      return held;
    }
    const copy =
      label === undefined
        ? { ...event, id: key ?? event.id }
        : { ...event, kind: SEND_FAILED_ROW_TYPE, payload: { label } };
    this.#copies.set(event, copy);
    return copy;
  }

  /**
   * The event made under `key` on the last pass, while it still says `content`, or one `make`
   * makes, kept for this pass.
   */
  #madeEvent(
    madeEvents: Map<string, ProjectedSessionEvent>,
    key: string,
    content: string | undefined,
    make: () => ProjectedSessionEvent,
  ): ProjectedSessionEvent {
    const held = this.#madeEvents.get(key);
    const event =
      held !== undefined && (content === undefined || held.payload?.["message"] === content)
        ? held
        : make();
    madeEvents.set(key, event);
    return event;
  }
}

/** The item a failed run hands back as too long for the context window, or `undefined`. */
export function handedBackItemIdOf(event: ProjectedSessionEvent): string | undefined {
  if (event.kind !== RUN_FAILED_EVENT_TYPE) {
    return undefined;
  }
  // The event's payload, read as the type the service checked it as when it stored it.
  const cause = (event.payload as Partial<AgentRunFailedPayload> | undefined)?.failureCause;
  return cause?.cause === "contextWindowExceeded" ? cause.returnedMessageId : undefined;
}

/** The event that handed a message back, and the words its line reads. */
interface HandedBackLine {
  readonly event: ProjectedSessionEvent;
  readonly label: string;
}

/** Each message the service handed back, by its item, with the event that handed it back. */
function handedBackLinesOf(events: readonly ProjectedSessionEvent[]): Map<string, HandedBackLine> {
  const lines = new Map<string, HandedBackLine>();
  for (const event of events) {
    const queueItemId = handedBackItemIdOf(event);
    if (queueItemId !== undefined) {
      lines.set(queueItemId, { event, label: HANDED_BACK_LABEL });
    }
  }
  return lines;
}

/**
 * One row of the waiting stack before it is ordered: the queue's position where the reading read
 * the item, and the press's order for a send the reading has not.
 */
interface WaitingTailRow {
  readonly event: ProjectedSessionEvent;
  readonly position: number | undefined;
  readonly pressOrder: number;
  readonly waitingRow: WaitingRow;
}

/**
 * This window's sends, each one the service has not answered tied to the item the log or the
 * reading already shows for it. The log's message and the reading's item carry no send key, so a
 * send is tied to the first item not yet tied that holds its words, in press order; a send whose
 * words no such item holds stays untied until the service answers.
 */
function tieUnansweredSends(
  entries: readonly SentMessageEntry[],
  events: readonly ProjectedSessionEvent[],
  items: readonly QueueItemSummary[],
): readonly SentMessage[] {
  const sends = entries.filter((entry): entry is SentMessage => entry.kind === "sent");
  const unanswered = sends.filter((send) => send.queueItemId === undefined);
  if (unanswered.length === 0) {
    return sends;
  }
  const tiedItemIds = new Set<string>();
  for (const send of sends) {
    if (send.queueItemId !== undefined) {
      tiedItemIds.add(send.queueItemId);
    }
    if (send.editOf !== undefined) {
      tiedItemIds.add(send.editOf);
    }
  }
  const keysByContent = new Map<string, string[]>();
  for (const send of unanswered) {
    keysByContent.set(send.content, [...(keysByContent.get(send.content) ?? []), send.key]);
  }
  const itemIdByKey = new Map<string, string>();
  const tie = (queueItemId: string, content: unknown): void => {
    const keys = typeof content === "string" ? keysByContent.get(content) : undefined;
    const key = keys?.shift();
    if (key !== undefined && !tiedItemIds.has(queueItemId)) {
      itemIdByKey.set(key, queueItemId);
      tiedItemIds.add(queueItemId);
    }
  };
  for (const event of events) {
    const queueItemId = queueItemIdOf(event, USER_MESSAGE_EVENT_TYPE);
    if (queueItemId !== undefined && !tiedItemIds.has(queueItemId)) {
      tie(queueItemId, event.payload?.["message"]);
    }
  }
  for (const item of items) {
    if (item.kind === "message" && item.state !== "superseded" && !tiedItemIds.has(item.id)) {
      tie(item.id, item.content);
    }
  }
  if (itemIdByKey.size === 0) {
    return sends;
  }
  return sends.map((send) => {
    const queueItemId = itemIdByKey.get(send.key);
    return queueItemId === undefined ? send : { ...send, queueItemId };
  });
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

/** The line a message the service hands back leaves where it stood. */
const HANDED_BACK_LABEL = "Send failed · Too long for this session's context window";

/** No row waits. */
const NO_WAITING_ROWS: ReadonlyMap<string, WaitingRow> = new Map();

/** No sent message may go. */
const NO_KEYS: ReadonlySet<string> = new Set();

/** The event the log records when the agent takes a queued message. */
const ADMITTED_EVENT_TYPE = "agent.queueItem.admitted" satisfies SessionEventType;

/** The event the log records when a run fails, which names a message it hands back. */
const RUN_FAILED_EVENT_TYPE = "agent.run.failed" satisfies SessionEventType;

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
