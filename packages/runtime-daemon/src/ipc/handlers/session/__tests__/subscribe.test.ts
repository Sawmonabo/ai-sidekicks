// `session.subscribe` through the method registry and streaming primitive: changes batch into
// frames after the ack, a slow connection drops instead of waiting, a malformed event cancels the
// subscription, and the upstream detaches with it.

import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import type { AgentId } from "@ai-sidekicks/contracts/agent/definition";
import type {
  SessionStreamChange,
  SessionStreamFrame,
  SessionSubscribeRequest,
  SessionSubscribeResponse,
} from "@ai-sidekicks/contracts/session/methods";
import type { EventCursor, SessionId } from "@ai-sidekicks/contracts/session/id";
import type { JsonRpcNotification } from "@ai-sidekicks/contracts/jsonrpc/message";
import type { SessionEvent } from "@ai-sidekicks/contracts/event/variant-types";
import type {
  SubscriptionId,
  SubscriptionNotifyParams,
} from "@ai-sidekicks/contracts/jsonrpc/streaming";
import { JSONRPC_VERSION, JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/message";
import {
  STREAM_FRAME_MAX_CHANGES,
  SUBSCRIPTION_END_METHOD,
  SUBSCRIPTION_NOTIFY_METHOD,
} from "@ai-sidekicks/contracts/jsonrpc/streaming";

import { MethodRegistryImpl } from "../../../registry.js";
import { StreamingPrimitive } from "../../../streaming-primitive.js";

import {
  registerSessionSubscribe,
  SESSION_STREAM_WINDOW_MS,
  type OutboundQueue,
  type SessionSubscribeDeps,
} from "../subscribe.js";

// The fixtures use real RFC 9562 UUIDs: the streaming primitive parses every event, so an invalid
// UUID would fail that parse for the wrong reason.

const TEST_SESSION_ID = "550e8400-e29b-41d4-a716-446655440000" as SessionId;
const TEST_USER_ID = "660e8400-e29b-41d4-a716-446655440001";

/** A `session.created` `SessionEvent` that passes `SessionEventSchema`. */
function buildSessionCreatedEvent(): SessionEvent {
  return {
    id: "evt-0001",
    sessionId: TEST_SESSION_ID,
    sequence: 0,
    occurredAt: "2026-01-22T19:14:35.000Z",
    category: "session_lifecycle",
    type: "session.created",
    actor: TEST_USER_ID,
    version: "1.0" as SessionEvent["version"],
    payload: {
      sessionId: TEST_SESSION_ID,
      shape: "chat",
      mainAgent: {
        agentId: "44444444-4444-4444-8444-444444444444" as AgentId,
        name: "Implementer",
        binding: {
          driverName: "claude",
          modelId: "claude-sonnet-5",
          providerAccountId: null,
          effort: null,
        },
        ancestry: [],
        createdAt: "2026-01-22T19:14:35.000Z",
      },
    },
  };
}

// The handler batches changes on a timer window, so the `session.subscribe` tests fake
// `setTimeout` / `clearTimeout` and leave `setImmediate` real: the ack barrier releases on
// `setImmediate`, and a faked one would never release it.

/** The primitive's per-connection send, as the tests capture it. */
type SendFrame = (transportId: number, frame: JsonRpcNotification<unknown>) => void;

/** An outbound queue that always has room. */
const ALWAYS_ROOM: OutboundQueue = {
  isFull: () => false,
  onceDrained: () => () => undefined,
};

/** An outbound queue a test fills and drains by hand. */
function controllableOutboundQueue(): {
  readonly queue: OutboundQueue;
  fill(): void;
  drain(): void;
  readonly drainListenerCount: () => number;
} {
  let full = false;
  const drainListeners = new Set<() => void>();
  return {
    queue: {
      isFull: () => full,
      onceDrained: (_transportId, listener) => {
        drainListeners.add(listener);
        return () => {
          drainListeners.delete(listener);
        };
      },
    },
    fill: () => {
      full = true;
    },
    drain: () => {
      full = false;
      const listeners = [...drainListeners];
      drainListeners.clear();
      for (const listener of listeners) listener();
    },
    drainListenerCount: () => drainListeners.size,
  };
}

function changeAt(index: number): SessionStreamChange<SessionEvent> {
  return {
    cursor: `cursor-${String(index)}` as EventCursor,
    event: { ...buildSessionCreatedEvent(), id: `evt-${String(index)}`, sequence: index },
  };
}

/** Crosses the ack barrier's `setImmediate` boundary. */
async function crossAckBarrier(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** The frame each captured `$/subscription/notify` carried, in send order. */
function sentFrames(send: Mock<SendFrame>): SessionStreamFrame<SessionEvent>[] {
  return send.mock.calls.map(([, frame]) => {
    expect(frame.jsonrpc).toBe(JSONRPC_VERSION);
    expect(frame.method).toBe(SUBSCRIPTION_NOTIFY_METHOD);
    return (frame.params as SubscriptionNotifyParams<SessionStreamFrame<SessionEvent>>).value;
  });
}

interface SubscribedStream {
  readonly send: Mock<SendFrame>;
  readonly primitive: StreamingPrimitive;
  readonly subscriptionId: SubscriptionId;
  readonly onChange: (change: SessionStreamChange<SessionEvent>) => void;
}

/** Registers the handler, subscribes on transport 7 and crosses the ack barrier. */
async function subscribeWith(
  outboundQueue: OutboundQueue,
  catchUp: readonly SessionStreamChange<SessionEvent>[] = [],
): Promise<SubscribedStream> {
  const registry = new MethodRegistryImpl();
  const send = vi.fn<SendFrame>();
  const primitive = new StreamingPrimitive({ registry, send });
  const onChangeHolder: { current: ((change: SessionStreamChange<SessionEvent>) => void) | null } =
    { current: null };
  registerSessionSubscribe(registry, {
    streamingPrimitive: primitive,
    outboundQueue,
    subscribeToSession: (_sessionId, _afterCursor, onChange) => {
      onChangeHolder.current = onChange;
      for (const change of catchUp) onChange(change);
      return () => undefined;
    },
  });
  const result = (await registry.dispatch(
    "session.subscribe",
    { sessionId: TEST_SESSION_ID },
    { transportId: 7 },
  )) as SessionSubscribeResponse;
  await crossAckBarrier();
  const onChange = onChangeHolder.current;
  if (onChange === null) throw new Error("unreachable — subscribeToSession ran during dispatch");
  return { send, primitive, subscriptionId: result.subscriptionId, onChange };
}

describe("session.subscribe batches a session's changes into frames", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers `{ subscriptionId }` and passes the session and cursor to the upstream", async () => {
    const registry = new MethodRegistryImpl();
    const send = vi.fn<SendFrame>();
    const primitive = new StreamingPrimitive({ registry, send });
    const subscribeToSession = vi.fn<SessionSubscribeDeps["subscribeToSession"]>(
      () => () => undefined,
    );
    registerSessionSubscribe(registry, {
      streamingPrimitive: primitive,
      outboundQueue: ALWAYS_ROOM,
      subscribeToSession,
    });
    const afterCursor = "cursor-41" as EventCursor;
    const subscribeReq: SessionSubscribeRequest = { sessionId: TEST_SESSION_ID, afterCursor };

    const result = (await registry.dispatch("session.subscribe", subscribeReq, {
      transportId: 42,
    })) as SessionSubscribeResponse;

    expect(result.subscriptionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(subscribeToSession).toHaveBeenCalledWith(
      TEST_SESSION_ID,
      afterCursor,
      expect.any(Function),
    );
    expect(registry.isMutating("session.subscribe")).toBe(false);
  });

  it(
    "sends the changes of one window as one frame " +
      "when the window closes, each with its cursor",
    async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const stream = await subscribeWith(ALWAYS_ROOM);

      stream.onChange(changeAt(1));
      vi.advanceTimersByTime(5);
      stream.onChange(changeAt(2));
      vi.advanceTimersByTime(SESSION_STREAM_WINDOW_MS - 6);
      expect(stream.send).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(sentFrames(stream.send)).toStrictEqual([{ changes: [changeAt(1), changeAt(2)] }]);
      expect(stream.send.mock.calls[0]?.[0]).toBe(7);
      const params = stream.send.mock.calls[0]?.[1].params as SubscriptionNotifyParams<unknown>;
      expect(params.subscriptionId).toBe(stream.subscriptionId);
    },
  );

  it("sends a full frame at once, without waiting for the window", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stream = await subscribeWith(ALWAYS_ROOM);
    const changes = Array.from({ length: STREAM_FRAME_MAX_CHANGES + 1 }, (_, index) =>
      changeAt(index),
    );

    for (const change of changes) stream.onChange(change);

    expect(sentFrames(stream.send)).toStrictEqual([
      { changes: changes.slice(0, STREAM_FRAME_MAX_CHANGES) },
    ]);
    vi.advanceTimersByTime(SESSION_STREAM_WINDOW_MS);
    expect(sentFrames(stream.send)).toStrictEqual([
      { changes: changes.slice(0, STREAM_FRAME_MAX_CHANGES) },
      { changes: changes.slice(STREAM_FRAME_MAX_CHANGES) },
    ]);
  });

  it("writes the ack before any frame of a synchronous catch-up, in order", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const registry = new MethodRegistryImpl();
    const written: string[] = [];
    const send = vi.fn<SendFrame>((_transportId, frame) => {
      const frameValue = (
        frame.params as SubscriptionNotifyParams<SessionStreamFrame<SessionEvent>>
      ).value;
      written.push(`frame:${frameValue.changes.map((change) => change.cursor).join(",")}`);
    });
    const primitive = new StreamingPrimitive({ registry, send });
    const catchUp = Array.from({ length: STREAM_FRAME_MAX_CHANGES + 2 }, (_, index) =>
      changeAt(index),
    );
    registerSessionSubscribe(registry, {
      streamingPrimitive: primitive,
      outboundQueue: ALWAYS_ROOM,
      subscribeToSession: (_sessionId, _afterCursor, onChange) => {
        for (const change of catchUp) onChange(change);
        return () => undefined;
      },
    });

    await registry.dispatch(
      "session.subscribe",
      { sessionId: TEST_SESSION_ID },
      { transportId: 7 },
    );
    written.push("ack");
    await crossAckBarrier();
    vi.advanceTimersByTime(SESSION_STREAM_WINDOW_MS);

    const cursors = (from: number, to: number): string =>
      catchUp
        .slice(from, to)
        .map((change) => change.cursor)
        .join(",");
    expect(written).toStrictEqual([
      "ack",
      `frame:${cursors(0, STREAM_FRAME_MAX_CHANGES)}`,
      `frame:${cursors(STREAM_FRAME_MAX_CHANGES, STREAM_FRAME_MAX_CHANGES + 2)}`,
    ]);
  });
});

