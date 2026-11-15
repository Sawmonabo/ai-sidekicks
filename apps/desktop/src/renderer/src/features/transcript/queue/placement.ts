// Where the person's messages stand in the log the transcript derives. A message waits as one of
// the transcript's last rows until the agent takes it, the agent's new rows landing above it; once
// taken it stands where the agent took it, at its admission, and the reply follows under it. A
// message sent from this window is drawn under its send's own key from the press on, so the row
// the press drew is the row that settles, and a send that failed leaves one line where its row
// stood and nothing of the message. A message the service hands back after taking it, a turn too
// long for the context window, leaves the flow the same way. Only the messages this window sent
// and the queue items its queue reading reports move; every other message stands at its place. A
// row keeps its key from its first drawing on: across the reply that ties a send to its item, the
// logged message that ties a waiting item to the log, and a retry that queues it again.
//
// The waiting rows are handed back apart from the log, so a log that grew only at its end reaches
// the transcript's derivation as an appended stretch, and a stretch that names no message, no
// admission and no handed-back turn is placed by appending it, with no pass over the log.

import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";
import type { AgentRunFailedPayload } from "@ai-sidekicks/contracts/run/events";
import type { QueueItemSummary } from "@ai-sidekicks/contracts/run/queue";
import { USER_MESSAGE_EVENT_TYPE } from "@ai-sidekicks/contracts/transcript/operations";

