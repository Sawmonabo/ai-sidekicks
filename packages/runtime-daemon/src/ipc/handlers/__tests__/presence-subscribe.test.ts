// `presence.subscribe` through the method registry and a real streaming primitive: the whole
// device list is pushed as `$/subscription/notify` frames, validated before send, after the
// `{subscriptionId}` response. Also: a request naming a session is refused, a missing transport
// id is refused, a bad pushed value cancels the subscription instead of crashing the daemon,
// and cancel or disconnect (but not `complete()`) detaches the source.

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  HandlerContext,
  JsonRpcNotification,
  MachinePresence,
  PresenceSubscribeResponse,
  SessionId,
  SubscriptionNotifyParams,
} from "@ai-sidekicks/contracts";
import {
  JSONRPC_VERSION,
  MachinePresenceSchema,
  SUBSCRIPTION_NOTIFY_METHOD,
} from "@ai-sidekicks/contracts";

import {
  MethodRegistryImpl,
  RegistryDispatchError,
  RegistryRegistrationError,
} from "../../registry.js";
import { StreamingPrimitive, StreamingValidationError } from "../../streaming-primitive.js";

import { registerPresenceSubscribe, type PresenceSubscribeDeps } from "../presence-subscribe.js";

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
        state: "online",
      },
    ],
  };
}

/** A pushed value that fails `MachinePresenceSchema`: it names a session. */
const MALFORMED_PRESENCE = {
  devices: [],
  sessionId: TEST_SESSION_ID,
} as unknown as MachinePresence;

