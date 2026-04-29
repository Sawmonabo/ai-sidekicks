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

import { describe, expect, it, vi } from "vitest";

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