describe("session.subscribe never waits for a connection that falls behind", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops the frame that does not fit and marks the next frame that does", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const outbound = controllableOutboundQueue();
    const stream = await subscribeWith(outbound.queue);

    outbound.fill();
    stream.onChange(changeAt(1));
    vi.advanceTimersByTime(SESSION_STREAM_WINDOW_MS);
    expect(stream.send).not.toHaveBeenCalled();

    stream.onChange(changeAt(2));
    outbound.drain();

    expect(sentFrames(stream.send)).toStrictEqual([{ changes: [changeAt(2)], dropped: true }]);
    vi.advanceTimersByTime(SESSION_STREAM_WINDOW_MS);
    expect(stream.send).toHaveBeenCalledTimes(1);
  });

  it(
    "sends one frame with no changes, the drop mark and the newest cursor once a quiet " +
      "connection catches up",
    async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const outbound = controllableOutboundQueue();
      const stream = await subscribeWith(outbound.queue);

      outbound.fill();
      stream.onChange(changeAt(1));
      stream.onChange(changeAt(2));
      vi.advanceTimersByTime(SESSION_STREAM_WINDOW_MS);
      expect(stream.send).not.toHaveBeenCalled();

      outbound.drain();

      expect(sentFrames(stream.send)).toStrictEqual([
        { changes: [], dropped: true, cursor: changeAt(2).cursor },
      ]);
      vi.advanceTimersByTime(SESSION_STREAM_WINDOW_MS);
      expect(stream.send).toHaveBeenCalledTimes(1);
    },
  );

  it("stops listening for room once the subscription is canceled", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const outbound = controllableOutboundQueue();
    const stream = await subscribeWith(outbound.queue);

    outbound.fill();
    stream.onChange(changeAt(1));
    vi.advanceTimersByTime(SESSION_STREAM_WINDOW_MS);
    expect(outbound.drainListenerCount()).toBe(1);

    stream.primitive.cleanupTransport(7);

    expect(outbound.drainListenerCount()).toBe(0);
  });
});

