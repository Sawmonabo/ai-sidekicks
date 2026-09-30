// `presence.subscribe` handler test suite.
//
// Presence is the devices connected to this machine, held in memory and pushed
// to the client as the whole list on each change; it never lands in
// `session_events`. Tests: round-trip through dispatch → `{subscriptionId}`; a
// pushed `MachinePresence` becomes a `$/subscription/notify` frame validated
// against `MachinePresenceSchema`; a request that names a session is refused;
// `mutating: false`; transportId required; duplicate-registration.
//
// Invariants verified:
//   * Duplicate `registerPresenceSubscribe` is rejected at register-time.
//   * Streaming validate-before-send — every pushed `MachinePresence` is
//     validated against `MachinePresenceSchema` before the
//     `$/subscription/notify` frame is sent; a malformed value throws
//     `StreamingValidationError` from `sub.next(...)`.
//   * Subscribe-init response precedes the first notification frame: updates
//     fired during setup buffer and flush on a `setImmediate` boundary after
//     the init `{subscriptionId}` response settles (also exercised by the
//     replay-flush + live-tail crash guards).
//   * Streaming-leak — `sub.onCancel(unsubscribe)` fires the upstream detach
//     on wire-cancel + transport-disconnect; `complete()` does NOT fire it.

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

// ----------------------------------------------------------------------------
// Shared fixtures
// ----------------------------------------------------------------------------
//
// Static literal IDs chosen for human-readable failure output.

const TEST_SESSION_ID = "550e8400-e29b-41d4-a716-446655440000" as SessionId;

/** A canonical-shape `MachinePresence`: one connected device. */
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

// ============================================================================
// Local IPC bridge (presence.subscribe push slice)
// ============================================================================

