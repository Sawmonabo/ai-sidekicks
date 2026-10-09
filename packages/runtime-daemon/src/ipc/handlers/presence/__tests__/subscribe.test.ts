// `presence.subscribe` through the method registry and a real streaming primitive: the device
// list is pushed after the `{subscriptionId}` response, a source that fails to start sends nothing,
// a bad pushed value cancels the subscription instead of crashing the daemon, and cancel or
// disconnect detaches the source.

import { afterEach, describe, expect, it, vi } from "vitest";

import type { JsonRpcNotification } from "@ai-sidekicks/contracts/jsonrpc/message";
import type { MachinePresence, PresenceSubscribeResponse } from "@ai-sidekicks/contracts/presence";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { JSONRPC_VERSION } from "@ai-sidekicks/contracts/jsonrpc/message";
import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/error-code";
import {
  SUBSCRIPTION_END_METHOD,
  SUBSCRIPTION_NOTIFY_METHOD,
} from "@ai-sidekicks/contracts/jsonrpc/streaming";

import { MethodRegistryImpl } from "../../../registry.js";
import { StreamingPrimitive } from "../../../streaming-primitive.js";

import { registerPresenceSubscribe, type PresenceSubscribeDeps } from "../subscribe.js";

// A fixed id, so a failure prints the same value every run.
const TEST_SESSION_ID = "550e8400-e29b-41d4-a716-446655440000" as SessionId;

/** A `MachinePresence` with one connected device. */
function buildMachinePresence(): MachinePresence {
  return {
    devices: [
      {
        deviceId: "660e8400-e29b-41d4-a716-446655440001",
        deviceType: "mobile",
        appVisible: false,
      },
    ],
  };
}

/** A pushed value that fails `MachinePresenceSchema`: it names a session. */
const MALFORMED_PRESENCE = {
  devices: [],
  sessionId: TEST_SESSION_ID,
} as unknown as MachinePresence;

/**
 * Binds `presence.subscribe` on a fresh registry and primitive. `pushUpdate` calls the `onUpdate`
 * the handler handed the source; `beforeReturn` runs inside the source's subscribe call, the place
 * a source reports synchronously.
 */
function setupPresence(
  options: { readonly beforeReturn?: (onUpdate: (update: MachinePresence) => void) => void } = {},
) {
  const registry = new MethodRegistryImpl();
  const send = vi.fn<(transportId: number, frame: JsonRpcNotification<unknown>) => void>();
  const primitive = new StreamingPrimitive({ registry, send });
  const unsubscribe = vi.fn<() => void>();
  let capturedOnUpdate: ((update: MachinePresence) => void) | null = null;
  const subscribeToPresence = vi.fn<PresenceSubscribeDeps["subscribeToPresence"]>((onUpdate) => {
    capturedOnUpdate = onUpdate;
    options.beforeReturn?.(onUpdate);
    return unsubscribe;
  });
  registerPresenceSubscribe(registry, { streamingPrimitive: primitive, subscribeToPresence });

  return {
    registry,
    send,
    primitive,
    unsubscribe,
    subscribeToPresence,
    subscribe: async (
      transportId: number,
    ): Promise<PresenceSubscribeResponse["subscriptionId"]> => {
      const reply = (await registry.dispatch(
        "presence.subscribe",
        {},
        { transportId },
      )) as PresenceSubscribeResponse;
      return reply.subscriptionId;
    },
    pushUpdate: (update: MachinePresence): void => {
      if (capturedOnUpdate === null) {
        throw new Error("the handler never subscribed to the presence source");
      }
      capturedOnUpdate(update);
    },
  };
}