describe("presence.subscribe — push slice round-trip + wire-frame emission", () => {
  it("dispatches subscribe; returns `{subscriptionId}`; sub.next(update) routes as a `$/subscription/notify` frame validated against MachinePresenceSchema", async () => {
    const registry = new MethodRegistryImpl();
    const send = vi.fn<(transportId: number, frame: JsonRpcNotification<unknown>) => void>();
    const primitive = new StreamingPrimitive({ registry, send });

    // Captures the `onUpdate` the handler passes to `subscribeToPresence`. A holder object,
    // because TypeScript narrows a closure-assigned `let` to `null` at the outer read.
    const onUpdateHolder: { current: ((update: MachinePresence) => void) | null } = {
      current: null,
    };
    const unsubscribe = vi.fn<() => void>();
    const subscribeToPresence = vi.fn<PresenceSubscribeDeps["subscribeToPresence"]>((onUpdate) => {
      onUpdateHolder.current = onUpdate;
      return unsubscribe;
    });
    const deps: PresenceSubscribeDeps = { streamingPrimitive: primitive, subscribeToPresence };
    registerPresenceSubscribe(registry, deps);

    const transportId = 42;
    const ctx: HandlerContext = { transportId };
    const result = (await registry.dispatch(
      "presence.subscribe",
      {},
      ctx,
    )) as PresenceSubscribeResponse;

    expect(typeof result.subscriptionId).toBe("string");
    expect(result.subscriptionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    expect(subscribeToPresence).toHaveBeenCalledTimes(1);
    expect(onUpdateHolder.current).not.toBeNull();

    // Nothing is pushed before the response is written.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(send).not.toHaveBeenCalled();

    const onUpdate = onUpdateHolder.current;
    if (onUpdate === null) throw new Error("unreachable — onUpdate captured above");
    const update = buildMachinePresence();
    onUpdate(update);

    expect(send).toHaveBeenCalledTimes(1);
    const call = send.mock.calls[0];
    if (call === undefined) throw new Error("unreachable");
    const [actualTransportId, frame] = call;
    expect(actualTransportId).toBe(transportId);
    expect(frame.jsonrpc).toBe(JSONRPC_VERSION);
    expect(frame.method).toBe(SUBSCRIPTION_NOTIFY_METHOD);
    const params = frame.params as SubscriptionNotifyParams<MachinePresence>;
    expect(params.subscriptionId).toBe(result.subscriptionId);
    expect(params.value).toStrictEqual(update);
  });

  it("buffers updates fired synchronously during setup and flushes them AFTER the init response (wire-ordering invariant)", async () => {
    // The source fires an update during setup. The handler holds it until after the response,
    // or the client would receive a notify for an id it does not know yet and drop it.
    const registry = new MethodRegistryImpl();
    const send = vi.fn<(transportId: number, frame: JsonRpcNotification<unknown>) => void>();
    const primitive = new StreamingPrimitive({ registry, send });

    const syncUpdate = buildMachinePresence();
    const subscribeToPresence = vi.fn<PresenceSubscribeDeps["subscribeToPresence"]>((onUpdate) => {
      onUpdate(syncUpdate);
      return vi.fn<() => void>();
    });
    const deps: PresenceSubscribeDeps = { streamingPrimitive: primitive, subscribeToPresence };
    registerPresenceSubscribe(registry, deps);

    const ctx: HandlerContext = { transportId: 7 };
    await registry.dispatch("presence.subscribe", {}, ctx);

    // The update is still held.
    expect(send).not.toHaveBeenCalled();

    // The held update is sent on the next `setImmediate`.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(send).toHaveBeenCalledTimes(1);
    const call = send.mock.calls[0];
    if (call === undefined) throw new Error("unreachable");
    const params = call[1].params as SubscriptionNotifyParams<MachinePresence>;
    expect(params.value).toStrictEqual(syncUpdate);
  });

  it("a malformed pushed value throws StreamingValidationError from sub.next (MachinePresenceSchema validates before send)", async () => {
    // Uses a primitive-level subscription, because the handler catches this throw, cancels the
    // subscription and logs it, so it would not reach the test.
    const registry = new MethodRegistryImpl();
    const send = vi.fn<(transportId: number, frame: JsonRpcNotification<unknown>) => void>();
    const primitive = new StreamingPrimitive({ registry, send });

    // The subscription uses the same per-value schema as the handler.
    const sub = primitive.createSubscription<MachinePresence>(99, MachinePresenceSchema);

    // A list with an unknown key fails `MachinePresenceSchema`.
    const malformed = MALFORMED_PRESENCE;
    expect(() => sub.next(malformed)).toThrow(StreamingValidationError);
    // Validation fails before anything is sent.
    expect(send).not.toHaveBeenCalled();
  });

  it("a request that names a session rejects with `RegistryDispatchError(invalid_params)`; the source is never followed", async () => {
    const registry = new MethodRegistryImpl();
    const send = vi.fn<(transportId: number, frame: JsonRpcNotification<unknown>) => void>();
    const primitive = new StreamingPrimitive({ registry, send });
    const subscribeToPresence = vi.fn<PresenceSubscribeDeps["subscribeToPresence"]>(() =>
      vi.fn<() => void>(),
    );
    registerPresenceSubscribe(registry, { streamingPrimitive: primitive, subscribeToPresence });

    const dispatched = registry.dispatch(
      "presence.subscribe",
      { sessionId: TEST_SESSION_ID },
      { transportId: 5 },
    );

    await expect(dispatched).rejects.toBeInstanceOf(RegistryDispatchError);
    await expect(dispatched).rejects.toMatchObject({ registryCode: "invalid_params" });
    expect(subscribeToPresence).not.toHaveBeenCalled();
  });

  it("registers `presence.subscribe` with mutating: false (subscribing allocates IPC state, mutates no domain row)", () => {
    const registry = new MethodRegistryImpl();
    const send = vi.fn<(transportId: number, frame: JsonRpcNotification<unknown>) => void>();
    const primitive = new StreamingPrimitive({ registry, send });
    const deps: PresenceSubscribeDeps = {
      streamingPrimitive: primitive,
      subscribeToPresence: () => vi.fn<() => void>(),
    };
    registerPresenceSubscribe(registry, deps);
    expect(registry.isMutating("presence.subscribe")).toBe(false);
  });

  it("refuses dispatch when ctx.transportId is undefined (per-connection streaming state requires a transport identity)", async () => {
    const registry = new MethodRegistryImpl();
    const send = vi.fn<(transportId: number, frame: JsonRpcNotification<unknown>) => void>();
    const primitive = new StreamingPrimitive({ registry, send });
    const subscribeToPresence = vi.fn<PresenceSubscribeDeps["subscribeToPresence"]>(() =>
      vi.fn<() => void>(),
    );
    const deps: PresenceSubscribeDeps = { streamingPrimitive: primitive, subscribeToPresence };
    registerPresenceSubscribe(registry, deps);

    // The handler throws a plain Error (an internal error on the wire) before subscribing.
    await expect(registry.dispatch("presence.subscribe", {}, {})).rejects.toThrow(
      /requires ctx\.transportId/,
    );
    expect(subscribeToPresence).not.toHaveBeenCalled();
  });

  it("calling registerPresenceSubscribe twice on the same registry throws `RegistryRegistrationError(duplicate_method)`", () => {
    const registry = new MethodRegistryImpl();
    const send = vi.fn<(transportId: number, frame: JsonRpcNotification<unknown>) => void>();
    const primitive = new StreamingPrimitive({ registry, send });
    const deps: PresenceSubscribeDeps = {
      streamingPrimitive: primitive,
      subscribeToPresence: () => vi.fn<() => void>(),
    };
    registerPresenceSubscribe(registry, deps);

    let caught: unknown = null;
    try {
      registerPresenceSubscribe(registry, deps);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RegistryRegistrationError);
    if (caught instanceof RegistryRegistrationError) {
      expect(caught.registryCode).toBe("duplicate_method");
    }
  });
});

describe("presence.subscribe — replay-flush + live-tail crash guards", () => {
  // This package's vitest config does not restore mocks automatically, so a console spy left by
  // a failed test would leak into the next one.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("replay-flush: a malformed update in the replay buffer is caught; subscription canceled; daemon survives", async () => {
    // A bad update fired during setup is held, then fails validation when the `setImmediate`
    // flush sends it. Without the handler's catch that throw would be uncaught and stop the
    // daemon; with it, the subscription is canceled and the failure logged.
    const registry = new MethodRegistryImpl();
    const send = vi.fn<(transportId: number, frame: JsonRpcNotification<unknown>) => void>();
    const primitive = new StreamingPrimitive({ registry, send });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const malformed = MALFORMED_PRESENCE;
    const subscribeToPresence = vi.fn<PresenceSubscribeDeps["subscribeToPresence"]>((onUpdate) => {
      onUpdate(malformed);
      return () => undefined;
    });
    const deps: PresenceSubscribeDeps = { streamingPrimitive: primitive, subscribeToPresence };
    registerPresenceSubscribe(registry, deps);

    const ctx: HandlerContext = { transportId: 7 };
    const result = (await registry.dispatch(
      "presence.subscribe",
      {},
      ctx,
    )) as PresenceSubscribeResponse;
    await new Promise<void>((resolve) => setImmediate(resolve));

    // The subscription is already canceled, so canceling it again finds nothing.
    expect(primitive.cancelSubscription(result.subscriptionId)).toBe(false);
    expect(send).not.toHaveBeenCalled();
    // The log carries the subscription id, then the validation error.
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const errCall = consoleErrorSpy.mock.calls[0];
    if (errCall === undefined) throw new Error("unreachable — tripwire log expected");
    const [prefix, err] = errCall;
    expect(typeof prefix).toBe("string");
    expect(prefix).toContain("[presence.subscribe] replay update validation/emission failed");
    expect(prefix).toContain(result.subscriptionId);
    expect(err).toBeInstanceOf(Error);
    if (err instanceof Error) {
      expect(err.name).toBe("StreamingValidationError");
    }
  });

  it("live-tail: a malformed update after replay drain is caught; subscription canceled; daemon survives", async () => {
    // A bad update pushed after the first flush takes the live path. Without the handler's
    // catch, the validation throw would escape the source's call as an uncaught exception.
    const registry = new MethodRegistryImpl();
    const send = vi.fn<(transportId: number, frame: JsonRpcNotification<unknown>) => void>();
    const primitive = new StreamingPrimitive({ registry, send });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const onUpdateHolder: { current: ((update: MachinePresence) => void) | null } = {
      current: null,
    };
    const subscribeToPresence = vi.fn<PresenceSubscribeDeps["subscribeToPresence"]>((onUpdate) => {
      onUpdateHolder.current = onUpdate;
      return () => undefined;
    });
    const deps: PresenceSubscribeDeps = { streamingPrimitive: primitive, subscribeToPresence };
    registerPresenceSubscribe(registry, deps);

    const ctx: HandlerContext = { transportId: 7 };
    const result = (await registry.dispatch(
      "presence.subscribe",
      {},
      ctx,
    )) as PresenceSubscribeResponse;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const onUpdate = onUpdateHolder.current;
    if (onUpdate === null) throw new Error("unreachable — onUpdate captured above");

    // `not.toThrow` makes a missing catch fail this test instead of aborting the suite.
    const malformed = MALFORMED_PRESENCE;
    expect(() => onUpdate(malformed)).not.toThrow();

    expect(primitive.cancelSubscription(result.subscriptionId)).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const errCall = consoleErrorSpy.mock.calls[0];
    if (errCall === undefined) throw new Error("unreachable — tripwire log expected");
    const [prefix, err] = errCall;
    expect(typeof prefix).toBe("string");
    expect(prefix).toContain("[presence.subscribe] live-tail update validation/emission failed");
    expect(prefix).toContain(result.subscriptionId);
    expect(err).toBeInstanceOf(Error);
    if (err instanceof Error) {
      expect(err.name).toBe("StreamingValidationError");
    }
  });
});

