// `driver.subscribeEvents` through the real method registry and streaming primitive: a
// subscription loses no event, forwards only driver events, sends nothing when its source fails to
// start, and tears its source down on cancel.

import { describe, expect, it, vi } from "vitest";

import type { AgentId } from "@ai-sidekicks/contracts/agent/definition";
import type { HandlerContext } from "@ai-sidekicks/contracts/jsonrpc/registry";
import type { JsonRpcNotification } from "@ai-sidekicks/contracts/jsonrpc/message";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionEvent } from "@ai-sidekicks/contracts/event/variant-types";
import type { SessionId, UserId } from "@ai-sidekicks/contracts/session/id";

import { MethodRegistryImpl } from "../../../registry.js";
import { StreamingPrimitive } from "../../../streaming-primitive.js";
import { registerDriverSubscribeEvents, type DriverSubscribeEventsDeps } from "../subscribe.js";

const TEST_SESSION_ID = "550e8400-e29b-41d4-a716-446655440000" as SessionId;
const TEST_ACTOR_ID = "660e8400-e29b-41d4-a716-446655440001" as UserId;
const TEST_RUN_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301" as RunId;
const TRANSPORT: HandlerContext = { transportId: 7 };

describe("driver.subscribeEvents", () => {
  function buildSubscribeHarness(
    subscribeToDriverEvents: DriverSubscribeEventsDeps["subscribeToDriverEvents"],
  ): { registry: MethodRegistryImpl; frames: JsonRpcNotification<unknown>[] } {
    const registry = new MethodRegistryImpl();
    const frames: JsonRpcNotification<unknown>[] = [];
    const streamingPrimitive = new StreamingPrimitive({
      send: (_transportId, frame) => {
        frames.push(frame);
      },
      registry,
    });
    registerDriverSubscribeEvents(registry, { streamingPrimitive, subscribeToDriverEvents });
    return { registry, frames };
  }

  /** An `assistant_output` event, one of the seven driver categories. */
  function driverEvent(sequence: number): SessionEvent {
    return {
      id: `evt-${sequence}`,
      sessionId: TEST_SESSION_ID,
      sequence,
      occurredAt: "2026-01-22T19:14:35.000Z",
      category: "assistant_output",
      type: "assistant.message",
      actor: TEST_ACTOR_ID,
      version: "1.0" as SessionEvent["version"],
      payload: {
        sessionId: TEST_SESSION_ID,
        runId: TEST_RUN_ID,
        providerMessageId: `msg_reply_${sequence}`,
      },
    };
  }

  /** A `session.created` event: valid as a session event, but outside the driver categories. */
  function sessionLifecycleEvent(): SessionEvent {
    return {
      id: "evt-non-driver",
      sessionId: TEST_SESSION_ID,
      sequence: 99,
      occurredAt: "2026-01-22T19:14:35.000Z",
      category: "session_lifecycle",
      type: "session.created",
      actor: TEST_ACTOR_ID,
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

  it("holds setup-time events until after the response; forwards only driver events", async () => {
    // The source may catch up synchronously; a notify frame ahead of the response carries a
    // subscription id the client does not know yet, so it drops the event. A source wired to a
    // session-wide feed would push lifecycle rows onto one run's driver stream.
    let live: ((event: SessionEvent) => void) | undefined;
    const { registry, frames } = buildSubscribeHarness((_runId, onEvent) => {
      onEvent(sessionLifecycleEvent());
      onEvent(driverEvent(1));
      onEvent(driverEvent(2));
      live = onEvent;
      return () => undefined;
    });

    await registry.dispatch("driver.subscribeEvents", { runId: TEST_RUN_ID }, TRANSPORT);
    expect(frames).toHaveLength(0);

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(frames).toHaveLength(2);

    live?.(sessionLifecycleEvent());
    live?.(driverEvent(3));
    expect(frames).toHaveLength(3);
  });

  it("a source that fails to start rejects the subscribe and sends no frame", async () => {
    const { registry, frames } = buildSubscribeHarness(() => {
      throw new Error("no such run");
    });

    await expect(
      registry.dispatch("driver.subscribeEvents", { runId: TEST_RUN_ID }, TRANSPORT),
    ).rejects.toThrow();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(frames).toStrictEqual([]);
  });

  it("tears the upstream source down when the subscription is canceled", async () => {
    const unsubscribe = vi.fn();
    const { registry } = buildSubscribeHarness(() => unsubscribe);

    const result = (await registry.dispatch(
      "driver.subscribeEvents",
      { runId: TEST_RUN_ID },
      TRANSPORT,
    )) as { subscriptionId: string };
    await registry.dispatch(
      "$/subscription/cancel",
      { subscriptionId: result.subscriptionId },
      TRANSPORT,
    );

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
