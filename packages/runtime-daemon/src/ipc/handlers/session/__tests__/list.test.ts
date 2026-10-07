// `session.list` over the real feed, log and database: a list too big for one message arrives
// whole across the acknowledgment and its pages, each inside the message cap and paced by the
// connection's queue, with a change that lands meanwhile held behind the last page; a change racing
// a new subscription reaches it after its acknowledgment and is never lost between the snapshot
// and the first change; and a feed that can no longer read ends the subscription instead of
// throwing on its own turn.

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import {
  JsonRpcErrorCode,
  MAX_MESSAGE_BYTES,
  jsonUtf8ByteLength,
  type JsonRpcNotification,
} from "@ai-sidekicks/contracts/jsonrpc/message";
import {
  SUBSCRIPTION_END_METHOD,
  SUBSCRIPTION_NOTIFY_METHOD,
  type SubscriptionId,
} from "@ai-sidekicks/contracts/jsonrpc/streaming";
import type {
  SessionListAck,
  SessionListChange,
  SessionListEntry,
} from "@ai-sidekicks/contracts/session/directory";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import {
  crossEventLoopTurn,
  openSessionLog,
  type SessionLog,
} from "../../../../session/directory/__fixtures__/session-log.js";
import { SessionListFeed } from "../../../../session/directory/list-feed.js";
import { MethodRegistryImpl } from "../../../registry.js";
import { StreamingPrimitive } from "../../../streaming-primitive.js";
import { registerSessionList } from "../list.js";

const CHAT = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f10" as SessionId;

type SendFrame = (transportId: number, frame: JsonRpcNotification<unknown>) => void;

let log: SessionLog;

beforeEach(async () => {
  log = await openSessionLog();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await log.scratch.close();
});

/**
 * The registry with `session.list` on it, what reached the wire in order, and the connections'
 * outbound queue, which reads full after each frame while `isQueueFilling` is true.
 */
function serveList(feed: SessionListFeed): {
  readonly registry: MethodRegistryImpl;
  readonly send: Mock<SendFrame>;
  readonly written: unknown[];
  /** Subscribes on `transportId`, writing the ack the way the gateway does, in `.then`. */
  readonly subscribe: (transportId: number) => Promise<SessionListAck>;
  /** Makes every frame fill the queue, so the next page waits for {@link drain}. */
  readonly fillQueueOnEachFrame: () => void;
  /** Drains the queue once, waking what waited; false when nothing waited. */
  readonly drain: () => boolean;
} {
  const registry = new MethodRegistryImpl();
  const written: unknown[] = [];
  let isQueueFilling = false;
  let isFull = false;
  const drainListeners: (() => void)[] = [];
  const send = vi.fn<SendFrame>((transportId, frame) => {
    written.push({ transportId, frame });
    isFull = isQueueFilling;
  });
  registerSessionList(registry, {
    streamingPrimitive: new StreamingPrimitive({ registry, send }),
    outboundQueue: {
      isFull: () => isFull,
      onceDrained: (_transportId, listener) => {
        drainListeners.push(listener);
        return () => {
          drainListeners.splice(drainListeners.indexOf(listener), 1);
        };
      },
    },
    listFeed: feed,
  });
  const subscribe = (transportId: number): Promise<SessionListAck> =>
    registry.dispatch("session.list", {}, { transportId }).then((ack) => {
      written.push({ transportId, ack });
      return ack as SessionListAck;
    });
  return {
    registry,
    send,
    written,
    subscribe,
    fillQueueOnEachFrame: () => {
      isQueueFilling = true;
    },
    drain: () => {
      isFull = false;
      const woken = drainListeners.splice(0);
      for (const listener of woken) listener();
      return woken.length > 0;
    },
  };
}

/** What reached one connection, in order: the acknowledgment, then each change's value. */
function deliveredOn(
  written: readonly unknown[],
  transportId: number,
): { readonly ack: SessionListAck; readonly changes: SessionListChange[] } {
  const items = written.filter(
    (item) => (item as { transportId: number }).transportId === transportId,
  ) as { ack?: SessionListAck; frame?: JsonRpcNotification<{ value: SessionListChange }> }[];
  const [first, ...rest] = items;
  if (first?.ack === undefined) {
    throw new Error(`nothing reached transport ${String(transportId)} ahead of its ack`);
  }
  return {
    ack: first.ack,
    changes: rest.map((item) => {
      if (item.frame?.params === undefined) throw new Error("a second ack on one transport");
      return item.frame.params.value;
    }),
  };
}

/** The entries the acknowledgment and the pages after it carried, in order. */
function listedEntries(delivered: ReturnType<typeof deliveredOn>): SessionListEntry[] {
  return [
    ...delivered.ack.sessions,
    ...delivered.changes.flatMap((change) => (change.kind === "page" ? change.sessions : [])),
  ];
}

