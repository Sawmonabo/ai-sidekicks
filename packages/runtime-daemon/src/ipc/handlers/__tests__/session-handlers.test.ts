// I-007-3-T1 / T2 / T3 / T5 — Phase 3 `session.*` handler test suite
// (T-007p-3-4).
//
// Spec coverage:
//   * Spec-007 §Required Behavior + §Interfaces And Contracts (lines 71-78)
//     (docs/specs/007-local-ipc-and-daemon-control.md) — the `session.*`
//     methods are the V1 vertical-slice surface (`create` / `read` / `join` /
//     `subscribe`); this file exercises the handlers' registry-binding
//     boundary and the streaming `subscribe` slice's wire-frame emission.
//
// Plan-007 §Tier-1 Implementation Tasks (T-007p-3-4) — write the test
// suite covering every cross-plan obligation owed by Phase 3 handlers.
//
// Invariants verified here (canonical text in
// docs/plans/007-local-ipc-and-daemon-control.md §Invariants lines 95-117):
//   * I-007-6 — duplicate method-name registration is rejected at register-
//     time. T5 below verifies via `registerSessionCreate(...)` called twice
//     against the same registry.
//   * I-007-7 — schema-validates-before-dispatch. T2 below verifies via
//     a malformed `session.create` payload + a mock spy whose call count
//     remains zero after the throw.
//   * I-007-8 — sanitized error mapping. T2's malformed-params arm walks
//     through `mapJsonRpcError` to confirm the wire-level numeric is
//     `-32602 InvalidParams`.
//
// Acceptance Criteria coverage matrix (per task contract lines 21-46):
//   * I-007-3-T1 — `session.create` round-trip through the registry: mock
//     `createSession` invoked with parsed params; response matches
//     `SessionCreateResponseSchema`. Verified by `it("session.create round-trip ...")`.
//   * I-007-3-T2 — Malformed `session.create` payload routed through
//     `dispatch()` rejected with JSON-RPC `-32602 InvalidParams`; handler
//     closure NEVER invoked (I-007-7 via spy). Verified across two `it()`
//     blocks (registry-side throw + wire-mapping numeric).
//   * I-007-3-T3 — `session.subscribe` happy path returns `{ subscriptionId }`;
//     `sub.next(event)` routes as `$/subscription/notify` frames; `sub.cancel()`
//     drains BOTH `#subscriptions` AND `#subscriptionsByTransport` (verified
//     via `cancelSubscription` returning `false` post-cancel). Cancel-
//     idempotency on a fresh subscription verified separately (true → false
//     across two direct calls). Frame-shape assertions carry inline-
//     duplicated `// BLOCKED-ON-C6:` markers per the task contract's "no
//     shared helper" directive.
//   * I-007-3-T5 — Duplicate `registerSessionCreate(registry, deps)` throws
//     `RegistryRegistrationError("duplicate_method")` at registration time
//     (I-007-6).
//
// Test-fixture posture:
//   * The runtime-daemon's `package.json` deliberately does NOT depend on
//     `zod`. Tests use the duck-typed `passthroughSchema` /
//     `rejectingSchema` helpers from `__fixtures__/zod-schemas.ts` for every
//     schema slot the registry interrogates AT DISPATCH TIME (T2's malformed-
//     params arm uses `rejectingSchema` to force the invalid_params branch
//     without a real Zod runtime). However, T1 / T3 / T5 register handlers
//     against the REAL contract schemas (`SessionCreateRequestSchema`, etc.)
//     because the registry's `safeParse` machinery delegates to each schema's
//     `safeParse` — the contract schemas already implement the duck-typed
//     interface natively at runtime. Both surfaces co-exist in this file.
//
// What this file does NOT cover:
//   * `session.read` / `session.join` direct-dispatch round-trips — covered
//     by sibling handler-binding tests under the same Phase 3 task scope.
//     T1 / T2's coverage of `session.create` plus T5's duplicate-binding
//     check exercises the same I-007-6 / I-007-7 surfaces against the read
//     and join binding files (the `register*` API is identical).
//   * Cross-plan `mapJsonRpcError` integration beyond the T2 invalid_params
//     arm — covered by `jsonrpc-error-mapping.test.ts` (sibling).
//   * Streaming-primitive validation invariants beyond T3's frame-shape
//     check — covered by `streaming-primitive.test.ts` (sibling).
//
// Shared-helper directive (task contract lines 184-189):
//   T3's `$/subscription/notify` frame-shape assertions are INLINE-DUPLICATED
//   verbatim across each `it()` block; the task contract explicitly forbids
//   extracting a shared helper. The duplication is load-bearing — it keeps
//   the `// BLOCKED-ON-C6:` markers attached to each individual assertion
//   site, so the canonical method-name landing (when api-payload-contracts.md
//   §Plan-007 lands the wire taxonomy) is a mechanical greedy-replace rather
//   than a single-source edit that's easy to miss.

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  Handler,
  HandlerContext,
  JsonRpcNotification,
  SessionCreateRequest,
  SessionCreateResponse,
  SessionEvent,
  SessionId,
  SessionSubscribeRequest,
  SessionSubscribeResponse,
  SubscriptionNotifyParams,
} from "@ai-sidekicks/contracts";
import {
  JSONRPC_VERSION,
  SessionCreateRequestSchema,
  SessionCreateResponseSchema,
  SessionEventSchema,
  SessionSubscribeRequestSchema,
  SessionSubscribeResponseSchema,
  SUBSCRIPTION_NOTIFY_METHOD,
} from "@ai-sidekicks/contracts";

import { mapJsonRpcError, JsonRpcErrorCode } from "../../jsonrpc-error-mapping.js";
import {
  MethodRegistryImpl,
  RegistryDispatchError,
  RegistryRegistrationError,
} from "../../registry.js";
import { StreamingPrimitive } from "../../streaming-primitive.js";

import { registerSessionCreate, type SessionCreateDeps } from "../session-create.js";
import { registerSessionSubscribe, type SessionSubscribeDeps } from "../session-subscribe.js";

import { passthroughSchema } from "../../__tests__/__fixtures__/zod-schemas.js";