/** Lets the barrier's `setImmediate` flush run. */
async function nextCheckPhase(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("presence.subscribe — push slice round-trip + wire-frame emission", () => {
  it("a source that fails to start rejects the subscribe and sends no frame", async () => {
    const presence = setupPresence();
    presence.subscribeToPresence.mockImplementation(() => {
      throw new Error("presence is unavailable");
    });

    await expect(presence.subscribe(7)).rejects.toThrow("presence is unavailable");
    await nextCheckPhase();
    expect(presence.send).not.toHaveBeenCalled();
  });

  it(
    "dispatches subscribe; returns `{subscriptionId}`; a pushed update routes as a " +
      "`$/subscription/notify` frame validated against MachinePresenceSchema",
    async () => {
      const presence = setupPresence();
      const transportId = 42;
      const subscriptionId = await presence.subscribe(transportId);

      expect(subscriptionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(presence.subscribeToPresence).toHaveBeenCalledTimes(1);

      // Nothing is pushed before the response is written.
      await nextCheckPhase();
      expect(presence.send).not.toHaveBeenCalled();

      const update = buildMachinePresence();
      presence.pushUpdate(update);

      expect(presence.send).toHaveBeenCalledExactlyOnceWith(transportId, {
        jsonrpc: JSONRPC_VERSION,
        method: SUBSCRIPTION_NOTIFY_METHOD,
        params: { subscriptionId, value: update },
      });
    },
  );

  it(
    "buffers updates fired synchronously during setup and flushes them AFTER the init response " +
      "(wire-ordering invariant)",
    async () => {
      // The source fires an update during setup. The handler holds it until after the response,
      // or the client would receive a notify for an id it does not know yet and drop it.
      const syncUpdate = buildMachinePresence();
      const presence = setupPresence({
        beforeReturn: (onUpdate) => {
          onUpdate(syncUpdate);
        },
      });
      const subscriptionId = await presence.subscribe(7);

      // The update is still held.
      expect(presence.send).not.toHaveBeenCalled();

      // The held update is sent on the next `setImmediate`.
      await nextCheckPhase();
      expect(presence.send).toHaveBeenCalledExactlyOnceWith(7, {
        jsonrpc: JSONRPC_VERSION,
        method: SUBSCRIPTION_NOTIFY_METHOD,
        params: { subscriptionId, value: syncUpdate },
      });
    },
  );
});

describe("presence.subscribe — catch-up flush + live-tail crash guards", () => {
  // This package's vitest config does not restore mocks automatically, so a console spy left by
  // a failed test would leak into the next one.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The one log line a canceled subscription writes: the subscription id, then the error. */
  function expectCanceledWithLog(
    consoleErrorSpy: ReturnType<typeof vi.spyOn>,
    path: "catch-up" | "live-tail",
    subscriptionId: string,
  ): void {
    expect(consoleErrorSpy).toHaveBeenCalledExactlyOnceWith(
      `[presence.subscribe] ${path} event validation/emission failed for ` +
        `subscriptionId=${subscriptionId}; subscription canceled`,
      expect.objectContaining({ name: "StreamingValidationError" }),
    );
  }

  it(
    "catch-up flush: a malformed update in the catch-up buffer is caught; subscription " +
      "canceled; daemon survives",
    async () => {
      // A bad update fired during setup is held, then fails validation when the `setImmediate`
      // flush sends it. Without a catch that throw would be uncaught and stop the daemon; with it,
      // the subscription is canceled and the failure logged.
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const presence = setupPresence({
        beforeReturn: (onUpdate) => {
          onUpdate(MALFORMED_PRESENCE);
        },
      });
      const subscriptionId = await presence.subscribe(7);
      await nextCheckPhase();

      // The subscription is already canceled, so canceling it again finds nothing.
      expect(presence.primitive.cancelSubscription(subscriptionId)).toBe(false);
      // The bad update never reaches the client; its stream ends refused instead.
      expect(presence.send.mock.calls).toMatchObject([
        [
          7,
          {
            method: SUBSCRIPTION_END_METHOD,
            params: {
              subscriptionId: subscriptionId,
              reason: "refused",
              error: { code: JsonRpcErrorCode.InternalError },
            },
          },
        ],
      ]);
      expectCanceledWithLog(consoleErrorSpy, "catch-up", subscriptionId);
    },
  );

  it(
    "live-tail: a malformed update after catch-up drain is caught; subscription canceled; daemon " +
      "survives",
    async () => {
      // A bad update pushed after the first flush takes the live path. Without a catch, the
      // validation throw would escape the source's call as an uncaught exception.
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const presence = setupPresence();
      const subscriptionId = await presence.subscribe(7);
      await nextCheckPhase();

      // `not.toThrow` makes a missing catch fail this test instead of aborting the suite.
      expect(() => {
        presence.pushUpdate(MALFORMED_PRESENCE);
      }).not.toThrow();

      expect(presence.primitive.cancelSubscription(subscriptionId)).toBe(false);
      // The bad update never reaches the client; its stream ends refused instead.
      expect(presence.send.mock.calls).toMatchObject([
        [
          7,
          {
            method: SUBSCRIPTION_END_METHOD,
            params: {
              subscriptionId: subscriptionId,
              reason: "refused",
              error: { code: JsonRpcErrorCode.InternalError },
            },
          },
        ],
      ]);
      expectCanceledWithLog(consoleErrorSpy, "live-tail", subscriptionId);
    },
  );
});

describe(
  "presence.subscribe — wires upstream unsubscribe via sub.onCancel (the streaming-leak " +
    "invariant)",
  () => {
    it(
      "wire-cancel (`$/subscription/cancel` from the same transport) fires the upstream " +
        "unsubscribe",
      async () => {
        // Without the handler's `sub.onCancel(unsubscribe)`, the subscription would be removed but
        // the presence source's watcher would leak.
        const presence = setupPresence();
        const transportId = 13;
        const subscriptionId = await presence.subscribe(transportId);
        await nextCheckPhase();
        expect(presence.unsubscribe).not.toHaveBeenCalled();

        // The cancel handler checks that the subscription belongs to the calling transport.
        await expect(
          presence.registry.dispatch("$/subscription/cancel", { subscriptionId }, { transportId }),
        ).resolves.toStrictEqual({ canceled: true });
        expect(presence.unsubscribe).toHaveBeenCalledTimes(1);
      },
    );

    it("transport-disconnect (`cleanupTransport`) fires the upstream unsubscribe", async () => {
      // A closed connection calls `cleanupTransport`; the test calls it directly.
      const presence = setupPresence();
      const transportId = 21;
      await presence.subscribe(transportId);
      await nextCheckPhase();
      expect(presence.unsubscribe).not.toHaveBeenCalled();

      presence.primitive.cleanupTransport(transportId);

      expect(presence.unsubscribe).toHaveBeenCalledTimes(1);
    });
  },
);