// A frame the primitive refuses throws `StreamingValidationError` from a turn no dispatch
// wrapper covers: the barrier's flush, or the upstream's own turn. The barrier cancels the
// subscription and logs; these tests pin that on both sides of the ack.

describe("session.subscribe survives a malformed frame", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it(
    "catch-up: a malformed event in a catch-up frame ends the subscription refused and sends " +
      "nothing else",
    async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const malformed = { cursor: "cursor-0" as EventCursor, event: {} as SessionEvent };
      const catchUp = [
        malformed,
        ...Array.from({ length: STREAM_FRAME_MAX_CHANGES }, (_, index) => changeAt(index + 1)),
      ];

      const stream = await subscribeWith(ALWAYS_ROOM, catchUp);
      vi.advanceTimersByTime(SESSION_STREAM_WINDOW_MS);

      // The bad event never reaches the client; its stream ends refused instead.
      expect(stream.send.mock.calls).toMatchObject([
        [
          expect.any(Number),
          {
            method: SUBSCRIPTION_END_METHOD,
            params: {
              subscriptionId: stream.subscriptionId,
              reason: "refused",
              // The failure's own sanitized words, not the bare "ended" line.
              error: {
                code: JsonRpcErrorCode.InternalError,
                message: expect.stringContaining("value validation failed"),
              },
            },
          },
        ],
      ]);
      expect(stream.primitive.cancelSubscription(stream.subscriptionId)).toBe(false);
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      const [prefix, err] = consoleErrorSpy.mock.calls[0] ?? [];
      expect(prefix).toContain("[session.subscribe] catch-up event validation/emission failed");
      expect(prefix).toContain(stream.subscriptionId);
      expect((err as Error).name).toBe("StreamingValidationError");
    },
  );

  it("live tail: a malformed event cancels the subscription, never throwing upstream", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stream = await subscribeWith(ALWAYS_ROOM);

    stream.onChange({ cursor: "cursor-0" as EventCursor, event: {} as SessionEvent });
    expect(() => vi.advanceTimersByTime(SESSION_STREAM_WINDOW_MS)).not.toThrow();

    // The bad event never reaches the client; its stream ends refused instead.
    expect(stream.send.mock.calls).toMatchObject([
      [
        expect.any(Number),
        {
          method: SUBSCRIPTION_END_METHOD,
          params: {
            subscriptionId: stream.subscriptionId,
            reason: "refused",
            error: { code: JsonRpcErrorCode.InternalError },
          },
        },
      ],
    ]);
    expect(stream.primitive.cancelSubscription(stream.subscriptionId)).toBe(false);
    const [prefix] = consoleErrorSpy.mock.calls[0] ?? [];
    expect(prefix).toContain("[session.subscribe] live-tail event validation/emission failed");
  });
});

