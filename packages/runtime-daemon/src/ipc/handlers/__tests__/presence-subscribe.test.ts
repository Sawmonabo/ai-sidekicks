// `presence.subscribe` (PresenceUpdate push) handler + durable-emission test
// suite.
//
// Presence here is PER-DEVICE liveness of the one user's linked devices. The
// file covers TWO conceptually-distinct deliverables:
//
//   1. LOCAL IPC BRIDGE — the daemon-to-client `PresenceUpdate` push. Realized
//      as the notify side of a `presence.subscribe` subscription on the
//      streaming primitive (see presence-subscribe.ts for the streaming-design
//      rationale). Tests: round-trip through dispatch → `{subscriptionId}`; a
//      pushed `PresenceUpdate` becomes a `$/subscription/notify` frame
//      validated against `PresenceUpdateSchema`; `mutating: false`;
//      transportId required; duplicate-registration.
//
//   2. DURABLE PRESENCE EMISSION — `presence.online` / `idle` /
//      `reconnecting` / `offline` state-change events land in the daemon's
//      `session_events` log. The runtime trigger lives downstream (documented
//      as a deps-contract obligation on
//      `PresenceSubscribeDeps.subscribeToPresence`); THIS test proves the
//      canonical emission ARTIFACT round-trips to REAL `session_events` rows
//      through a real `better-sqlite3`-backed `SessionService`, and that the
//      projector forward-compat-skips them (replay-safe, snapshot unaffected).
//      Presence ROWS are never persisted — only the state-change EVENTS are.
//
// Invariants verified:
//   * Duplicate `registerPresenceSubscribe` is rejected at register-time.
//   * Streaming validate-before-send — every pushed `PresenceUpdate` is
//     validated against `PresenceUpdateSchema` before the
//     `$/subscription/notify` frame is sent; a malformed value throws
//     `StreamingValidationError` from `sub.next(...)`.
//   * Subscribe-init response precedes the first notification frame: updates
//     fired during setup buffer and flush on a `setImmediate` boundary after
//     the init `{subscriptionId}` response settles (also exercised by the
//     replay-flush + live-tail crash guards).
//   * Streaming-leak — `sub.onCancel(unsubscribe)` fires the upstream detach
//     on wire-cancel + transport-disconnect; `complete()` does NOT fire it.
// Plus the cross-cutting guard that an emitted presence row carries the
// category the contracts package assigns to its type, never one the emitter
// invented.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  HandlerContext,
  JsonRpcNotification,
  PresenceState,
  PresenceSubscribeResponse,
  PresenceUpdate,
  SessionEventType,
  SessionId,
  SubscriptionNotifyParams,
} from "@ai-sidekicks/contracts";
import {
  JSONRPC_VERSION,
  PresenceUpdateSchema,
  SESSION_EVENT_CATEGORY_BY_TYPE,
  SUBSCRIPTION_NOTIFY_METHOD,
} from "@ai-sidekicks/contracts";

import { MethodRegistryImpl, RegistryRegistrationError } from "../../registry.js";
import { StreamingPrimitive, StreamingValidationError } from "../../streaming-primitive.js";

import { openDatabase } from "../../../session/migration-runner.js";
import {
  SessionService,
  UnsignedPlaceholderAppendToken,
} from "../../../session/session-service.js";
import type { AppendableEvent } from "../../../session/types.js";

import { registerPresenceSubscribe, type PresenceSubscribeDeps } from "../presence-subscribe.js";

// ----------------------------------------------------------------------------
// Shared fixtures
// ----------------------------------------------------------------------------
//
// Static literal IDs chosen for human-readable failure output.

const TEST_SESSION_ID = "550e8400-e29b-41d4-a716-446655440000" as SessionId;

/**
 * Build a canonical-shape `PresenceUpdate` — `{sessionId, awarenessState:
 * Uint8Array}` (the serialized Yjs Awareness CRDT). The bytes are a small
 * deterministic buffer; their value is meaningless beyond passing
 * `PresenceUpdateSchema` (which accepts any `Uint8Array` instance).
 */