import { readWireString } from "#renderer/lib/wire/strings.js";
import { type ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import {
  type FailedSend,
  type SentMessage,
  type SentMessageEntry,
} from "#renderer/store/session/sent-messages.js";
import { appendedStretchOf } from "../window/row-positions.js";
import { SEND_FAILED_ROW_TYPE } from "../system-messages/kinds.js";

/** A row waiting to be taken: the queue item it is, once known, as the queue reading read it. */
export interface WaitingRow {
  readonly queueItemId: string | undefined;
  /** The item as the queue reading last read it; `undefined` before it has. */
  readonly item: QueueItemSummary | undefined;
}

/** What the queue reading reports that the placement reads. */
export interface PlacedQueue {
  /** The items, in queue order. */
  readonly items: readonly QueueItemSummary[];
  /** Each item a retry queued, to the item it sent again. */
  readonly retriedItemFrom: ReadonlyMap<string, string>;
}

/** The log as the transcript derives it, the rows waiting after it, and what the sends learned. */
export interface PlacedLog {
  /** The log with each message where it stands; no waiting row is among them. */
  readonly events: readonly ProjectedSessionEvent[];
  /** The waiting rows, in the order drawn, after every event of `events`. */
  readonly waitingEvents: readonly ProjectedSessionEvent[];
  /** Each waiting row by its key, in the order drawn. */
  readonly waitingRowByKey: ReadonlyMap<string, WaitingRow>;
  /** The key each log event drawn under a send's key is drawn under, by the event's id. */
  readonly rowKeyByEventId: ReadonlyMap<string, string>;
  /** The sends the service has now reported, by their item or their logged message. */
  readonly reportedKeys: ReadonlySet<string>;
  /** The keys of sent messages no row reads any longer. */
  readonly releasableKeys: ReadonlySet<string>;
}

/**
 * Places one session's messages over its log, holding the events it made so each keeps its
 * identity from one pass to the next and the derivation reads it as the row it already drew.
 */
export class SentMessagePlacement {
  readonly #sessionId: string;
  /** The log's own events this window drew under another key or kind, each copied once. */
  readonly #copies = new WeakMap<ProjectedSessionEvent, ProjectedSessionEvent>();
  /** The events made for rows the log holds no event for, by key, kept while their row stands. */
  #madeEvents = new Map<string, ProjectedSessionEvent>();
  /** The last pass: what it was handed and what it answered, which an appended stretch extends. */
  #last: PlacementPass | undefined;

  /** `sessionId` is the session whose log this places, which every row made here carries. */
  public constructor(sessionId: string) {
    this.#sessionId = sessionId;
  }

  /**
   * The log `events` with the messages placed. `entries` are this window's sends, `queue` what the
   * queue reading reports, and `isTailLive` whether the store's window reaches the log's end, the
   * one place waiting rows stand.
   */
  public place(
    events: readonly ProjectedSessionEvent[],
    entries: readonly SentMessageEntry[],
    queue: PlacedQueue,
    isTailLive: boolean,
  ): PlacedLog {
    const { items, retriedItemFrom } = queue;
    const last = this.#last;
    if (
      last !== undefined &&
      last.entries === entries &&
      last.items === items &&
      last.retriedItemFrom === retriedItemFrom &&
      last.isTailLive === isTailLive
    ) {
      const stretch = events === last.events ? [] : appendedStretchOf(last.events, events);
      if (stretch !== undefined && !stretch.some(movesAMessage)) {
        const placed: PlacedLog =
          stretch.length === 0
            ? last.placed
            : {
                ...last.placed,
                events:
                  last.placed.events === last.events ? events : [...last.placed.events, ...stretch],
                reportedKeys: NO_KEYS,
                releasableKeys: NO_KEYS,
              };
        this.#last = { events, entries, items, retriedItemFrom, isTailLive, placed };
        return placed;
      }
    }
    const placed = this.#placeWhole(events, entries, queue, isTailLive);
    this.#last = { events, entries, items, retriedItemFrom, isTailLive, placed };
    return placed;
  }

  #placeWhole(
    events: readonly ProjectedSessionEvent[],
    entries: readonly SentMessageEntry[],
    queue: PlacedQueue,
    isTailLive: boolean,
  ): PlacedLog {
    const { items, retriedItemFrom } = queue;
    const handedBack = handedBackLinesOf(events);
    if (entries.length === 0 && items.length === 0 && handedBack.size === 0) {
      this.#madeEvents = new Map();
      return nothingPlacedIn(events);
    }
    const itemById = new Map(items.map((item) => [item.id as string, item]));
    const retries = retryChainsOf(retriedItemFrom);
    const sends = tieUnansweredSends(entries, events, items).map((send) => {
      const queueItemId =
        send.queueItemId === undefined ? undefined : retries.newest(send.queueItemId);
      return queueItemId === send.queueItemId ? send : { ...send, queueItemId };
    });
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
    const madeEvents = new Map<string, ProjectedSessionEvent>();
    const eventById = new Map(events.map((event) => [event.id, event]));
    const failedAfter = new Map<string | undefined, ProjectedSessionEvent[]>();
    for (const entry of entries) {
      if (entry.kind === "failed") {
        const anchor =
          entry.afterEventId === undefined ? events[0] : eventById.get(entry.afterEventId);
        const line = this.#madeEvent(
          madeEvents,
          entry.key,
          failedLineEvent(this.#sessionId, entry, anchor),
        );
        failedAfter.set(entry.afterEventId, [...(failedAfter.get(entry.afterEventId) ?? []), line]);
      }
    }

    const placed: ProjectedSessionEvent[] = [...(failedAfter.get(undefined) ?? [])];
    const rowKeyByEventId = new Map<string, string>();
    const takenAt = new Map<string, ProjectedSessionEvent>();
    const waitingByItemId = new Map<string, ProjectedSessionEvent>();
    const loggedItemIds = new Set<string>();
    const drawnFromLogItemIds = new Set<string>();
    const handedBackDrawn = new Set<string>();
    for (const event of events) {
      const sentItemId = queueItemIdOf(event, USER_MESSAGE_EVENT_TYPE);
      const admittedItemId = queueItemIdOf(event, ADMITTED_EVENT_TYPE);
      const handedBackItemId = handedBackItemIdOf(event);
      if (sentItemId !== undefined && isKnown(sentItemId)) {
        loggedItemIds.add(sentItemId);
        // A send of this window's under its key; another window's item under the key its waiting
        // row was drawn under, while the reading reads the item.
        const sendKey =
          sendKeyByItemId.get(sentItemId) ??
          (itemById.has(sentItemId) ? retries.first(sentItemId) : undefined);
        const message = this.#copied(event, sendKey);
        const state = itemById.get(sentItemId)?.state;
        const line = handedBack.get(sentItemId);
        if (line !== undefined) {
          // Handed back: the line stands where the message stood, and the message is out.
          placed.push(this.#copied(line.event, undefined, line.label));
          handedBackDrawn.add(sentItemId);
          continue;
        }
        if (state === "canceled" || state === "superseded") {
          // Taken back before the agent read it: nothing of it reaches the agent or the flow.
          continue;
        }
        if (sendKey !== undefined) {
          rowKeyByEventId.set(event.id, sendKey);
        }
        drawnFromLogItemIds.add(sentItemId);
        if (state === "queued" || state === "notDelivered") {
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

    const reportedKeys = new Set<string>();
    const releasableKeys = new Set<string>();
    const tail: WaitingTailRow[] = [];
    const sentItemIds = new Set<string>();
    sends.forEach((send, pressOrder) => {
      const queueItemId = send.queueItemId;
      if (send.editOf !== undefined) {
        // The edited item's own row is this one until the item that replaced it is read.
        sentItemIds.add(send.editOf);
      }
      if (queueItemId !== undefined) {
        sentItemIds.add(queueItemId);
        const isReportedNow = itemById.has(queueItemId) || loggedItemIds.has(queueItemId);
        if (isReportedNow && send.isReported !== true) {
          reportedKeys.add(send.key);
        }
        const isWaiting = isSendWaiting({
          state: itemById.get(queueItemId)?.state,
          isHandedBack: handedBack.has(queueItemId),
          isTaken: admittedItemIds.has(queueItemId),
          isLogged: loggedItemIds.has(queueItemId),
          isReported: isReportedNow || send.isReported === true,
        });
        // A send no row draws, which the service has reported, is let go.
        if (
          !isWaiting &&
          !drawnFromLogItemIds.has(queueItemId) &&
          (isReportedNow || send.isReported === true)
        ) {
          releasableKeys.add(send.key);
        }
        if (!isWaiting) {
          return;
        }
      }
      if (!isTailLive) {
        return;
      }
      const item = queueItemId === undefined ? undefined : itemById.get(queueItemId);
      const event =
        (queueItemId === undefined ? undefined : waitingByItemId.get(queueItemId)) ??
        this.#madeEvent(
          madeEvents,
          send.key,
          waitingMessageEvent(this.#sessionId, send.key, send.content, send.sentAt),
        );
      const edited = send.editOf === undefined ? undefined : itemById.get(send.editOf);
      tail.push({
        event,
        position: (item ?? edited)?.position,
        pressOrder,
        waitingRow: { queueItemId, item },
      });
    });
    if (isTailLive) {
      for (const item of items) {
        if (sentItemIds.has(item.id) || item.kind !== "message") {
          continue;
        }
        if (item.state !== "queued" && item.state !== "notDelivered") {
          continue;
        }
        const rowKey = retries.first(item.id);
        const event =
          waitingByItemId.get(item.id) ??
          this.#madeEvent(
            madeEvents,
            rowKey,
            waitingMessageEvent(this.#sessionId, rowKey, item.content, item.createdAt),
          );
        tail.push({
          event,
          position: item.position,
          pressOrder: 0,
          waitingRow: { queueItemId: item.id, item },
        });
      }
    }
    tail.sort(compareWaitingTailRows);
    const previousRowByKey = this.#last?.placed.waitingRowByKey;
    const waitingRowByKey = new Map<string, WaitingRow>();
    for (const waiting of tail) {
      const key = waiting.event.id;
      const held = previousRowByKey?.get(key);
      waitingRowByKey.set(
        key,
        held !== undefined &&
          held.queueItemId === waiting.waitingRow.queueItemId &&
          held.item === waiting.waitingRow.item
          ? held
          : waiting.waitingRow,
      );
    }
    this.#madeEvents = madeEvents;
    const waitingEvents = tail.map((waiting) => waiting.event);
    const last = this.#last?.placed;
    return {
      events: placed,
      waitingEvents:
        last !== undefined && sameObjects(last.waitingEvents, waitingEvents)
          ? last.waitingEvents
          : waitingEvents,
      waitingRowByKey:
        last !== undefined && sameEntries(last.waitingRowByKey, waitingRowByKey)
          ? last.waitingRowByKey
          : waitingRowByKey,
      rowKeyByEventId:
        last !== undefined && sameEntries(last.rowKeyByEventId, rowKeyByEventId)
          ? last.rowKeyByEventId
          : rowKeyByEventId,
      reportedKeys: reportedKeys.size === 0 ? NO_KEYS : reportedKeys,
      releasableKeys: releasableKeys.size === 0 ? NO_KEYS : releasableKeys,
    };
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
    if (held !== undefined && held.id === (key ?? event.id)) {
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
   * The event made under `made.id` on the last pass while it still says what `made` says, else
   * `made`, kept for this pass: a waiting row and the failed line under one key are two events.
   */
  #madeEvent(
    madeEvents: Map<string, ProjectedSessionEvent>,
    key: string,
    made: ProjectedSessionEvent,
  ): ProjectedSessionEvent {
    const held = this.#madeEvents.get(key);
    const event = held !== undefined && saysTheSame(held, made) ? held : made;
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

/** What one pass was handed, and what it answered. */
interface PlacementPass {
  readonly events: readonly ProjectedSessionEvent[];
  readonly entries: readonly SentMessageEntry[];
  readonly items: readonly QueueItemSummary[];
  readonly retriedItemFrom: ReadonlyMap<string, string>;
  readonly isTailLive: boolean;
  readonly placed: PlacedLog;
}

/** What a send's item and logged message say of it this pass. */
interface SendStanding {
  readonly state: QueueItemSummary["state"] | undefined;
  readonly isHandedBack: boolean;
  /** The agent's admission of it is in the log. */
  readonly isTaken: boolean;
  /** Its message is in the store's window of the log. */
  readonly isLogged: boolean;
  /** The service reported it, this pass or before. */
  readonly isReported: boolean;
}

/**
 * Whether a send the service answered draws as a waiting row: while its item waits or was not
 * delivered, and, before the reading reads its item, while its message is logged and not taken or
 * the service has reported nothing of it yet. A send reported and then read in no waiting state,
 * or gone from both the reading and the window, never waits again.
 */
function isSendWaiting(standing: SendStanding): boolean {
  if (standing.isHandedBack) {
    return false;
  }
  if (standing.state !== undefined) {
    return standing.state === "queued" || standing.state === "notDelivered";
  }
  if (standing.isTaken) {
    return false;
  }
  return standing.isLogged || !standing.isReported;
}

/** Where a retried item's chain of retries starts and where it now ends. */
interface RetryChains {
  /** The item the first send of `queueItemId`'s words queued: its row's key. */
  readonly first: (queueItemId: string) => string;
  /** The item the newest retry of `queueItemId` queued, or `queueItemId` when none did. */
  readonly newest: (queueItemId: string) => string;
}

/** Each retry's chain, read off what each retried item sent again. */
function retryChainsOf(retriedItemFrom: ReadonlyMap<string, string>): RetryChains {
  const retriedTo = new Map<string, string>();
  for (const [retried, from] of retriedItemFrom) {
    retriedTo.set(from, retried);
  }
  const walk = (queueItemId: string, step: ReadonlyMap<string, string>): string => {
    let reached = queueItemId;
    for (let next = step.get(reached); next !== undefined; next = step.get(reached)) {
      reached = next;
    }
    return reached;
  };
  return {
    first: (queueItemId) => walk(queueItemId, retriedItemFrom),
    newest: (queueItemId) => walk(queueItemId, retriedTo),
  };
}

/** Whether an appended event moves a message: one, its admission, or a turn handed back. */
function movesAMessage(event: ProjectedSessionEvent): boolean {
  return (
    event.kind === USER_MESSAGE_EVENT_TYPE ||
    event.kind === ADMITTED_EVENT_TYPE ||
    handedBackItemIdOf(event) !== undefined
  );
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

/** Whether two made events say the same: one kind, one time, one place and one payload. */
function saysTheSame(held: ProjectedSessionEvent, made: ProjectedSessionEvent): boolean {
  return (
    held.kind === made.kind &&
    held.occurredAt === made.occurredAt &&
    held.sequence === made.sequence &&
    held.cursor === made.cursor &&
    held.payload?.["message"] === made.payload?.["message"] &&
    held.payload?.["label"] === made.payload?.["label"]
  );
}

/** Whether two lists hold the same objects in the same order. */
function sameObjects<TItem>(left: readonly TItem[], right: readonly TItem[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

/** Whether two maps hold the same values under the same keys, in the same order. */
function sameEntries<TValue>(
  left: ReadonlyMap<string, TValue>,
  right: ReadonlyMap<string, TValue>,
): boolean {
  if (left.size !== right.size) {
    return false;
  }
  const rightEntries = [...right];
  return [...left].every(([key, value], index) => {
    const entry = rightEntries[index];
    return entry !== undefined && entry[0] === key && entry[1] === value;
  });
}

/** The log as handed, with nothing placed in it and nothing waiting after it. */
function nothingPlacedIn(events: readonly ProjectedSessionEvent[]): PlacedLog {
  return {
    events,
    waitingEvents: NO_EVENTS,
    waitingRowByKey: NO_WAITING_ROWS,
    rowKeyByEventId: NO_ROW_KEYS,
    reportedKeys: NO_KEYS,
    releasableKeys: NO_KEYS,
  };
}

/** The line a message the service hands back leaves where it stood. */
export const HANDED_BACK_LABEL = "Send failed · Too long for this session's context window";

/**
 * Where a waiting row stands in the log's order: after every event, so a reader that orders rows
 * by their place in the log finds the waiting rows last.
 */
const WAITING_ROW_SEQUENCE = Number.MAX_SAFE_INTEGER;

/** The cursor of a waiting row the log holds no event for yet, read at no place in the log. */
export const WAITING_ROW_CURSOR = "";

/** No event waits. */
const NO_EVENTS: readonly ProjectedSessionEvent[] = [];

/** No row waits. */
const NO_WAITING_ROWS: ReadonlyMap<string, WaitingRow> = new Map();

/** No log event is drawn under another key. */
const NO_ROW_KEYS: ReadonlyMap<string, string> = new Map();

/** No sent message is named. */
const NO_KEYS: ReadonlySet<string> = new Set();

/** The event the log records when the agent takes a queued message. */
const ADMITTED_EVENT_TYPE = "agent.queueItem.admitted" satisfies SessionEventType;

/** The event the log records when a run fails, which names a message it hands back. */
const RUN_FAILED_EVENT_TYPE = "agent.run.failed" satisfies SessionEventType;

/** The queue item an event of `kind` names, or `undefined` for an event of another kind. */
function queueItemIdOf(event: ProjectedSessionEvent, kind: string): string | undefined {
  return event.kind === kind ? readWireString(event.payload?.["queueItemId"]) : undefined;
}

/** A message event for a row the log holds no event for yet: its words and when it was sent. */
function waitingMessageEvent(
  sessionId: string,
  key: string,
  content: string,
  sentAt: string,
): ProjectedSessionEvent {
  return {
    id: key,
    sessionId,
    sequence: WAITING_ROW_SEQUENCE,
    cursor: WAITING_ROW_CURSOR,
    kind: USER_MESSAGE_EVENT_TYPE,
    occurredAt: sentAt,
    payload: { message: content },
  };
}

/**
 * The line a failed send leaves, under the send's key, at the place of `anchor`, the event it
 * stands after, or the log's first event, which it stands before, where it stands first.
 */
function failedLineEvent(
  sessionId: string,
  failed: FailedSend,
  anchor: ProjectedSessionEvent | undefined,
): ProjectedSessionEvent {
  return {
    id: failed.key,
    sessionId,
    sequence: anchor?.sequence ?? 0,
    cursor: anchor?.cursor ?? "",
    kind: SEND_FAILED_ROW_TYPE,
    occurredAt: failed.failedAt,
    payload: { label: failed.label },
  };
}