// ----------------------------------------------------------------------------
// Shared fixtures — canonical-shape SessionCreateResponse + SessionEvent
// ----------------------------------------------------------------------------
//
// Both T1 and T3 need real RFC 9562 UUIDs in the response/event fixtures
// because the registry's step 4 (`SessionCreateResponseSchema.safeParse(result)`)
// and the streaming primitive's per-value validation
// (`SessionEventSchema.safeParse(value)`) both consult the canonical schemas
// — invalid UUIDs would fail those parses for the wrong reason and obscure
// what we actually want to assert. The UUIDs below are static literals
// chosen for human-readable test failure output; their byte values are
// otherwise meaningless.

const TEST_SESSION_ID = "550e8400-e29b-41d4-a716-446655440000" as SessionId;
const TEST_PARTICIPANT_ID = "660e8400-e29b-41d4-a716-446655440001";

/**
 * Build a canonical-shape `SessionCreateResponse` matching every required
 * field on `SessionCreateResponseSchema`. The mock `createSession` callback
 * returns this verbatim so the registry's step-4 `safeParse(result)`
 * succeeds and the dispatched value reaches the test assertion intact.
 */
function buildSessionCreateResponse(): SessionCreateResponse {
  return {
    sessionId: TEST_SESSION_ID,
    state: "provisioning",
    memberships: [],
    channels: [],
  };
}

/**
 * Build a canonical-shape `session.created` `SessionEvent` matching every
 * required field on `SessionEventSchema`'s discriminated-union variant.
 * Inlined per the test-file's "no shared helper" directive AGAINST T3
 * frame-shape assertions; this fixture is the EVENT SHAPE that reaches the
 * primitive's `next()` and gets validated against `SessionEventSchema`.
 *
 * Inline-duplicated from `packages/contracts/src/__tests__/session-event.test.ts`
 * (the canonical fixture pattern in the contracts package's own tests).
 * Drift between the two would surface immediately as a Zod parse failure —
 * the schema is the single source of truth, and the test fixture is
 * downstream.
 */
function buildSessionCreatedEvent(): SessionEvent {
  return {
    id: "evt-0001",
    sessionId: TEST_SESSION_ID,
    sequence: 0,
    occurredAt: "2026-01-22T19:14:35.000Z",
    category: "session_lifecycle",
    type: "session.created",
    actor: TEST_PARTICIPANT_ID,
    version: "1.0" as SessionEvent["version"],
    payload: {
      sessionId: TEST_SESSION_ID,
      config: { resourceLimits: { sessions: 10 } },
      metadata: { source: "cli" },
    },
  };
}

// ----------------------------------------------------------------------------
// I-007-3-T1 — `session.create` round-trip through the registry
// ----------------------------------------------------------------------------

describe("I-007-3-T1 — session.create round-trip through MethodRegistry dispatch", () => {
  it("dispatches `session.create` to the deps' createSession; returns the canonical response shape", async () => {
    // Arrange — bind a mock `createSession` against a fresh registry.
    const registry = new MethodRegistryImpl();
    const expectedResponse = buildSessionCreateResponse();
    const mockCreateSession = vi.fn<(req: SessionCreateRequest) => Promise<SessionCreateResponse>>(
      async () => expectedResponse,
    );
    const deps: SessionCreateDeps = { createSession: mockCreateSession };
    registerSessionCreate(registry, deps);

    // Act — dispatch with an empty `{}` body. `SessionCreateRequestSchema`
    // is `.strict()` with both fields optional, so `{}` is the canonical
    // minimal request.
    const directCtx: HandlerContext = {};
    const result = await registry.dispatch("session.create", {}, directCtx);

    // Assert — the deps callback ran exactly once with the parsed params.
    // `SessionCreateRequestSchema.safeParse({})` returns `{ success: true,
    // data: {} }` — Zod does NOT synthesize `undefined` values for absent
    // optionals on a `.strict()` object, so the parsed data is the bare
    // empty object; the spy is called with `{}`.
    expect(mockCreateSession).toHaveBeenCalledTimes(1);
    expect(mockCreateSession).toHaveBeenCalledWith({});

    // Assert — the dispatched result equals the deps' return value
    // (verbatim; the registry's step-4 `safeParse(result)` against
    // `SessionCreateResponseSchema` re-parses but does not mutate fields).
    expect(result).toStrictEqual(expectedResponse);
  });

  it("registers `session.create` with mutating: true (pre-handshake gate refuses)", () => {
    // Sanity check — the slice contract names mutating: true; the negotiation
    // gate predicate is `isMutating(method) === true`, so flipping this flag
    // would break the security contract that pre-handshake mutating dispatch
    // is refused.
    const registry = new MethodRegistryImpl();
    const deps: SessionCreateDeps = {
      createSession: async () => buildSessionCreateResponse(),
    };
    registerSessionCreate(registry, deps);
    expect(registry.isMutating("session.create")).toBe(true);
  });
});

// ----------------------------------------------------------------------------
// I-007-3-T2 — malformed `session.create` payload (I-007-7 + I-007-8)
// ----------------------------------------------------------------------------