function buildPresenceUpdate(): PresenceUpdate {
  return {
    sessionId: TEST_SESSION_ID,
    awarenessState: new Uint8Array([1, 2, 3, 4]),
  };
}

// ============================================================================
// PART 1 — LOCAL IPC BRIDGE (presence.subscribe push slice)
// ============================================================================

describe("presence.subscribe — push slice round-trip + wire-frame emission", () => {
  it("dispatches subscribe; returns `{subscriptionId}`; sub.next(update) routes as a `$/subscription/notify` frame validated against PresenceUpdateSchema", async () => {
    // Arrange — a real StreamingPrimitive against a captured `send` mock.
    const registry = new MethodRegistryImpl();
    const send = vi.fn<(transportId: number, frame: JsonRpcNotification<unknown>) => void>();
    const primitive = new StreamingPrimitive({ registry, send });

    // Capture the upstream onUpdate callback the handler passes into
    // `subscribeToPresence`. Holder-object pattern: TS narrows a closure-
    // assigned `let foo: T | null = null` to `null` at outer reads; the
    // holder object preserves the property type across reads.
    const onUpdateHolder: { current: ((update: PresenceUpdate) => void) | null } = {
      current: null,
    };
    const unsubscribe = vi.fn<() => void>();
    const subscribeToPresence = vi.fn<PresenceSubscribeDeps["subscribeToPresence"]>(
      (sessionId, onUpdate) => {
        onUpdateHolder.current = onUpdate;
        return unsubscribe;
      },
    );
    const deps: PresenceSubscribeDeps = { streamingPrimitive: primitive, subscribeToPresence };
    registerPresenceSubscribe(registry, deps);

    // Act — dispatch with a transport-bound ctx.
    const transportId = 42;
    const ctx: HandlerContext = { transportId };
    const result = (await registry.dispatch(
      "presence.subscribe",
      { sessionId: TEST_SESSION_ID },
      ctx,
    )) as PresenceSubscribeResponse;

    // Assert — the response carries an opaque `subscriptionId` (RFC 9562 UUID).
    expect(typeof result.subscriptionId).toBe("string");
    expect(result.subscriptionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    // Assert — the deps' upstream callback ran with the request's sessionId.
    expect(subscribeToPresence).toHaveBeenCalledTimes(1);
    expect(subscribeToPresence).toHaveBeenCalledWith(TEST_SESSION_ID, expect.any(Function));
    expect(onUpdateHolder.current).not.toBeNull();

    // Wire-ordering invariant — drain the `setImmediate` replay boundary so
    // the init response lands first; no notify before the boundary.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(send).not.toHaveBeenCalled();

    // Act — drive a PresenceUpdate through the captured onUpdate. The handler
    // routes it to `sub.next(update)`, which validates against
    // `PresenceUpdateSchema` (the streaming validate-before-send analog) and
    // emits a
    // `$/subscription/notify` frame on the captured `send`.
    const onUpdate = onUpdateHolder.current;
    if (onUpdate === null) throw new Error("unreachable — onUpdate captured above");
    const update = buildPresenceUpdate();
    onUpdate(update);

    // Assert — exactly one notify frame with the canonical wire shape.
    expect(send).toHaveBeenCalledTimes(1);
    const call = send.mock.calls[0];
    if (call === undefined) throw new Error("unreachable");
    const [actualTransportId, frame] = call;
    expect(actualTransportId).toBe(transportId);
    expect(frame.jsonrpc).toBe(JSONRPC_VERSION);
    expect(frame.method).toBe(SUBSCRIPTION_NOTIFY_METHOD);
    const params = frame.params as SubscriptionNotifyParams<PresenceUpdate>;
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

    const syncUpdate = buildPresenceUpdate();
    const subscribeToPresence = vi.fn<PresenceSubscribeDeps["subscribeToPresence"]>(
      (_sessionId, onUpdate) => {
        // Fire synchronously during the subscription-setup body.
        onUpdate(syncUpdate);
        return vi.fn<() => void>();
      },
    );
    const deps: PresenceSubscribeDeps = { streamingPrimitive: primitive, subscribeToPresence };
    registerPresenceSubscribe(registry, deps);

    const ctx: HandlerContext = { transportId: 7 };
    await registry.dispatch("presence.subscribe", { sessionId: TEST_SESSION_ID }, ctx);

    // Immediately after dispatch resolves (response settled), no notify has
    // been emitted yet — the synchronously-fired update is buffered.
    expect(send).not.toHaveBeenCalled();

    // After the `setImmediate` boundary drains, the buffered update flushes.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(send).toHaveBeenCalledTimes(1);
    const call = send.mock.calls[0];
    if (call === undefined) throw new Error("unreachable");
    const params = call[1].params as SubscriptionNotifyParams<PresenceUpdate>;
    expect(params.value).toStrictEqual(syncUpdate);
  });

  it("a malformed pushed value throws StreamingValidationError from sub.next (PresenceUpdateSchema validates before send)", async () => {
    // Drive a value that is NOT a valid PresenceUpdate through the captured
    // live-tail onUpdate. `sub.next(...)` validates against
    // `PresenceUpdateSchema` and throws; the handler's live-tail catch
    // cancels the subscription and logs (it does NOT rethrow into the test).
    // We assert the validation throw directly via a primitive-level
    // subscription so the throw surfaces to the test (the handler swallows
    // its own live-tail throw by design — see presence-subscribe.ts).
    const registry = new MethodRegistryImpl();
    const send = vi.fn<(transportId: number, frame: JsonRpcNotification<unknown>) => void>();
    const primitive = new StreamingPrimitive({ registry, send });

    // Allocate a primitive-level subscription wired with the SAME per-value
    // schema the handler uses (`PresenceUpdateSchema`). We assert the
    // validation throw directly here because the handler swallows its own
    // live-tail throw by design (cancel + log; see presence-subscribe.ts).
    const sub = primitive.createSubscription<PresenceUpdate>(99, PresenceUpdateSchema);

    // A value missing `awarenessState` (and carrying an unknown key) fails
    // `PresenceUpdateSchema.safeParse`.
    const malformed = { sessionId: TEST_SESSION_ID, bogus: true } as unknown as PresenceUpdate;
    expect(() => sub.next(malformed)).toThrow(StreamingValidationError);
    // No frame was emitted — validation short-circuits before send.
    expect(send).not.toHaveBeenCalled();
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
    await expect(
      registry.dispatch("presence.subscribe", { sessionId: TEST_SESSION_ID }, {}),
    ).rejects.toThrow(/requires ctx\.transportId/);
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
// PART 1b — push-slice crash guards (replay-flush + live-tail) + onCancel
// upstream-detach. Faithful presence analogs of the `session-subscribe.ts`
// regression tests (session-handlers.test.ts) — a regression dropping any
// of these branches would pass every Part-1 test above.
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

    const malformed = { sessionId: TEST_SESSION_ID, bogus: true } as unknown as PresenceUpdate;
    const subscribeToPresence = vi.fn<PresenceSubscribeDeps["subscribeToPresence"]>(
      (_sessionId, onUpdate) => {
        // Fire SYNCHRONOUSLY — replay window. The buffered value flushes on
        // the setImmediate boundary and fails `PresenceUpdateSchema`.
        onUpdate(malformed);
        return () => undefined;
      },
    );
    const deps: PresenceSubscribeDeps = { streamingPrimitive: primitive, subscribeToPresence };
    registerPresenceSubscribe(registry, deps);

    const ctx: HandlerContext = { transportId: 7 };
    const result = (await registry.dispatch(
      "presence.subscribe",
      { sessionId: TEST_SESSION_ID },
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

    const onUpdateHolder: { current: ((update: PresenceUpdate) => void) | null } = {
      current: null,
    };
    const subscribeToPresence = vi.fn<PresenceSubscribeDeps["subscribeToPresence"]>(
      (_sessionId, onUpdate) => {
        onUpdateHolder.current = onUpdate;
        return () => undefined;
      },
    );
    const deps: PresenceSubscribeDeps = { streamingPrimitive: primitive, subscribeToPresence };
    registerPresenceSubscribe(registry, deps);

    const ctx: HandlerContext = { transportId: 7 };
    const result = (await registry.dispatch(
      "presence.subscribe",
      { sessionId: TEST_SESSION_ID },
      ctx,
    )) as PresenceSubscribeResponse;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const onUpdate = onUpdateHolder.current;
    if (onUpdate === null) throw new Error("unreachable — onUpdate captured above");

    // The lambda is a synchronous call from this test stack; the live-tail
    // guard catches the throw and the call returns normally (cancel + log).
    // Wrap in expect().not.toThrow() so a dropped guard surfaces as a clean
    // failure rather than an uncaught exception that aborts the suite.
    const malformed = { sessionId: TEST_SESSION_ID, bogus: true } as unknown as PresenceUpdate;
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
      { sessionId: TEST_SESSION_ID },
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
    await registry.dispatch("presence.subscribe", { sessionId: TEST_SESSION_ID }, ctx);
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
    const sub = primitive.createSubscription<PresenceUpdate>(31, PresenceUpdateSchema);
    const unsubscribe = vi.fn<() => void>();
    sub.onCancel(unsubscribe);

    sub.complete();

    // The upstream watcher is NOT detached on natural completion. The hook
    // only fires on externally-imposed cancellation.
    expect(unsubscribe).not.toHaveBeenCalled();
  });
});

// ============================================================================
// PART 2 — DURABLE PRESENCE-STATE-CHANGE EMISSION (real session_events)
// ============================================================================
//
// Per-test SQLite DB under os.tmpdir() (the canonical
// `session-service.test.ts` harness: `openDatabase` runs pragmas +
// migrations, `new SessionService(db)`, afterEach closes + unlinks).

const EMISSION_SESSION_ID = "01J0SE5510NN5J5J5J5J5J5J5J";
const EMISSION_OWNER_ID = "01J0PA0000NN5J5J5J5J5J5J5J";
const EMISSION_DEVICE_ID = "device-abc-123";

interface EmissionContext {
  db: DatabaseType;
  service: SessionService;
  tmpDir: string;
}

/**
 * Bootstrap `session.created` event at sequence=0 — every session log must
 * open with one (the projector's `replay` requires it). Mirrors the
 * `session-service.test.ts` fixture.
 */
function makeBootstrapCreatedEvent(): AppendableEvent {
  return {
    id: "01J0EV0000NN5J5J5J5J5J5J5J",
    sessionId: EMISSION_SESSION_ID,
    sequence: 0,
    occurredAt: "2026-04-27T12:00:00.000Z",
    monotonicNs: 1_000_000_000n,
    category: "session_lifecycle",
    type: "session.created",
    actor: EMISSION_OWNER_ID,
    payload: { sessionId: EMISSION_SESSION_ID, name: "presence-test-session" },
    correlationId: null,
    causationId: null,
    version: "1.0",
  };
}

/**
 * Build the canonical durable presence-state-change `AppendableEvent` for one
 * transition. This is the EXACT shape the downstream emission contract
 * (documented on `PresenceSubscribeDeps.subscribeToPresence`) obligates the
 * substrate to append:
 *   * type:     "presence.<newState>"
 *   * category: whatever the contracts package assigns that type — LOOKED UP,
 *               never restated, so a fixture can never enshrine a category the
 *               canonical assignment has moved away from
 *   * payload:  {sessionId, deviceId, previousState?, newState}
 *   * actor:    null — the daemon's liveness watcher OBSERVES the transition;
 *               no one requested it
 */
function makePresenceEvent(
  sequence: number,
  newState: PresenceState,
  previousState: PresenceState | undefined,
): AppendableEvent {
  const type: SessionEventType = `presence.${newState}`;
  const category = SESSION_EVENT_CATEGORY_BY_TYPE.get(type);
  if (category === undefined) {
    throw new Error(
      `presence event type ${type} is absent from SESSION_EVENT_CATEGORY_BY_TYPE; the emission contract has no canonical category to write`,
    );
  }
  const payload: Record<string, unknown> = {
    sessionId: EMISSION_SESSION_ID,
    deviceId: EMISSION_DEVICE_ID,
    newState,
  };
  // `previousState` is OPTIONAL — absent on the very first transition for a
  // device. Omit the key entirely when undefined (do not write
  // `previousState: undefined`) so the persisted JSON matches the contract's
  // `previousState?` optionality.
  if (previousState !== undefined) {
    payload["previousState"] = previousState;
  }
  return {
    id: `01J0EVP00NN5J5J5J5J5J5J0${sequence.toString()}`,
    sessionId: EMISSION_SESSION_ID,
    sequence,
    occurredAt: "2026-04-27T12:05:00.000Z",
    monotonicNs: BigInt(2_000_000_000 + sequence),
    category,
    type,
    actor: null,
    payload,
    correlationId: null,
    causationId: null,
    version: "1.0",
  };
}

describe("durable presence-state-change events round-trip to real session_events rows", () => {
  // SQLite setup is scoped to THIS block (not module scope) so the Part 1
  // push-slice tests — which never touch durable storage — do not needlessly
  // run mkdtempSync + openDatabase (full migration) + close + rmSync.
  let emissionContext: EmissionContext;

  beforeEach(() => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ai-sidekicks-presence-test-"));
    const dbPath = join(tmpDir, "test.db");
    // Canonical factory — same code path production daemon takes (pragmas +
    // migrations, in order).
    const db = openDatabase(dbPath);
    // Test-only opt-in to the guarded append path — this block seeds presence
    // rows through it (session-service.test.ts pins the guard itself).
    emissionContext = {
      db,
      service: new SessionService(db, {
        allowUnsignedPlaceholderAppend: UnsignedPlaceholderAppendToken.forTestsOnly(),
      }),
      tmpDir,
    };
  });

  afterEach(() => {
    if (emissionContext.db.open) {
      emissionContext.db.close();
    }
    rmSync(emissionContext.tmpDir, { recursive: true, force: true });
  });

  it("appends all 4 lifecycle states (online incl. recovery, idle, reconnecting, offline) and reads them back with the canonical category, type, and payload", () => {
    const { service } = emissionContext;

    // sequence 0 — bootstrap. Then the FULL presence lifecycle, including
    // BOTH `online`-from-initial-connect (no previousState) AND
    // `online`-from-recovery (previousState: "reconnecting"). This proves
    // the emission shape can represent all four states AND that `online`
    // is reachable as both the initial state and a recovery state — i.e.
    // it is NOT a degradation-only (online→reconnecting→offline) shape.
    service.append(makeBootstrapCreatedEvent());
    service.append(makePresenceEvent(1, "online", undefined)); // initial connect
    service.append(makePresenceEvent(2, "idle", "online")); // activity → idle
    service.append(makePresenceEvent(3, "reconnecting", "idle")); // WS drop
    service.append(makePresenceEvent(4, "offline", "reconnecting")); // grace expired
    service.append(makePresenceEvent(5, "online", "reconnecting")); // RECOVERY back to online

    const rows = service.readEvents(EMISSION_SESSION_ID);

    // The 5 presence rows (sequences 1-5) all carry the canonical category.
    const presenceRows = rows.filter((r) => r.sequence >= 1);
    expect(presenceRows).toHaveLength(5);

    // CRITICAL guard — every presence row carries the category the contracts
    // package assigns to its own type, and that value survives the SQLite
    // round-trip unchanged. An emitter that invents a category instead of
    // looking one up breaks the integrity hash chain rather than failing a
    // parse, so this is pinned against the registry and never against a
    // literal.
    for (const row of presenceRows) {
      expect(row.category).toBe(SESSION_EVENT_CATEGORY_BY_TYPE.get(row.type as SessionEventType));
      expect(row.category).not.toBe("presence");
    }

    // The 4 canonical type strings are all present (online appears twice —
    // initial + recovery).
    expect(presenceRows.map((r) => r.type)).toEqual([
      "presence.online",
      "presence.idle",
      "presence.reconnecting",
      "presence.offline",
      "presence.online",
    ]);

    // Payload shape: the initial `online` omits `previousState`; the recovery
    // `online` carries `previousState: "reconnecting"` and
    // `newState: "online"`. The subject is the DEVICE — there is no per-person
    // axis, because every device on a session belongs to the one user.
    const initialOnline = presenceRows.find((r) => r.sequence === 1);
    if (initialOnline === undefined) throw new Error("unreachable");
    expect(initialOnline.payload).toStrictEqual({
      sessionId: EMISSION_SESSION_ID,
      deviceId: EMISSION_DEVICE_ID,
      newState: "online",
    });
    // `previousState` key is genuinely ABSENT on the first transition (not
    // present-with-undefined) — JSON round-trip drops undefined keys, and we
    // omit it at write time.
    expect("previousState" in initialOnline.payload).toBe(false);

    const recoveryOnline = presenceRows.find((r) => r.sequence === 5);
    if (recoveryOnline === undefined) throw new Error("unreachable");
    expect(recoveryOnline.payload).toStrictEqual({
      sessionId: EMISSION_SESSION_ID,
      deviceId: EMISSION_DEVICE_ID,
      previousState: "reconnecting",
      newState: "online",
    });

    // The offline row's payload likewise carries the full transition.
    const offline = presenceRows.find((r) => r.type === "presence.offline");
    if (offline === undefined) throw new Error("unreachable");
    expect(offline.payload["newState"]).toBe("offline");
    expect(offline.payload["previousState"]).toBe("reconnecting");
  });

  it("the projector forward-compat-skips presence rows on replay — snapshot is unaffected (no presence data in the projection; replay-safe)", () => {
    const { service } = emissionContext;

    service.append(makeBootstrapCreatedEvent());
    service.append(makePresenceEvent(1, "online", undefined));
    service.append(makePresenceEvent(2, "idle", "online"));
    service.append(makePresenceEvent(3, "reconnecting", "idle"));
    service.append(makePresenceEvent(4, "offline", "reconnecting"));

    const snapshot = service.replay(EMISSION_SESSION_ID);
    expect(snapshot).not.toBeNull();
    if (snapshot === null) return;

    // Replay consumed every row WITHOUT throwing (the projector's `default`
    // case forward-compat-skips unknown event types) and advanced
    // `asOfSequence` to the last presence row.
    expect(snapshot.asOfSequence).toBe(4);

    // The presence rows contributed NOTHING to the projection — the snapshot
    // carries only the bootstrap-derived owner and the synthesized main
    // channel. No device list, no presence state, no extra rows leaked into
    // the durable projection: presence is ephemeral, and only the
    // state-change events are durable, and they project to nothing.
    expect(snapshot.sessionId).toBe(EMISSION_SESSION_ID);
    expect(snapshot.state).toBe("provisioning");
    expect(snapshot.ownerActor).toBe(EMISSION_OWNER_ID);
    // Exactly the synthesized "main" channel — presence events added no
    // channels.
    expect(snapshot.channels).toHaveLength(1);
  });
});