describe("session.subscribe detaches the upstream when the subscription ends", () => {
  async function subscribeCountingDetach(transportId: number): Promise<{
    readonly registry: MethodRegistryImpl;
    readonly primitive: StreamingPrimitive;
    readonly unsubscribe: Mock<() => void>;
    readonly subscriptionId: SubscriptionId;
  }> {
    const registry = new MethodRegistryImpl();
    const send = vi.fn<SendFrame>();
    const primitive = new StreamingPrimitive({ registry, send });
    const unsubscribe = vi.fn<() => void>();
    registerSessionSubscribe(registry, {
      streamingPrimitive: primitive,
      outboundQueue: ALWAYS_ROOM,
      subscribeToSession: () => unsubscribe,
    });
    const result = (await registry.dispatch(
      "session.subscribe",
      { sessionId: TEST_SESSION_ID },
      { transportId },
    )) as SessionSubscribeResponse;
    await crossAckBarrier();
    return { registry, primitive, unsubscribe, subscriptionId: result.subscriptionId };
  }

  it("a `$/subscription/cancel` from the same connection detaches the upstream", async () => {
    const stream = await subscribeCountingDetach(13);
    expect(stream.unsubscribe).not.toHaveBeenCalled();

    const cancelResult = await stream.registry.dispatch(
      "$/subscription/cancel",
      { subscriptionId: stream.subscriptionId },
      { transportId: 13 },
    );

    expect((cancelResult as { canceled: boolean }).canceled).toBe(true);
    expect(stream.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("the connection closing detaches the upstream", async () => {
    const stream = await subscribeCountingDetach(21);

    stream.primitive.cleanupTransport(21);

    expect(stream.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