describe("session.list sends a list too big for one message across its ack and pages", () => {
  it("delivers each session once, a page per drained queue, and holds a change behind the last", async () => {
    const feed = new SessionListFeed({ reader: log.scratch.reader, eventLog: log.eventLog });
    const served = serveList(feed);
    const seeded = await log.seedWideChats(2_500);
    const renamed = seeded[0];
    if (renamed === undefined) throw new Error("nothing seeded");
    served.fillQueueOnEachFrame();
    await served.subscribe(1);
    await crossEventLoopTurn();

    // Lands while the first page waits for the queue to drain.
    await log.append(renamed, "session.renamed", "session_lifecycle", {
      sessionId: renamed,
      name: "Login fix",
      origin: "user",
    });
    await crossEventLoopTurn();
    let drainCount = 0;
    while (served.drain()) drainCount += 1;

    const delivered = deliveredOn(served.written, 1);
    const pages = delivered.changes.slice(0, -1);
    expect(delivered.ack.isComplete).toBe(false);
    expect(pages.length).toBeGreaterThan(1);
    expect(drainCount).toBe(pages.length - 1);
    expect(
      pages.map((change) => [change.kind, "isComplete" in change && change.isComplete]),
    ).toEqual(pages.map((_page, index) => ["page", index === pages.length - 1]));
    const listed = listedEntries(delivered);
    expect(jsonUtf8ByteLength(listed)).toBeGreaterThan(MAX_MESSAGE_BYTES);
    expect(listed.map((entry) => entry.sessionId).sort()).toEqual([...seeded].sort());
    expect(delivered.changes.at(-1)).toMatchObject({
      kind: "upsert",
      entry: { sessionId: renamed, name: "Login fix" },
    });

    const frameBytes = served.written.map((item) => {
      const { ack, frame } = item as { ack?: SessionListAck; frame?: unknown };
      return jsonUtf8ByteLength(ack === undefined ? frame : { jsonrpc: "2.0", id: 1, result: ack });
    });
    expect(Math.max(...frameBytes)).toBeLessThan(MAX_MESSAGE_BYTES);
    feed.close();
  });

  it("answers an empty list complete in the ack alone", async () => {
    const feed = new SessionListFeed({ reader: log.scratch.reader, eventLog: log.eventLog });
    const served = serveList(feed);
    await served.subscribe(1);
    await crossEventLoopTurn();

    expect(served.written).toStrictEqual([
      { transportId: 1, ack: expect.objectContaining({ sessions: [], isComplete: true }) },
    ]);
    feed.close();
  });
});

describe("session.list orders its changes after the acknowledgment", () => {
  it("delivers a change that lands between the snapshot and the ack after the ack", async () => {
    const feed = new SessionListFeed({ reader: log.scratch.reader, eventLog: log.eventLog });
    const served = serveList(feed);
    await log.createSession(CHAT, "chat");
    await served.subscribe(1);
    await crossEventLoopTurn();

    // The rename commits and its row is read on the next turn, after the second subscription's
    // snapshot is taken.
    await log.append(CHAT, "session.renamed", "session_lifecycle", {
      sessionId: CHAT,
      name: "Login fix",
      origin: "user",
    });
    const ack = await served.subscribe(2);
    await crossEventLoopTurn();
    await crossEventLoopTurn();

    expect(ack.sessions).toMatchObject([{ sessionId: CHAT }]);
    expect(ack.sessions[0]?.name).toBeUndefined();
    const onSecond = served.written.filter(
      (item) => (item as { transportId: number }).transportId === 2,
    );
    expect(onSecond).toMatchObject([
      { ack: { subscriptionId: ack.subscriptionId } },
      {
        frame: {
          method: SUBSCRIPTION_NOTIFY_METHOD,
          params: {
            subscriptionId: ack.subscriptionId,
            value: { kind: "upsert", entry: { sessionId: CHAT, name: "Login fix" }, chatCount: 1 },
          },
        },
      },
    ]);
    feed.close();
  });
});

describe("session.list never puts a refused entry on the wire", () => {
  it("ends each subscription a row the list schema refuses would reach, and throws nowhere", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const feed = new SessionListFeed({ reader: log.scratch.reader, eventLog: log.eventLog });
    const served = serveList(feed);
    await log.createSession(CHAT, "chat");
    const ack = await served.subscribe(1);

    // A name past the wire's bound, which no rename can write.
    await log.scratch.writer.write([
      { sql: "UPDATE sessions SET name = ? WHERE id = ?", bindings: ["n".repeat(300), CHAT] },
    ]);
    feed.refresh([CHAT]);
    await crossEventLoopTurn();
    await crossEventLoopTurn();

    expect(served.written).toMatchObject([
      { ack: { subscriptionId: ack.subscriptionId } },
      {
        frame: {
          method: SUBSCRIPTION_END_METHOD,
          params: { subscriptionId: ack.subscriptionId, reason: "refused" },
        },
      },
    ]);
    expect(consoleError).toHaveBeenCalledOnce();
    feed.close();
  });
});

describe("session.list survives a feed that can no longer read", () => {
  it("ends the subscription refused, after the ack, and throws nowhere", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const feedReader = new Database(log.scratch.databasePath, { readonly: true });
    const feed = new SessionListFeed({ reader: feedReader, eventLog: log.eventLog });
    const served = serveList(feed);
    await log.createSession(CHAT, "chat");
    const ack = await served.subscribe(1);

    feedReader.close();
    feed.refresh([CHAT]);
    await crossEventLoopTurn();
    await crossEventLoopTurn();

    expect(served.written).toMatchObject([
      { ack: { subscriptionId: ack.subscriptionId } },
      {
        frame: {
          method: SUBSCRIPTION_END_METHOD,
          params: {
            subscriptionId: ack.subscriptionId as SubscriptionId,
            reason: "refused",
            error: { code: JsonRpcErrorCode.InternalError },
          },
        },
      },
    ]);
    expect(consoleError).toHaveBeenCalledWith(
      "[session.list] reading a changed session's row failed",
      expect.any(Error),
    );
    feed.close();
  });
});