describe("presence.subscribe — wires upstream unsubscribe via sub.onCancel (the streaming-leak invariant)", () => {
  it("wire-cancel (`$/subscription/cancel` from the same transport) fires the upstream unsubscribe", async () => {
    // Without the handler's `sub.onCancel(unsubscribe)`, the subscription would be removed but
    // the presence source's watcher would leak.
    const registry = new MethodRegistryImpl();
    const send = vi.fn<(transportId: number, frame: JsonRpcNotification<unknown>) => void>();
    const primitive = new StreamingPrimitive({ registry, send });
    const unsubscribe = vi.fn<() => void>();
    const subscribeToPresence = vi.fn<PresenceSubscribeDeps["subscribeToPresence"]>(
      () => unsubscribe,
    );
    const deps: PresenceSubscribeDeps = { streamingPrimitive: primitive, subscribeToPresence };
    registerPresenceSubscribe(registry, deps);

    const transportId = 13;
    const ctx: HandlerContext = { transportId };
    const result = (await registry.dispatch(
      "presence.subscribe",
      {},
      ctx,
    )) as PresenceSubscribeResponse;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(unsubscribe).not.toHaveBeenCalled();

    // The cancel handler checks that the subscription belongs to the calling transport.
    const cancelResult = await registry.dispatch(
      "$/subscription/cancel",
      { subscriptionId: result.subscriptionId },
      { transportId },
    );

    expect((cancelResult as { canceled: boolean }).canceled).toBe(true);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("transport-disconnect (`cleanupTransport`) fires the upstream unsubscribe", async () => {
    // A closed connection calls `cleanupTransport`; the test calls it directly.
    const registry = new MethodRegistryImpl();
    const send = vi.fn<(transportId: number, frame: JsonRpcNotification<unknown>) => void>();
    const primitive = new StreamingPrimitive({ registry, send });
    const unsubscribe = vi.fn<() => void>();
    const subscribeToPresence = vi.fn<PresenceSubscribeDeps["subscribeToPresence"]>(
      () => unsubscribe,
    );
    const deps: PresenceSubscribeDeps = { streamingPrimitive: primitive, subscribeToPresence };
    registerPresenceSubscribe(registry, deps);

    const transportId = 21;
    const ctx: HandlerContext = { transportId };
    await registry.dispatch("presence.subscribe", {}, ctx);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(unsubscribe).not.toHaveBeenCalled();

    primitive.cleanupTransport(transportId);

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("complete() does NOT fire the upstream unsubscribe (natural producer-driven termination is silent)", () => {
    // `complete()` is called by the producer itself, which already knows the stream ended, so
    // it must not run the cancel hooks.
    const registry = new MethodRegistryImpl();
    const send = vi.fn<(transportId: number, frame: JsonRpcNotification<unknown>) => void>();
    const primitive = new StreamingPrimitive({ registry, send });
    const sub = primitive.createSubscription<MachinePresence>(31, MachinePresenceSchema);
    const unsubscribe = vi.fn<() => void>();
    sub.onCancel(unsubscribe);

    sub.complete();

    expect(unsubscribe).not.toHaveBeenCalled();
  });
});
