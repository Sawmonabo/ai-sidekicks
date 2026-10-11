// `run.subscribeQueue` through the method registry and streaming primitive: a screen returning
// with a cursor gets every change past it, however full its connection was when it returned.

import { describe, expect, it, vi } from "vitest";

import type { JsonRpcNotification } from "@ai-sidekicks/contracts/jsonrpc/message";
import type { SubscriptionNotifyParams } from "@ai-sidekicks/contracts/jsonrpc/streaming";
import {
  QueueItemIdSchema,
  type RunQueueStreamChange,
  type RunQueueStreamFrame,
} from "@ai-sidekicks/contracts/run/queue";
import type { EventCursor } from "@ai-sidekicks/contracts/session/event-cursor";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { ProviderDriver } from "../../../../provider/driver/contract.js";
import { MethodRegistryImpl } from "../../../registry.js";
import { RUN_STREAM_HELD_CHANGES_MAX } from "../../../stream-frame-batcher.js";
import { StreamingPrimitive } from "../../../streaming-primitive.js";
import { registerRunQueueMethods } from "../queue.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000" as SessionId;

function changeAt(index: number): RunQueueStreamChange {
  return {
    cursor: `cursor-${String(index)}` as EventCursor,
    item: {
      id: QueueItemIdSchema.parse(`018f3a2b-0000-7000-8000-${String(index).padStart(12, "0")}`),
      state: "queued",
      position: index,
      content: `message ${String(index)}`,
      createdAt: "2026-10-11T12:00:00.000Z",
      updatedAt: "2026-10-11T12:00:00.000Z",
    },
  };
}

function refuse(): Promise<never> {
  return Promise.reject(new Error("only the queue's stream is read here"));
}

describe("run.subscribeQueue", () => {
  // Mutation: ending the catch-up while the connection is full drops its changes past the held
  // maximum, and the screen gets a drop mark for changes the daemon still had.
  it("sends every stored change past a returning screen's cursor once its connection has room", async () => {
    const stored = Array.from({ length: RUN_STREAM_HELD_CHANGES_MAX + 1 }, (_, index) =>
      changeAt(index),
    );
    let isFull = true;
    const drainListeners: (() => void)[] = [];
    const registry = new MethodRegistryImpl();
    const notifications: JsonRpcNotification<unknown>[] = [];
    const streamingPrimitive = new StreamingPrimitive({
      registry,
      send: (_transportId, notification) => {
        notifications.push(notification);
      },
    });
    registerRunQueueMethods(registry, {
      queue: {
        create: refuse,
        list: () => ({ items: [] }),
        cancel: refuse,
        reorder: refuse,
        readChangesAfter: () => stored,
      },
      recorder: { follow: () => () => undefined },
      sessions: {
        providerRegistry: { lookup: () => ({}) as ProviderDriver },
        resolveDriverForSession: () => "claude",
      },
      streamingPrimitive,
      outboundQueue: {
        isFull: () => isFull,
        onceDrained: (_transportId, listener) => {
          drainListeners.push(listener);
          return () => undefined;
        },
      },
    });

    await registry.dispatch(
      "run.subscribeQueue",
      { sessionId: SESSION_ID, afterCursor: "cursor-start" },
      { transportId: 7 },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    isFull = false;
    for (const listener of drainListeners.splice(0)) {
      listener();
    }

    await vi.waitFor(() => {
      const frames = notifications.map(
        (notification) =>
          (notification.params as SubscriptionNotifyParams<RunQueueStreamFrame>).value,
      );
      expect(frames.some((frame) => frame.dropped === true)).toBe(false);
      expect(frames.flatMap((frame) => frame.changes)).toStrictEqual(stored);
    });
  });
});
