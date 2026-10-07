// `session.list` over the real feed, log and database: a change racing a new subscription reaches
// it after its acknowledgment and is never lost between the snapshot and the first change, and a
// feed that can no longer read ends the subscription instead of throwing on its own turn.

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import type { JsonRpcNotification } from "@ai-sidekicks/contracts/jsonrpc/message";
import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/message";
import {
  SUBSCRIPTION_END_METHOD,
  SUBSCRIPTION_NOTIFY_METHOD,
  type SubscriptionId,
} from "@ai-sidekicks/contracts/jsonrpc/streaming";
import type { SessionListAck } from "@ai-sidekicks/contracts/session/directory";
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

/** The registry with `session.list` on it, and what reached the wire in order. */
function serveList(feed: SessionListFeed): {
  readonly registry: MethodRegistryImpl;
  readonly send: Mock<SendFrame>;
  readonly written: unknown[];
  /** Subscribes on `transportId`, writing the ack the way the gateway does, in `.then`. */
  readonly subscribe: (transportId: number) => Promise<SessionListAck>;
} {
  const registry = new MethodRegistryImpl();
  const written: unknown[] = [];
  const send = vi.fn<SendFrame>((transportId, frame) => {
    written.push({ transportId, frame });
  });
  registerSessionList(registry, {
    streamingPrimitive: new StreamingPrimitive({ registry, send }),
    listFeed: feed,
  });
  const subscribe = (transportId: number): Promise<SessionListAck> =>
    registry.dispatch("session.list", {}, { transportId }).then((ack) => {
      written.push({ transportId, ack });
      return ack as SessionListAck;
    });
  return { registry, send, written, subscribe };
}

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
