// `run.subscribeState` through the method registry and streaming primitive: Codex's safety hold,
// which goes out at the session's newest cursor, never reaches a returning screen ahead of the
// stored changes it is catching up on.

import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { EventEnvelopeSchema } from "@ai-sidekicks/contracts/event/envelope";
import type { JsonRpcNotification } from "@ai-sidekicks/contracts/jsonrpc/message";
import type { SubscriptionNotifyParams } from "@ai-sidekicks/contracts/jsonrpc/streaming";
import type { RunStateStreamFrame } from "@ai-sidekicks/contracts/run/control";
import { RunIdSchema } from "@ai-sidekicks/contracts/run/id";
import type { EventCursor } from "@ai-sidekicks/contracts/session/event-cursor";
import { SessionIdSchema } from "@ai-sidekicks/contracts/session/id";

import type { SessionEventListener } from "../../../../events/session/followers.js";
import { MethodRegistryImpl } from "../../../registry.js";
import { StreamingPrimitive } from "../../../streaming-primitive.js";
import { registerRunStateSubscribe, RunSafetyHolds } from "../state.js";

const SESSION_ID = SessionIdSchema.parse(randomUUID());
const RUN_ID = RunIdSchema.parse(randomUUID());
const NEWEST_CURSOR = "cursor-newest" as EventCursor;

describe("run.subscribeState", () => {
  // Mutation: handing a hold to the batcher as it comes puts the newest cursor ahead of the stored
  // rows, which a screen resuming from it would skip.
  it("sends a hold that comes during the catch-up after the stored changes", async () => {
    const registry = new MethodRegistryImpl();
    const notifications: JsonRpcNotification<unknown>[] = [];
    const streamingPrimitive = new StreamingPrimitive({
      registry,
      send: (_transportId, notification) => {
        notifications.push(notification);
      },
    });
    const holds = new RunSafetyHolds(() => NEWEST_CURSOR);
    let follower: SessionEventListener | undefined;
    registerRunStateSubscribe(registry, {
      streamingPrimitive,
      outboundQueue: { isFull: () => false, onceDrained: () => () => undefined },
      readNewestCursor: () => NEWEST_CURSOR,
      followSession: (_sessionId, _afterCursor, listener) => {
        follower = listener;
        return () => undefined;
      },
      holds,
    });
    await registry.dispatch(
      "run.subscribeState",
      { sessionId: SESSION_ID, afterCursor: "cursor-start" },
      { transportId: 7 },
    );
    if (follower === undefined) {
      throw new Error("expected the stream to follow the session");
    }

    holds.publish({ sessionId: SESSION_ID, runId: RUN_ID, turnId: "turn-1", active: true });
    const starting = EventEnvelopeSchema.parse({
      id: randomUUID(),
      sessionId: SESSION_ID,
      sequence: 1,
      occurredAt: "2026-10-11T12:00:00.000Z",
      category: "run_lifecycle",
      type: "run.starting",
      actor: null,
      version: "1.0",
      payload: {
        sessionId: SESSION_ID,
        runId: RUN_ID,
        runVersion: 1,
        previousState: "queued",
        newState: "starting",
      },
    });
    follower.onChange({ event: starting, cursor: "cursor-1" as EventCursor });
    follower.onCaughtUp();

    await vi.waitFor(() => {
      const cursors = notifications
        .map(
          (notification) =>
            (notification.params as SubscriptionNotifyParams<RunStateStreamFrame>).value,
        )
        .flatMap((frame) => frame.changes.map((change) => change.cursor));
      expect(cursors).toStrictEqual(["cursor-1", NEWEST_CURSOR]);
    });
  });
});
