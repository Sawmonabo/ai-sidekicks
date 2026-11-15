// What the feed does with the rows themselves: one cancel, one retry in the row's own words, the
// order the list is kept in, a move and an edit, a sent message's row from the press to the agent
// taking it, and a send that failed or settled never drawn as waiting again.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { USER_MESSAGE_EVENT_TYPE } from "@ai-sidekicks/contracts/transcript/operations";

import { bridgeWrapper } from "#test/helpers/app/frame-fixtures.js";
import { settleScheduledRead } from "#test/helpers/scheduled-read.js";
import type { QueueItemSummary } from "@ai-sidekicks/contracts/run/queue";

import type { ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import { SentMessages } from "#renderer/store/session/sent-messages.js";
import { SEND_FAILED_ROW_TYPE } from "../system-messages/kinds.js";
import { reorderedQueueItemIds } from "./order.js";
import { SentMessagePlacement, type PlacedLog, type PlacedQueue } from "./placement.js";
import type { QueueFeed } from "./reading.js";
import {
  QUEUE_ITEM_A,
  QUEUE_ITEM_B,
  QUEUE_ITEM_ID,
  QUEUED_ROW,
  QueueFeedProbe,
  SESSION_ID,
  openFeed,
  queueFeedBridge,
  queueRow,
} from "./feed.test-support.js";
import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";

describe("a queued item is canceled once", () => {
  it("issues one mutation for two synchronous presses on one row", async () => {
    const { latest, canceledItemIds } = await openFeed();
    const { cancelItem } = latest();
    // Both presses inside one act, which is the frame a person double-pressing
    // produces: the second reads a control the render has not redrawn yet.
    act(() => {
      void cancelItem(QUEUE_ITEM_ID);
      void cancelItem(QUEUE_ITEM_ID);
    });
    expect(canceledItemIds).toStrictEqual([QUEUE_ITEM_ID]);
  });

  it("two rows pressed once each are two mutations", async () => {
    // Without this the case above would pass over a chokepoint that dispatched nothing. The
    // latch is per id.
    const { latest, canceledItemIds } = await openFeed();
    act(() => {
      void latest().cancelItem(QUEUE_ITEM_A);
      void latest().cancelItem(QUEUE_ITEM_B);
    });
    expect(canceledItemIds).toStrictEqual([QUEUE_ITEM_A, QUEUE_ITEM_B]);
  });

  it("takes the row's cancel again once the first has settled", async () => {
    const { latest, canceledItemIds } = await openFeed();
    await act(async () => {
      void latest().cancelItem(QUEUE_ITEM_ID);
      await crossMacrotaskBoundary();
    });
    expect(latest().pendingCancelIds.has(QUEUE_ITEM_ID)).toBe(false);
    act(() => {
      void latest().cancelItem(QUEUE_ITEM_ID);
    });
    expect(canceledItemIds).toStrictEqual([QUEUE_ITEM_ID, QUEUE_ITEM_ID]);
  });
});

describe("a not-delivered item is retried once", () => {
  // Mutations: a fresh key per press queues the message twice; leaving out the replaced id sends a
  // new message beside the failed one, which stays not delivered.
  it("replaces the row's message in its own words, keyed by its id, for two presses", async () => {
    const failed = queueRow(QUEUE_ITEM_ID, "notDelivered", "2026-09-02T09:00:00.000Z");
    const { latest, retryRequests } = await openFeed([failed]);
    act(() => {
      void latest().retryItem(QUEUE_ITEM_ID);
      void latest().retryItem(QUEUE_ITEM_ID);
    });
    expect(retryRequests).toStrictEqual([
      {
        sessionId: SESSION_ID,
        clientIdempotencyKey: QUEUE_ITEM_ID,
        content: "Also run the linter",
        replacesQueueItemId: QUEUE_ITEM_ID,
      },
    ]);
  });
});

describe("the ordering rule holds through the hook", () => {
  it("holds the rule through the hook, over a tail delivery that beat the snapshot", async () => {
    // The race the fold exists for: the tail opens with the snapshot still in flight,
    // so a delivery made before the snapshot lands is one that arrived first.
    const { bridge, clock, queueCalls, deliver } = queueFeedBridge([
      queueRow(QUEUE_ITEM_A, "queued", "2026-09-02T09:00:01.000Z", 0),
      queueRow(QUEUE_ITEM_B, "queued", "2026-09-02T09:00:01.000Z", 1),
    ]);
    let held: QueueFeed | undefined;
    render(
      <QueueFeedProbe
        bridge={bridge}
        sessionId={SESSION_ID}
        queueCalls={queueCalls}
        onFeed={(feed) => (held = feed)}
      />,
      { wrapper: bridgeWrapper(bridge, clock) },
    );
    act(() => {
      deliver(queueRow(QUEUE_ITEM_B, "admitted", "2026-09-02T09:00:02.000Z", 1));
    });
    await settleScheduledRead(clock);
    expect(held?.items.map((item) => item.id)).toStrictEqual([QUEUE_ITEM_A, QUEUE_ITEM_B]);
    expect(held?.items[1]?.state).toBe("admitted");
  });
});

describe("a sent message is a row from the press", () => {
  it("waits outlined at the tail before the service answers, and settles under its key", () => {
    // Mutations: a row drawn only once the log holds the message is missing at the press; a row
    // keyed by the log's event id mounts a second time when the service has it; a waiting row
    // placed by its log position stands above the agent's newer rows.
    const placement = new SentMessagePlacement(SESSION_ID);
    const sentMessages = new SentMessages();
    const sendKey = "send-1";
    const opened = loggedEvent("e1", 1, "session.created", {});
    sentMessages.press({
      key: sendKey,
      content: "Also run the linter",
      sentAt: "2026-09-02T09:00:00.000Z",
    });

    const atPress = placement.place([opened], sentMessages.snapshot(), queueOf([]), true);
    expect(drawnIds(atPress)).toStrictEqual(["e1", sendKey]);
    expect(atPress.waitingRowByKey.get(sendKey)).toStrictEqual({
      queueItemId: undefined,
      item: undefined,
    });
    const pressedRow = atPress.waitingEvents[0];
    expect(pressedRow?.kind).toBe(USER_MESSAGE_EVENT_TYPE);

    // The service has it, and the agent writes above it while it waits.
    sentMessages.settle(sendKey, QUEUE_ITEM_ID);
    const sent = loggedEvent("e2", 2, USER_MESSAGE_EVENT_TYPE, {
      queueItemId: QUEUE_ITEM_ID,
      message: "Also run the linter",
    });
    const agentOutput = loggedEvent("e3", 3, "agent.output.delta", {});
    const waiting = placement.place(
      [opened, sent, agentOutput],
      sentMessages.snapshot(),
      queueOf([QUEUED_ROW]),
      true,
    );
    expect(drawnIds(waiting)).toStrictEqual(["e1", "e3", sendKey]);
    expect(waiting.waitingRowByKey.get(sendKey)).toStrictEqual({
      queueItemId: QUEUE_ITEM_ID,
      item: QUEUED_ROW,
    });

    // Taken: it stands where the agent took it, no longer waiting, under the same key.
    const admitted = loggedEvent("e4", 4, "agent.queueItem.admitted", {
      queueItemId: QUEUE_ITEM_ID,
    });
    const taken = placement.place(
      [opened, sent, agentOutput, admitted],
      sentMessages.snapshot(),
      queueOf([queueRow(QUEUE_ITEM_ID, "admitted", "2026-09-02T09:00:03.000Z")]),
      true,
    );
    expect(drawnIds(taken)).toStrictEqual(["e1", "e3", sendKey, "e4"]);
    expect(taken.waitingRowByKey.size).toBe(0);
  });
});

describe("a waiting row moves and is edited in its place", () => {
  it("sends the queue's whole new order, and an edit keeps the row's key and place", async () => {
    // Mutations: a move that names only the rows drawn is refused by the service; an edit drawn
    // under its new item's id mounts a second row; an edit sorted as a fresh send drops to the end.
    const third = "3c4d5e6f-7081-4293-a4b5-b6c7d8e9f0a1";
    const queued = [
      queueRow(QUEUE_ITEM_A, "queued", "2026-09-02T09:00:01.000Z", 0),
      queueRow(QUEUE_ITEM_B, "queued", "2026-09-02T09:00:01.000Z", 1),
      queueRow(third, "queued", "2026-09-02T09:00:01.000Z", 2),
    ];
    const { latest, reorderRequests } = await openFeed(queued);
    await act(async () => {
      await latest().reorderItems(
        reorderedQueueItemIds(latest().items, third, { before: QUEUE_ITEM_A }),
      );
    });
    expect(reorderRequests).toStrictEqual([
      { sessionId: SESSION_ID, queueItemIds: [third, QUEUE_ITEM_A, QUEUE_ITEM_B] },
    ]);

    const placement = new SentMessagePlacement(SESSION_ID);
    const sentMessages = new SentMessages();
    const rowKey = "send-1";
    sentMessages.press({ key: rowKey, content: "Also run the linter", sentAt: AT });
    sentMessages.settle(rowKey, QUEUE_ITEM_A);
    sentMessages.edit(rowKey, "Run the linter first", AT, QUEUE_ITEM_A);
    const editing = placement.place([], sentMessages.snapshot(), queueOf(queued.slice(0, 2)), true);
    expect(drawnIds(editing)).toStrictEqual([rowKey, QUEUE_ITEM_B]);
    expect(editing.waitingEvents[0]?.payload).toStrictEqual({ message: "Run the linter first" });

    // The service answers with the item that replaced it, which takes the old one's place.
    const replacement = "4d5e6f70-8192-43a4-b5c6-c7d8e9f0a1b2";
    sentMessages.settle(rowKey, replacement);
    const replaced = placement.place(
      [],
      sentMessages.snapshot(),
      queueOf([
        queueRow(QUEUE_ITEM_A, "superseded", "2026-09-02T09:00:02.000Z", 0),
        queueRow(replacement, "queued", "2026-09-02T09:00:02.000Z", 0),
        queued[1] ?? QUEUED_ROW,
      ]),
      true,
    );
    expect(drawnIds(replaced)).toStrictEqual([rowKey, QUEUE_ITEM_B]);
    expect(replaced.waitingRowByKey.get(rowKey)?.queueItemId).toBe(replacement);
  });
});

describe("one row per message", () => {
  it("draws the log's message under the send's key before the service answers", () => {
    // Mutation: a log row the reply has not tied to the send draws beside the waiting row.
    const placement = new SentMessagePlacement(SESSION_ID);
    const sentMessages = new SentMessages();
    const sendKey = "send-1";
    sentMessages.press({ key: sendKey, content: "Also run the linter", sentAt: AT });
    const sent = loggedEvent("e1", 1, USER_MESSAGE_EVENT_TYPE, {
      queueItemId: QUEUE_ITEM_ID,
      message: "Also run the linter",
    });
    const placed = placement.place([sent], sentMessages.snapshot(), queueOf([QUEUED_ROW]), true);
    expect(drawnIds(placed)).toStrictEqual([sendKey]);
    expect(placed.waitingRowByKey.get(sendKey)?.queueItemId).toBe(QUEUE_ITEM_ID);
  });
});

describe("a send that failed or settled never draws as a waiting message again", () => {
  it("draws only the failed line for a failed send, and no waiting row once a settled one's events go", () => {
    // Mutations: the failed line taking the event the send's waiting row was drawn as draws the
    // message as delivered; a settled send with no queue state to read is drawn at the tail again
    // once the store's window lets its events go.
    const placement = new SentMessagePlacement(SESSION_ID);
    const sentMessages = new SentMessages();
    const opened = loggedEvent("e1", 1, "session.created", {});
    sentMessages.press({ key: "send-1", content: "Also run the linter", sentAt: AT });
    // A pass between the press and the failure, which draws the send as waiting.
    placement.place([opened], sentMessages.snapshot(), queueOf([]), true);
    sentMessages.fail({
      key: "send-1",
      label: "Send failed · Not connected",
      failedAt: AT,
      afterEventId: "e1",
    });
    const failed = placement.place([opened], sentMessages.snapshot(), queueOf([]), true);
    expect([...failed.events, ...failed.waitingEvents].map((event) => event.kind)).toStrictEqual([
      "session.created",
      SEND_FAILED_ROW_TYPE,
    ]);
    expect(drawnIds(failed)).toStrictEqual(["e1", "send-1"]);
    expect(failed.events[1]?.payload).toStrictEqual({ label: "Send failed · Not connected" });

    // A second send the agent takes, whose item the queue reading never reads.
    sentMessages.press({ key: "send-2", content: "Then the tests", sentAt: AT });
    sentMessages.settle("send-2", QUEUE_ITEM_ID);
    const sent = loggedEvent("e2", 2, USER_MESSAGE_EVENT_TYPE, {
      queueItemId: QUEUE_ITEM_ID,
      message: "Then the tests",
    });
    const admitted = loggedEvent("e3", 3, "agent.queueItem.admitted", {
      queueItemId: QUEUE_ITEM_ID,
    });
    const taken = placement.place(
      [opened, sent, admitted],
      sentMessages.snapshot(),
      queueOf([]),
      true,
    );
    expect(taken.waitingRowByKey.size).toBe(0);
    sentMessages.noteReported(taken.reportedKeys);
    // The store's window lets the turn's events go.
    const later = loggedEvent("e9", 9, "agent.output.delta", {});
    const released = placement.place([later], sentMessages.snapshot(), queueOf([]), true);
    expect(drawnIds(released)).toStrictEqual(["e9"]);
    expect(released.releasableKeys).toStrictEqual(new Set(["send-2"]));
  });
});

/** When the cases' messages were sent. */
const AT = "2026-09-02T09:00:00.000Z";

/** The queue reading as the placement reads it, with no retry. */
function queueOf(items: readonly QueueItemSummary[]): PlacedQueue {
  return { items, retriedItemFrom: new Map() };
}

/** The ids of the rows a placement draws, in drawn order: the log's, then the waiting rows. */
function drawnIds(placed: PlacedLog): readonly string[] {
  return [...placed.events, ...placed.waitingEvents].map((event) => event.id);
}

/** One event of the session's log, as the store holds it. */
function loggedEvent(
  id: string,
  sequence: number,
  kind: string,
  payload: Readonly<Record<string, unknown>>,
): ProjectedSessionEvent {
  return {
    id,
    sessionId: SESSION_ID,
    sequence,
    cursor: String(sequence),
    kind,
    occurredAt: "2026-09-02T09:00:00.000Z",
    payload,
  };
}