describe("presence.subscribe — push slice round-trip + wire-frame emission", () => {
  it("dispatches subscribe; returns `{subscriptionId}`; sub.next(update) routes as a `$/subscription/notify` frame validated against MachinePresenceSchema", async () => {
    // Arrange — a real StreamingPrimitive against a captured `send` mock.
    const registry = new MethodRegistryImpl();
    const send = vi.fn<(transportId: number, frame: JsonRpcNotification<unknown>) => void>();
    const primitive = new StreamingPrimitive({ registry, send });

    // Capture the upstream onUpdate callback the handler passes into
    // `subscribeToPresence`. Holder-object pattern: TS narrows a closure-
    // assigned `let foo: T | null = null` to `null` at outer reads; the
    // holder object preserves the property type across reads.
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

    // Act — dispatch with a transport-bound ctx.
    const transportId = 42;
    const ctx: HandlerContext = { transportId };
    const result = (await registry.dispatch(
      "presence.subscribe",
      {},
      ctx,
    )) as PresenceSubscribeResponse;

    // Assert — the response carries an opaque `subscriptionId` (RFC 9562 UUID).
    expect(typeof result.subscriptionId).toBe("string");
    expect(result.subscriptionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    expect(subscribeToPresence).toHaveBeenCalledTimes(1);
    expect(onUpdateHolder.current).not.toBeNull();

    // Wire-ordering invariant — drain the `setImmediate` replay boundary so
    // the init response lands first; no notify before the boundary.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(send).not.toHaveBeenCalled();

    // Act — drive a MachinePresence through the captured onUpdate. The handler
    // routes it to `sub.next(update)`, which validates against
    // `MachinePresenceSchema` (the streaming validate-before-send analog) and
    // emits a
    // `$/subscription/notify` frame on the captured `send`.
    const onUpdate = onUpdateHolder.current;
    if (onUpdate === null) throw new Error("unreachable — onUpdate captured above");
    const update = buildMachinePresence();
    onUpdate(update);

    // Assert — exactly one notify frame with the canonical wire shape.
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
    // The deps' `subscribeToPresence` fires an update SYNCHRONOUSLY during
    // setup (replay-window). The handler must buffer it and flush on the
    // `setImmediate` boundary so the `{subscriptionId}` response lands on
    // the wire BEFORE the notify — otherwise the notify hits the SDK's
    // unknown-id silent-drop branch.
    const registry = new MethodRegistryImpl();
    const send = vi.fn<(transportId: number, frame: JsonRpcNotification<unknown>) => void>();
    const primitive = new StreamingPrimitive({ registry, send });

    const syncUpdate = buildMachinePresence();
    const subscribeToPresence = vi.fn<PresenceSubscribeDeps["subscribeToPresence"]>((onUpdate) => {
      // Fire synchronously during the subscription-setup body.
      onUpdate(syncUpdate);
      return vi.fn<() => void>();
    });
    const deps: PresenceSubscribeDeps = { streamingPrimitive: primitive, subscribeToPresence };
    registerPresenceSubscribe(registry, deps);

    const ctx: HandlerContext = { transportId: 7 };
    await registry.dispatch("presence.subscribe", {}, ctx);

    // Immediately after dispatch resolves (response settled), no notify has
    // been emitted yet — the synchronously-fired update is buffered.
    expect(send).not.toHaveBeenCalled();

    // After the `setImmediate` boundary drains, the buffered update flushes.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(send).toHaveBeenCalledTimes(1);
    const call = send.mock.calls[0];
    if (call === undefined) throw new Error("unreachable");
    const params = call[1].params as SubscriptionNotifyParams<MachinePresence>;
    expect(params.value).toStrictEqual(syncUpdate);
  });

  it("a malformed pushed value throws StreamingValidationError from sub.next (MachinePresenceSchema validates before send)", async () => {
    // Drive a value that is NOT a valid MachinePresence through the captured
    // live-tail onUpdate. `sub.next(...)` validates against
    // `MachinePresenceSchema` and throws; the handler's live-tail catch
    // cancels the subscription and logs (it does NOT rethrow into the test).
    // We assert the validation throw directly via a primitive-level
    // subscription so the throw surfaces to the test (the handler swallows
    // its own live-tail throw by design — see presence-subscribe.ts).
    const registry = new MethodRegistryImpl();
    const send = vi.fn<(transportId: number, frame: JsonRpcNotification<unknown>) => void>();
    const primitive = new StreamingPrimitive({ registry, send });

    // Allocate a primitive-level subscription wired with the SAME per-value
    // schema the handler uses (`MachinePresenceSchema`). We assert the
    // validation throw directly here because the handler swallows its own
    // live-tail throw by design (cancel + log; see presence-subscribe.ts).
    const sub = primitive.createSubscription<MachinePresence>(99, MachinePresenceSchema);

    // A list carrying an unknown key fails `MachinePresenceSchema.safeParse`.
    const malformed = MALFORMED_PRESENCE;
    expect(() => sub.next(malformed)).toThrow(StreamingValidationError);
    // No frame was emitted — validation short-circuits before send.
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

    // No transportId on ctx — the handler throws a plain Error (maps to
    // -32603 on the wire); the upstream subscribe is NEVER reached.
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

// ============================================================================
// Push-slice crash guards (replay-flush + live-tail) + onCancel
// upstream-detach. Faithful presence analogs of the `session-subscribe.ts`
// regression tests (session-handlers.test.ts) — a regression dropping any
// of these branches would pass every push-slice test above.
// ============================================================================

describe("presence.subscribe — replay-flush + live-tail crash guards", () => {
  // Restore all `vi.spyOn(...)` instances after EACH test so a console.error
  // spy that survives a mid-test assertion failure doesn't leak into the next
  // test's stdout. The runtime-daemon's vitest.config does NOT set
  // `restoreMocks: true`, so explicit per-block hygiene is the right call
  // (mirrors the session-subscribe crash-guard block).
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("replay-flush: a malformed update in the replay buffer is caught; subscription canceled; daemon survives", async () => {
    // `subscribeToPresence` fires a MALFORMED update SYNCHRONOUSLY during
    // setup, so it lands in the handler's `replayBuffer` (not the live-tail
    // path). The setImmediate boundary then drains the buffer and the inner
    // `sub.next(update)` throws `StreamingValidationError`. Without the
    // replay-flush guard, that throw escapes setImmediate as uncaught and
    // vitest's uncaught-exception hook FAILS the test. With the guard, the
    // catch runs `sub.cancel()` + `console.error`.
    const registry = new MethodRegistryImpl();
    const send = vi.fn<(transportId: number, frame: JsonRpcNotification<unknown>) => void>();
    const primitive = new StreamingPrimitive({ registry, send });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const malformed = MALFORMED_PRESENCE;
    const subscribeToPresence = vi.fn<PresenceSubscribeDeps["subscribeToPresence"]>((onUpdate) => {
      // Fire SYNCHRONOUSLY — replay window. The buffered value flushes on
      // the setImmediate boundary and fails `MachinePresenceSchema`.
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

    // Daemon survived (we got here; no uncaught throw aborted the test). The
    // primitive's one-arg `cancelSubscription(id)` returns `false` because
    // `sub.cancel()` already ran inside the replay-flush catch, draining both
    // primitive maps.
    expect(primitive.cancelSubscription(result.subscriptionId)).toBe(false);
    // The malformed update did NOT propagate to the wire.
    expect(send).not.toHaveBeenCalled();
    // The tripwire fired: first arg the prefix (with the subscriptionId inlined
    // per the presence handler), second arg the StreamingValidationError.
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
    // `subscribeToPresence` captures `onUpdate` and returns immediately (no
    // synchronous replay). After we drain the setImmediate boundary,
    // `replayDrained === true`, so a subsequent `onUpdate(update)` lands the
    // live-tail guard site. Without the guard, the `sub.next(update)` throw
    // escapes the lambda as an uncaught exception.
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

    // The lambda is a synchronous call from this test stack; the live-tail
    // guard catches the throw and the call returns normally (cancel + log).
    // Wrap in expect().not.toThrow() so a dropped guard surfaces as a clean
    // failure rather than an uncaught exception that aborts the suite.
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
    // The handler-binding path registers the unsubscribe via
    // `sub.onCancel(unsubscribe)`; the primitive's wire-cancel path (the
    // registered `$/subscription/cancel` handler dispatching to
    // `cancelSubscription`) must fire it. Without the onCancel wire-up, the
    // entry would drain but the upstream presence-source watcher would leak.
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
    // Drain the replay-flush boundary so any post-init race is observable
    // before we cancel.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(unsubscribe).not.toHaveBeenCalled();

    // Dispatch the wire-cancel through the registered cancel handler (the same
    // path a real client's `$/subscription/cancel` notification walks). The
    // cancel handler verifies transport-scoped ownership BEFORE calling
    // `cancelSubscription`; matching `transportId` is required.
    const cancelResult = await registry.dispatch(
      "$/subscription/cancel",
      { subscriptionId: result.subscriptionId },
      { transportId },
    );

    expect((cancelResult as { canceled: boolean }).canceled).toBe(true);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("transport-disconnect (`cleanupTransport`) fires the upstream unsubscribe", async () => {
    // The disconnect path runs through the bootstrap orchestrator's composed
    // `onDisconnect` hook in production, which calls
    // `streamingPrimitive.cleanupTransport(transportId)`. Direct invocation
    // here models that hook firing.
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

    // The upstream watcher detached; without the onCancel wire-up it would
    // remain registered against the now-dead transport.
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("complete() does NOT fire the upstream unsubscribe (natural producer-driven termination is silent)", () => {
    // Capture the producer handle directly so the test can call `complete()`
    // on it (the handler returns the subscription via `createSubscription`; we
    // exercise the same producer surface here). By contract, `complete()` MUST
    // NOT fire onCancel handlers — the producer already knows the stream ended.
    const registry = new MethodRegistryImpl();
    const send = vi.fn<(transportId: number, frame: JsonRpcNotification<unknown>) => void>();
    const primitive = new StreamingPrimitive({ registry, send });
    const sub = primitive.createSubscription<MachinePresence>(31, MachinePresenceSchema);
    const unsubscribe = vi.fn<() => void>();
    sub.onCancel(unsubscribe);

    sub.complete();

    // The upstream watcher is NOT detached on natural completion. The hook
    // only fires on externally-imposed cancellation.
    expect(unsubscribe).not.toHaveBeenCalled();
  });
});