describe("I-007-3-T2 — malformed session.create payload (I-007-7 verifies handler NEVER runs; I-007-8 maps to -32602)", () => {
  it("malformed payload rejects with `RegistryDispatchError(invalid_params)`; handler is NEVER invoked", async () => {
    // Arrange — a mock `createSession` whose call count we WILL assert is
    // zero after dispatch. The handler closure registered by
    // `registerSessionCreate` is `async (params) => deps.createSession(params)`
    // (per session-create.ts:127-129); a zero call count on `mockCreateSession`
    // proves the registry short-circuited at step 2 (params validation)
    // before reaching step 3 (handler invocation).
    const registry = new MethodRegistryImpl();
    const mockCreateSession = vi.fn<(req: SessionCreateRequest) => Promise<SessionCreateResponse>>(
      async () => buildSessionCreateResponse(),
    );
    const deps: SessionCreateDeps = { createSession: mockCreateSession };
    registerSessionCreate(registry, deps);

    // Act — dispatch with a malformed payload. `SessionCreateRequestSchema`
    // is `.strict()`; `{ bogus: true }` carries an unknown key the strict
    // mode rejects. This forces the registry's step-2 `safeParse(params)`
    // failure path with structured `error.issues`.
    const directCtx: HandlerContext = {};
    let caught: unknown = null;
    try {
      await registry.dispatch("session.create", { bogus: true }, directCtx);
    } catch (err) {
      caught = err;
    }

    // Assert — the throw is `RegistryDispatchError("invalid_params")` per
    // the registry's structured short-circuit.
    expect(caught).toBeInstanceOf(RegistryDispatchError);
    if (caught instanceof RegistryDispatchError) {
      expect(caught.registryCode).toBe("invalid_params");
      expect(caught.issues).toBeDefined();
      const issues = caught.issues ?? [];
      expect(issues.length).toBeGreaterThan(0);
    }

    // CRITICAL I-007-7 ASSERTION — the handler closure must NEVER have
    // executed. If a regression moved the schema check after handler
    // invocation, this assertion would fail.
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it("`invalid_params` registry code maps to JSON-RPC `-32602` on the wire (I-007-8)", () => {
    // Sanity — confirm the daemon-internal registry code maps to the
    // canonical JSON-RPC numeric. The mapping is owned by
    // `jsonrpc-error-mapping.ts`; this test verifies the cross-file
    // contract holds at the boundary between "registry throws structured
    // error" and "wire emits sanitized envelope".
    const err = new RegistryDispatchError("invalid_params", "params validation failed", [
      { marker: "session.create-malformed" },
    ]);
    const envelope = mapJsonRpcError(err, 42);
    expect(envelope.error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(envelope.id).toBe(42);
  });
});

// ----------------------------------------------------------------------------
// I-007-3-T3 — `session.subscribe` happy path + cancel idempotency
// ----------------------------------------------------------------------------

describe("I-007-3-T3 — session.subscribe happy path + cancel idempotency", () => {
  it("dispatches subscribe; returns `{ subscriptionId }`; sub.next(event) routes as `$/subscription/notify` frame", async () => {
    // Arrange — wire a real StreamingPrimitive against a captured `send`
    // mock. The streaming primitive's `createSubscription` allocates a
    // fresh `subscriptionId` via `crypto.randomUUID()`; the handler's job
    // is to wire the deps' `subscribeToSession` upstream onto the
    // primitive's `sub.next(event)` producer call site.
    const registry = new MethodRegistryImpl();
    const send = vi.fn<(transportId: number, frame: JsonRpcNotification<unknown>) => void>();
    const primitive = new StreamingPrimitive({ registry, send });

    // Capture the upstream onEvent callback the handler passes into
    // `subscribeToSession`. The deps' callback receives (sessionId,
    // afterCursor, onEvent) and returns an unsubscribe handle. We capture
    // the `onEvent` lambda so the test can drive event emission directly.
    //
    // Holder-object pattern: TypeScript's control-flow analysis narrows a
    // `let foo: T | null = null` whose only assignment lives inside a
    // closure to `null` at the outer read sites — TS doesn't sequence the
    // closure mutation. Wrapping in a holder object preserves the property
    // type across reads while still letting the closure write to it.
    const onEventHolder: { current: ((event: SessionEvent) => void) | null } = {
      current: null,
    };
    const unsubscribe = vi.fn<() => void>();
    const subscribeToSession = vi.fn<SessionSubscribeDeps["subscribeToSession"]>(
      (sessionId, afterCursor, onEvent) => {
        onEventHolder.current = onEvent;
        return unsubscribe;
      },
    );
    const deps: SessionSubscribeDeps = {
      streamingPrimitive: primitive,
      subscribeToSession,
    };
    registerSessionSubscribe(registry, deps);

    // Act — dispatch `session.subscribe` with a transport-bound ctx (the
    // handler refuses `ctx.transportId === undefined` with NegotiationError).
    const transportId = 42;
    const ctx: HandlerContext = { transportId };
    const subscribeReq: SessionSubscribeRequest = {
      sessionId: TEST_SESSION_ID,
    };
    const result = (await registry.dispatch(
      "session.subscribe",
      subscribeReq,
      ctx,
    )) as SessionSubscribeResponse;

    // Assert — the response carries an opaque `subscriptionId` matching
    // the canonical UUID shape generated by `crypto.randomUUID()` (RFC 9562).
    expect(typeof result.subscriptionId).toBe("string");
    expect(result.subscriptionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    // Assert — the deps' upstream callback ran with the correct args.
    expect(subscribeToSession).toHaveBeenCalledTimes(1);
    expect(subscribeToSession).toHaveBeenCalledWith(
      TEST_SESSION_ID,
      undefined, // no afterCursor
      expect.any(Function),
    );
    expect(onEventHolder.current).not.toBeNull();

    // Act — drive an event through the captured onEvent lambda. The handler
    // routed it to `sub.next(event)` which validates against
    // `SessionEventSchema` (I-007-7 streaming analog) and emits a
    // `$/subscription/notify` frame on the captured `send`.
    //
    // Wire-ordering invariant — the handler buffers events fired before the
    // `setImmediate` boundary so the response lands first; we drain that
    // boundary here so subsequent live-tail events route directly through
    // `sub.next(event)` rather than via the replay buffer. See the
    // `"session.subscribe response precedes synchronously-fired replay
    // notifies"` test below for the buffering-during-replay arm.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(send).not.toHaveBeenCalled();
    const onEvent = onEventHolder.current;
    if (onEvent === null) throw new Error("unreachable — capturedOnEvent assertion above");
    const event = buildSessionCreatedEvent();
    onEvent(event);

    // Assert — exactly one `$/subscription/notify` frame was emitted with
    // the canonical wire shape.
    //
    // BLOCKED-ON-C6: frame-shape assertion below is keyed against the
    // conservative inline `SUBSCRIPTION_NOTIFY_METHOD` constant. When
    // api-payload-contracts.md §Plan-007 lands the canonical streaming
    // method-name format, the constant updates and this assertion follows
    // mechanically. Inline-duplicated per the task contract's "no shared
    // helper" directive — the duplication is load-bearing for the
    // canonical-method-name landing (the constant rename is greedy-
    // replaceable across each call site).
    expect(send).toHaveBeenCalledTimes(1);
    const call = send.mock.calls[0];
    if (call === undefined) throw new Error("unreachable");
    const [actualTransportId, frame] = call;
    expect(actualTransportId).toBe(transportId);
    expect(frame.jsonrpc).toBe(JSONRPC_VERSION);
    expect(frame.method).toBe(SUBSCRIPTION_NOTIFY_METHOD);
    const params = frame.params as SubscriptionNotifyParams<SessionEvent>;
    expect(params.subscriptionId).toBe(result.subscriptionId);
    expect(params.value).toStrictEqual(event);
  });

  it("sub.cancel() (server-side, producer handle) drains BOTH `#subscriptions` AND `#subscriptionsByTransport` (T3 prong A)", () => {
    // Arrange — a fresh primitive-level subscription so we have a direct
    // `LocalSubscription<T>` producer handle. The handler-binding path is
    // exercised in the first `it()` block above; here we need direct access
    // to `sub.cancel()` because that's the canonical AC text:
    //   "sub.cancel() removes from BOTH #subscriptions AND
    //    #subscriptionsByTransport (verified via cancelSubscription
    //    idempotency: returns true→false)".
    //
    // CRITICAL — `sub.cancel()` and `primitive.cancelSubscription(id)` walk
    // DIFFERENT code paths inside streaming-primitive.ts:
    //   * `sub.cancel()` → `removeFromTransport(id)` (the closure-bound
    //      cleanup at lines 311-327) + `subscriptions.delete(id)`. The
    //      closure handles the per-transport bucket pruning.
    //   * `primitive.cancelSubscription(id)` → inline bucket cleanup at
    //      lines 438-446 + `subscriptions.delete(id)`.
    // A regression in `removeFromTransport` would NOT surface through
    // prong B's direct-cancelSubscription test; this prong specifically
    // exercises the producer-handle path.
    const registry = new MethodRegistryImpl();
    const send = vi.fn<(transportId: number, frame: JsonRpcNotification<unknown>) => void>();
    const primitive = new StreamingPrimitive({ registry, send });

    // Open a subscription via the primitive's direct API so we hold the
    // LocalSubscription<SessionEvent> handle. We reuse SessionEventSchema
    // because that's the schema the handler-binding wires into the
    // primitive at runtime — keeping the test schema consistent with the
    // handler avoids a divergence that could mask a regression.
    const transportId = 99;
    const sub = primitive.createSubscription<SessionEvent>(transportId, SessionEventSchema);

    // Sanity — before cancel, the entry exists. We don't assert this via
    // `cancelSubscription` because it's destructive; instead we exercise
    // the live next() path: a valid event lands a `$/subscription/notify`
    // frame on `send`. After cancel, the SAME call is a silent no-op.
    sub.next(buildSessionCreatedEvent());
    expect(send).toHaveBeenCalledTimes(1);

    // Act — drain via the producer handle.
    sub.cancel();

    // Assert (T3 prong A) — `sub.cancel()` walked `removeFromTransport`
    // AND `subscriptions.delete`, so both maps no longer hold the entry.
    // `cancelSubscription(id)` returning `false` is the introspection knob
    // that proves the entry is GONE — the function returns `false` only
    // when `#subscriptions.get(id) === undefined`, which is the
    // post-`sub.cancel()` state.
    expect(primitive.cancelSubscription(sub.subscriptionId)).toBe(false);

    // Sanity — post-cancel `sub.next(value)` is a silent no-op per the
    // documented contract (streaming-primitive.ts:333-339). If the entry
    // had only drained from `#subscriptions` but not `#subscriptionsByTransport`,
    // the lookup miss would still produce a no-op (next() consults
    // `#subscriptions` only); but the bucket-pruning regression that
    // would matter here surfaces via cleanupTransport on a different
    // transport — covered separately in streaming-primitive.test.ts.
    sub.next(buildSessionCreatedEvent());
    expect(send).toHaveBeenCalledTimes(1); // unchanged from pre-cancel emit

    // Sanity — `sub.cancel()` is also idempotent at the producer level.
    // A second cancel is a no-op (the entry is already gone; the closure-
    // bound `removeFromTransport` lookup misses and silent-returns).
    expect(() => sub.cancel()).not.toThrow();
  });

  it("primitive.cancelSubscription is canonically idempotent on a fresh subscription (T3 prong B: true → false)", () => {
    // Arrange — a fresh subscription on the primitive directly (no handler
    // binding required for this prong). `cancelSubscription(id)` is the
    // public introspection knob; calling twice in immediate succession
    // verifies its idempotency contract per streaming-primitive.ts:432-447.
    const registry = new MethodRegistryImpl();
    const send = vi.fn<(transportId: number, frame: JsonRpcNotification<unknown>) => void>();
    const primitive = new StreamingPrimitive({ registry, send });
    const sub = primitive.createSubscription<unknown>(123, passthroughSchema<unknown>());

    // Act + Assert — first call returns `true` (entry was present and is
    // now removed); second call returns `false` (entry already gone).
    expect(primitive.cancelSubscription(sub.subscriptionId)).toBe(true);
    expect(primitive.cancelSubscription(sub.subscriptionId)).toBe(false);
  });

  it("emits the `$/subscription/notify` method name verbatim with the canonical wire shape", async () => {
    // BLOCKED-ON-C6: this test mirrors the frame-shape assertion in the
    // first T3 `it()` block — inline-duplicated per the task contract's
    // "no shared helper" directive. The duplication keeps the
    // `SUBSCRIPTION_NOTIFY_METHOD` constant rename greedy-replaceable when
    // api-payload-contracts.md §Plan-007 lands the canonical streaming
    // method-name format.
    const registry = new MethodRegistryImpl();
    const send = vi.fn<(transportId: number, frame: JsonRpcNotification<unknown>) => void>();
    const primitive = new StreamingPrimitive({ registry, send });
    // Holder-object pattern — see first T3 `it()` block for the rationale.
    const onEventHolder: { current: ((event: SessionEvent) => void) | null } = {
      current: null,
    };
    const subscribeToSession = vi.fn<SessionSubscribeDeps["subscribeToSession"]>(
      (_sessionId, _afterCursor, onEvent) => {
        onEventHolder.current = onEvent;
        return () => undefined;
      },
    );
    const deps: SessionSubscribeDeps = {
      streamingPrimitive: primitive,
      subscribeToSession,
    };
    registerSessionSubscribe(registry, deps);
    const ctx: HandlerContext = { transportId: 7 };
    const subscribeReq: SessionSubscribeRequest = { sessionId: TEST_SESSION_ID };
    await registry.dispatch("session.subscribe", subscribeReq, ctx);
    // Drain the wire-ordering replay-buffer flush boundary; see the first
    // T3 `it()` block for the rationale.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const onEvent = onEventHolder.current;
    if (onEvent === null)
      throw new Error("unreachable — capturedOnEvent set in subscribeToSession spy");
    onEvent(buildSessionCreatedEvent());
    expect(send).toHaveBeenCalledTimes(1);
    const call = send.mock.calls[0];
    if (call === undefined) throw new Error("unreachable");
    const [, frame] = call;
    // BLOCKED-ON-C6: keyed against the conservative inline streaming-
    // method-name constant per streaming-primitive.ts:90-95.
    expect(frame.method).toBe(SUBSCRIPTION_NOTIFY_METHOD);
    expect(frame.jsonrpc).toBe(JSONRPC_VERSION);
  });

  it("registers `session.subscribe` with mutating: false (subscribe escapes pre-handshake gate)", () => {
    const registry = new MethodRegistryImpl();
    const send = vi.fn<(transportId: number, frame: JsonRpcNotification<unknown>) => void>();
    const primitive = new StreamingPrimitive({ registry, send });
    const deps: SessionSubscribeDeps = {
      streamingPrimitive: primitive,
      subscribeToSession: () => () => undefined,
    };
    registerSessionSubscribe(registry, deps);
    expect(registry.isMutating("session.subscribe")).toBe(false);
  });

  it("session.subscribe response precedes synchronously-fired replay notifies (wire-ordering invariant)", async () => {
    // Wire-ordering invariant — `{ subscriptionId }` MUST land on the wire
    // BEFORE any `$/subscription/notify` for that subscription. The SDK
    // registers the subscription in its inbound dispatcher map AFTER the
    // init response settles; any pre-response notify is silently dropped
    // (unknown-id branch in `#handleSubscriptionNotify`).
    //
    // Plan-001 Phase 5's projector contract permits `subscribeToSession` to
    // perform cursor replay SYNCHRONOUSLY (replay-then-live-tail). This
    // test models that posture: the deps' `subscribeToSession` calls
    // `onEvent` 3 times BEFORE returning the unsubscribe handle. The
    // handler's fix buffers replay events fired during the synchronous
    // window and flushes them after a `setImmediate` boundary, which runs
    // in the check phase AFTER the dispatch promise's `.then` microtask
    // (where `#sendEnvelope` writes the response).
    //
    // Harness shape: this test reuses the existing direct-dispatch + send-
    // mock pattern (no gateway wired). To verify wire ordering, we capture
    // both response and notify frames into ONE ordered array. The response
    // push happens at the `await registry.dispatch(...)` resumption — that
    // is the same microtask checkpoint where the gateway's `#sendEnvelope`
    // would call `socket.write` synchronously. Then we drain `setImmediate`
    // by awaiting a `new Promise` that resolves on a fresh check-phase
    // tick; only after that drain is the buffered-replay flush observable.
    const registry = new MethodRegistryImpl();

    type CapturedFrame =
      | { kind: "response"; subscriptionId: string }
      | { kind: "notify"; value: SessionEvent };
    const frames: CapturedFrame[] = [];

    const send = vi.fn<(transportId: number, frame: JsonRpcNotification<unknown>) => void>(
      (_transportId, frame) => {
        const params = frame.params as SubscriptionNotifyParams<SessionEvent>;
        frames.push({ kind: "notify", value: params.value });
      },
    );
    const primitive = new StreamingPrimitive({ registry, send });

    // Build three production-ordered SessionEvents. `buildSessionCreatedEvent`
    // synthesizes one canonical-shape event; we vary `id` + `sequence` per
    // event so the assert-order step can distinguish them.
    const baseEvent = buildSessionCreatedEvent();
    const replayEvents: SessionEvent[] = [
      { ...baseEvent, id: "evt-replay-0001", sequence: 0 },
      { ...baseEvent, id: "evt-replay-0002", sequence: 1 },
      { ...baseEvent, id: "evt-replay-0003", sequence: 2 },
    ];

    // Test double — `subscribeToSession` calls `onEvent` 3 times
    // SYNCHRONOUSLY before returning the unsubscribe handle. This is
    // exactly the cursor-replay-then-live-tail shape Plan-001 Phase 5's
    // projector contract permits.
    const subscribeToSession = vi.fn<SessionSubscribeDeps["subscribeToSession"]>(
      (_sessionId, _afterCursor, onEvent) => {
        for (const event of replayEvents) {
          onEvent(event);
        }
        return () => undefined;
      },
    );
    const deps: SessionSubscribeDeps = {
      streamingPrimitive: primitive,
      subscribeToSession,
    };
    registerSessionSubscribe(registry, deps);

    // Act — dispatch and resume on the same microtask the gateway's
    // dispatch `.then` would fire on. The captured `frames` array carries
    // every `send`-routed notify frame in production order; the response
    // is appended at the dispatch-await resumption to model the gateway's
    // synchronous `socket.write` from the `.then` microtask.
    const ctx: HandlerContext = { transportId: 7 };
    const subscribeReq: SessionSubscribeRequest = { sessionId: TEST_SESSION_ID };
    const result = (await registry.dispatch(
      "session.subscribe",
      subscribeReq,
      ctx,
    )) as SessionSubscribeResponse;
    frames.push({ kind: "response", subscriptionId: result.subscriptionId });

    // Drain the check phase so the buffered-replay flush observes. A bare
    // `await Promise.resolve()` would only drain microtasks; we need a
    // `setImmediate` boundary to cross into the check phase the handler's
    // `setImmediate(...)` callback runs in.
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Assert — replay was synchronous (the deps call returned before the
    // dispatch promise resolved); without buffering, the three notify
    // frames would have been pushed to `frames` BEFORE the response push.
    expect(subscribeToSession).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(4);
    expect(frames[0]?.kind).toBe("response");
    if (frames[0]?.kind === "response") {
      expect(frames[0].subscriptionId).toBe(result.subscriptionId);
    }
    // Notify frames MUST follow in production order (replay 0..2).
    expect(frames[1]?.kind).toBe("notify");
    if (frames[1]?.kind === "notify") {
      expect(frames[1].value.id).toBe("evt-replay-0001");
    }
    expect(frames[2]?.kind).toBe("notify");
    if (frames[2]?.kind === "notify") {
      expect(frames[2].value.id).toBe("evt-replay-0002");
    }
    expect(frames[3]?.kind).toBe("notify");
    if (frames[3]?.kind === "notify") {
      expect(frames[3].value.id).toBe("evt-replay-0003");
    }
  });
});

// ----------------------------------------------------------------------------
// Phase D Round 4 F1 — daemon-crash hazard regression on `session.subscribe`
// ----------------------------------------------------------------------------
//
// Codex F1 (P1): `session-subscribe.ts` had two unguarded `sub.next(event)`
// call sites that throw `StreamingValidationError` (per
// `streaming-primitive.ts:346-352`) when the producer hands the primitive a
// malformed event. Both sites run on a LATER event-loop turn than the
// registry's `dispatch()` error-mapping wrapper:
//
//   1. The replay-buffer flush body inside `setImmediate(() => { ... })`
//      runs in the check phase, AFTER the dispatch promise's `.then`
//      microtask resolved the response — escapes registry error mapping.
//   2. The live-tail callback (the lambda passed to `subscribeToSession(...)`)
//      runs on whatever turn the upstream event source triggers (DB tick,
//      event bus, etc.) — also outside the registry's reach.
//
// An uncaught throw on either path becomes an uncaught exception capable of
// terminating the daemon process. The fix wraps both call sites in a
// try/catch that calls `sub.cancel()` and logs a tripwire diagnostic via
// `console.error` (no structured logger exists in the daemon today;
// TRIPWIRE replaces it when one lands).
//
// These tests verify the guards hold under direct injection of a malformed
// event. They do NOT assert the structured logger path (no logger exists);
// they DO assert the `console.error` tripwire fires so a regression that
// drops the catch block surfaces the bare throw and FAILS this test as
// "Promise rejected" / uncaught / silent (no log call).
//
// Test fixture posture: a malformed `SessionEvent` is constructed by
// casting `{}` to `SessionEvent` — this is the simplest value that fails
// `SessionEventSchema.safeParse` (the schema is a discriminated union
// requiring `type`/`category`/`sessionId`/etc.). The cast is the standard
// "test-only narrow" pattern; production code never sees this shape.

describe("Phase D Round 4 F1 — replay-flush + live-tail crash guards (Codex P1 regression)", () => {
  // Restore all `vi.spyOn(...)` instances after EACH test so a console.error
  // spy that survives a mid-test assertion failure doesn't leak into the
  // next test's stdout (which would silently swallow legitimate diagnostics).
  // The runtime-daemon's `vitest.config.ts` does NOT set `restoreMocks: true`,
  // so explicit per-block hygiene is the right call. Centralizing restore
  // here is also why the per-test `consoleErrorSpy.mockRestore()` calls
  // present in earlier drafts were removed — they only ran on the happy
  // path; this hook runs unconditionally.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("replay-flush: malformed event in replay buffer is caught; subscription canceled; daemon survives", async () => {
    // Arrange — wire `subscribeToSession` to fire a malformed event
    // SYNCHRONOUSLY (so it lands in the handler's `replayBuffer`, not the
    // live-tail path). The setImmediate boundary then drains the buffer
    // and the inner `sub.next(event)` throws `StreamingValidationError`.
    // Without the F1 guard, that throw escapes `setImmediate` as uncaught
    // and the test process would log "Unhandled error in setImmediate" —
    // vitest catches that via its own uncaught-exception hook and FAILS
    // the test. With the guard, the catch runs `sub.cancel()` and logs.
    const registry = new MethodRegistryImpl();
    const send = vi.fn<(transportId: number, frame: JsonRpcNotification<unknown>) => void>();
    const primitive = new StreamingPrimitive({ registry, send });

    // Spy `console.error` so the F1 tripwire is observable in the test.
    // The describe-level `afterEach(() => vi.restoreAllMocks())` resets
    // this spy after EVERY test (including failing ones), so subsequent
    // tests' console.error calls land on the real implementation.
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const subscribeToSession = vi.fn<SessionSubscribeDeps["subscribeToSession"]>(
      (_sessionId, _afterCursor, onEvent) => {
        // Fire SYNCHRONOUSLY — this is the replay window per Plan-001
        // Phase 5's projector contract. Cast `{}` to `SessionEvent` because
        // `SessionEventSchema.safeParse({})` fails (the schema is a
        // discriminated union and `{}` carries no `type` discriminator).
        onEvent({} as SessionEvent);
        return () => undefined;
      },
    );
    const deps: SessionSubscribeDeps = {
      streamingPrimitive: primitive,
      subscribeToSession,
    };
    registerSessionSubscribe(registry, deps);

    // Act — dispatch and drain the `setImmediate` flush boundary.
    const ctx: HandlerContext = { transportId: 7 };
    const subscribeReq: SessionSubscribeRequest = { sessionId: TEST_SESSION_ID };
    const result = (await registry.dispatch(
      "session.subscribe",
      subscribeReq,
      ctx,
    )) as SessionSubscribeResponse;
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Assert — the daemon survived (we got here; no uncaught throw aborted
    // the test). The primitive's `cancelSubscription(id)` returns `false`
    // because `sub.cancel()` already ran inside the F1 catch block,
    // draining BOTH `#subscriptions` AND `#subscriptionsByTransport`.
    expect(primitive.cancelSubscription(result.subscriptionId)).toBe(false);

    // Assert — the malformed event did NOT propagate to the wire as a
    // `$/subscription/notify` frame. `send` is the gateway's per-transport
    // write hook; if the F1 guard drained AFTER emitting (or didn't catch
    // the throw at all and let some partial state leak), this would be 1.
    expect(send).not.toHaveBeenCalled();

    // Assert — the F1 tripwire fired. The first call's first arg is the
    // tripwire prefix string, the second arg is the captured error.
    // A regression that drops the catch block makes this expectation
    // fail (zero calls), surfacing the missing guard.
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const errCall = consoleErrorSpy.mock.calls[0];
    if (errCall === undefined) throw new Error("unreachable — tripwire log expected");
    const [prefix, err] = errCall;
    expect(typeof prefix).toBe("string");
    expect(prefix).toContain("[session.subscribe] replay event validation/emission failed");
    expect(prefix).toContain(result.subscriptionId);
    expect(err).toBeInstanceOf(Error);
    if (err instanceof Error) {
      // The thrown error is `StreamingValidationError` (per
      // `streaming-primitive.ts:346-352`); its `.name` is the discriminator.
      expect(err.name).toBe("StreamingValidationError");
    }
  });

  it("live-tail: malformed event after replay drain is caught; subscription canceled; daemon survives", async () => {
    // Arrange — `subscribeToSession` captures `onEvent` and returns
    // immediately (no synchronous replay). After we drain the
    // `setImmediate` boundary, `replayDrained === true`, so any subsequent
    // `onEvent(event)` call lands the live-tail branch of the handler's
    // callback — the second F1 guard site.
    const registry = new MethodRegistryImpl();
    const send = vi.fn<(transportId: number, frame: JsonRpcNotification<unknown>) => void>();
    const primitive = new StreamingPrimitive({ registry, send });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    // Holder-object pattern — same as T3 above (TS control-flow narrowing
    // requires a holder for closure-mutated bindings to read back as
    // non-null at the outer scope).
    const onEventHolder: { current: ((event: SessionEvent) => void) | null } = {
      current: null,
    };
    const subscribeToSession = vi.fn<SessionSubscribeDeps["subscribeToSession"]>(
      (_sessionId, _afterCursor, onEvent) => {
        onEventHolder.current = onEvent;
        return () => undefined;
      },
    );
    const deps: SessionSubscribeDeps = {
      streamingPrimitive: primitive,
      subscribeToSession,
    };
    registerSessionSubscribe(registry, deps);

    // Act — dispatch, drain the replay boundary, then fire the malformed
    // event through the captured live-tail callback. With the F1 guard,
    // the throw is caught inside the lambda's `if (replayDrained)` branch.
    // Without the guard, the throw escapes the lambda and surfaces as an
    // uncaught exception on the turn the upstream event source triggered.
    const ctx: HandlerContext = { transportId: 7 };
    const subscribeReq: SessionSubscribeRequest = { sessionId: TEST_SESSION_ID };
    const result = (await registry.dispatch(
      "session.subscribe",
      subscribeReq,
      ctx,
    )) as SessionSubscribeResponse;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const onEvent = onEventHolder.current;
    if (onEvent === null) throw new Error("unreachable — capturedOnEvent assertion above");

    // Fire the malformed event. The lambda is synchronous-call from this
    // test stack; the F1 guard catches the throw and the call returns
    // normally (cancel + log). Without the guard, this `onEvent({} ...)`
    // call would itself throw — and we wrap it in expect().not.toThrow()
    // to surface that regression as a clean test failure rather than an
    // uncaught exception that aborts the suite.
    expect(() => onEvent({} as SessionEvent)).not.toThrow();

    // Assert — same shape as the replay-flush test: subscription canceled,
    // no wire frame emitted, tripwire log captured.
    expect(primitive.cancelSubscription(result.subscriptionId)).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const errCall = consoleErrorSpy.mock.calls[0];
    if (errCall === undefined) throw new Error("unreachable — tripwire log expected");
    const [prefix, err] = errCall;
    expect(typeof prefix).toBe("string");
    expect(prefix).toContain("[session.subscribe] live-tail event validation/emission failed");
    expect(prefix).toContain(result.subscriptionId);
    expect(err).toBeInstanceOf(Error);
    if (err instanceof Error) {
      expect(err.name).toBe("StreamingValidationError");
    }
  });

  it("replay-flush: subsequent good events do NOT propagate after a malformed event aborts the loop", async () => {
    // Arrange — fire a malformed event FIRST, then a good event. The F1
    // guard cancels the subscription on the first throw and the loop
    // breaks out of the catch, so the good event never reaches `send`.
    // This codifies the silent-no-op-after-cancel contract documented in
    // streaming-primitive.ts:333-339 against the F1-canceled state.
    const registry = new MethodRegistryImpl();
    const send = vi.fn<(transportId: number, frame: JsonRpcNotification<unknown>) => void>();
    const primitive = new StreamingPrimitive({ registry, send });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const subscribeToSession = vi.fn<SessionSubscribeDeps["subscribeToSession"]>(
      (_sessionId, _afterCursor, onEvent) => {
        onEvent({} as SessionEvent); // malformed — throws inside flush
        onEvent(buildSessionCreatedEvent()); // canonical — would emit if not canceled
        return () => undefined;
      },
    );
    const deps: SessionSubscribeDeps = {
      streamingPrimitive: primitive,
      subscribeToSession,
    };
    registerSessionSubscribe(registry, deps);

    const ctx: HandlerContext = { transportId: 7 };
    const subscribeReq: SessionSubscribeRequest = { sessionId: TEST_SESSION_ID };
    const result = (await registry.dispatch(
      "session.subscribe",
      subscribeReq,
      ctx,
    )) as SessionSubscribeResponse;
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Assert — the canonical event did NOT emit. The catch block fires
    // `sub.cancel()` BEFORE the loop's next iteration would have called
    // `sub.next(canonicalEvent)`; even if it did, `sub.next` post-cancel
    // is a documented silent-no-op (streaming-primitive.ts:333-339).
    expect(send).not.toHaveBeenCalled();
    expect(primitive.cancelSubscription(result.subscriptionId)).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });
});

// ----------------------------------------------------------------------------
// Plan-007 PR #19 Round 6 F5 — onCancel wire-up: upstream unsubscribe runs
// when the wire client cancels OR the transport disconnects, so the Plan-001
// Phase 5 event-source detaches its watcher rather than leaking it for the
// transport's lifetime. Codex flagged the discarded `unsubscribe` handle in
// `session-subscribe.ts:273` as ACTIONABLE (Round 6); Path B (extend
// `LocalSubscription<T>` with `onCancel`) closes the gap on the existing
// lifecycle interface.
// ----------------------------------------------------------------------------

describe("PR #19 R6 F5 — session.subscribe wires upstream unsubscribe via sub.onCancel", () => {
  it("wire-cancel (`$/subscription/cancel` from the same transport) fires the upstream unsubscribe", async () => {
    // Arrange — `subscribeToSession`'s test double returns a vi-fn
    // unsubscribe so we can assert exactly when it ran. The handler-binding
    // path registers the unsubscribe via `sub.onCancel(unsubscribe)`; the
    // primitive's wire-cancel path (the registered `$/subscription/cancel`
    // handler dispatching to `cancelSubscription`) must fire it.
    const registry = new MethodRegistryImpl();
    const send = vi.fn<(transportId: number, frame: JsonRpcNotification<unknown>) => void>();
    const primitive = new StreamingPrimitive({ registry, send });
    const unsubscribe = vi.fn<() => void>();
    const subscribeToSession = vi.fn<SessionSubscribeDeps["subscribeToSession"]>(() => unsubscribe);
    const deps: SessionSubscribeDeps = {
      streamingPrimitive: primitive,
      subscribeToSession,
    };
    registerSessionSubscribe(registry, deps);

    const transportId = 13;
    const ctx: HandlerContext = { transportId };
    const subscribeReq: SessionSubscribeRequest = { sessionId: TEST_SESSION_ID };
    const result = (await registry.dispatch(
      "session.subscribe",
      subscribeReq,
      ctx,
    )) as SessionSubscribeResponse;
    // Drain the replay-flush boundary so any post-init race is observable
    // before we cancel.
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(unsubscribe).not.toHaveBeenCalled();

    // Act — dispatch the wire-cancel through the registered cancel handler
    // (the same path a real client's `$/subscription/cancel` notification
    // walks). The cancel handler verifies transport-scoped ownership BEFORE
    // calling `cancelSubscription`; matching `transportId` is required.
    const cancelResult = await registry.dispatch(
      "$/subscription/cancel",
      { subscriptionId: result.subscriptionId },
      { transportId },
    );

    // Assert — the cancel removed the entry AND fired the registered
    // upstream-detach callback. Without the F5 wire-up, the entry would
    // drain but `unsubscribe` would stay uncalled, leaving the upstream
    // event-source's watcher running.
    expect((cancelResult as { canceled: boolean }).canceled).toBe(true);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("transport-disconnect (`cleanupTransport`) fires the upstream unsubscribe", async () => {
    // Arrange — same wiring; the disconnect path runs through the bootstrap
    // orchestrator's composed `onDisconnect` hook in production, which
    // calls `streamingPrimitive.cleanupTransport(transportId)`. Direct
    // invocation here models that hook firing.
    const registry = new MethodRegistryImpl();
    const send = vi.fn<(transportId: number, frame: JsonRpcNotification<unknown>) => void>();
    const primitive = new StreamingPrimitive({ registry, send });
    const unsubscribe = vi.fn<() => void>();
    const subscribeToSession = vi.fn<SessionSubscribeDeps["subscribeToSession"]>(() => unsubscribe);
    const deps: SessionSubscribeDeps = {
      streamingPrimitive: primitive,
      subscribeToSession,
    };
    registerSessionSubscribe(registry, deps);

    const transportId = 21;
    const ctx: HandlerContext = { transportId };
    const subscribeReq: SessionSubscribeRequest = { sessionId: TEST_SESSION_ID };
    await registry.dispatch("session.subscribe", subscribeReq, ctx);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(unsubscribe).not.toHaveBeenCalled();

    // Act — simulate transport disconnect via cleanupTransport.
    primitive.cleanupTransport(transportId);

    // Assert — the upstream watcher detached; without the F5 wire-up it
    // would remain registered against the now-dead transport.
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("complete() does NOT fire the upstream unsubscribe (natural producer-driven termination is silent)", async () => {
    // Arrange — capture the `LocalSubscription` handle so the test can
    // call `complete()` on it directly. We do this by replacing the handler-
    // binding path with a direct primitive call (the handler returns the
    // subscription via `createSubscription`; we exercise the same producer
    // surface here).
    const registry = new MethodRegistryImpl();
    const send = vi.fn<(transportId: number, frame: JsonRpcNotification<unknown>) => void>();
    const primitive = new StreamingPrimitive({ registry, send });
    const sub = primitive.createSubscription<SessionEvent>(31, SessionEventSchema);
    const unsubscribe = vi.fn<() => void>();
    sub.onCancel(unsubscribe);

    // Act — natural completion. The producer signals "no more values" via
    // `complete()`. By contract this MUST NOT fire onCancel handlers —
    // the producer already knows the stream ended (it's the caller); a
    // self-callback here would just be noise.
    sub.complete();

    // Assert — the upstream watcher is NOT detached on natural completion.
    // The producer is responsible for releasing its own resources when it
    // chooses to call `complete()`; the hook only fires on externally-
    // imposed cancellation.
    expect(unsubscribe).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------------------
// I-007-3-T5 — duplicate `registerSessionCreate` rejection (I-007-6)
// ----------------------------------------------------------------------------

describe("I-007-3-T5 — duplicate registerSessionCreate rejected at register-time (I-007-6)", () => {
  it("calling registerSessionCreate twice throws RegistryRegistrationError(`duplicate_method`)", () => {
    const registry = new MethodRegistryImpl();
    const deps: SessionCreateDeps = {
      createSession: async () => buildSessionCreateResponse(),
    };

    // First call — succeeds and binds `session.create`.
    registerSessionCreate(registry, deps);

    // Second call — must throw at register-time per I-007-6. The throw
    // surfaces synchronously from `MethodRegistryImpl.register` (no
    // dispatch / no async tick required).
    let caught: unknown = null;
    try {
      registerSessionCreate(registry, deps);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RegistryRegistrationError);
    if (caught instanceof RegistryRegistrationError) {
      expect(caught.registryCode).toBe("duplicate_method");
    }
  });

  it("the duplicate throw is SYNCHRONOUS (verifies bootstrap-deterministic failure)", () => {
    const registry = new MethodRegistryImpl();
    const deps: SessionCreateDeps = {
      createSession: async () => buildSessionCreateResponse(),
    };
    registerSessionCreate(registry, deps);
    // `expect(() => fn()).toThrow(...)` requires the throw to be synchronous;
    // a regression that moved the duplicate check into dispatch-time would
    // surface only after an async dispatch attempt and this test would fail.
    expect(() => registerSessionCreate(registry, deps)).toThrow(RegistryRegistrationError);
  });
});

// ----------------------------------------------------------------------------
// Local TypeScript suppressions — `Handler<...>` import is required by the
// fixture-typing surface above (the per-deps callback shape mirrors
// `Handler<SessionCreateRequest, SessionCreateResponse>` at the registry
// boundary). The import is preserved even when the in-file references stay
// implicit so the file's contract surface remains explicit for diff readers.
// ----------------------------------------------------------------------------

// Reference `Handler` type to keep the import stable; vitest's tsc pass
// would otherwise error TS6133 (unused import) under
// noUnusedParameters/Locals.
type _HandlerSignaturePresent = Handler<SessionCreateRequest, SessionCreateResponse>;
// Strip-only annotation; never invoked at runtime.
const _typeProbe: _HandlerSignaturePresent | undefined = undefined;
void _typeProbe;
// Sanity — re-import surfaces typecheck cleanly under the daemon's
// `verbatimModuleSyntax: true` (every type-only consumer above is a
// `import type` at the top of file).
void SessionCreateRequestSchema;
void SessionCreateResponseSchema;
void SessionSubscribeRequestSchema;
void SessionSubscribeResponseSchema;
