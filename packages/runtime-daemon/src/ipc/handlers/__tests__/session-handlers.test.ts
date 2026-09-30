// `session.create`, `session.read` and `session.subscribe` handler tests, driven through the
// method registry.
//
//   * `session.create`: a dispatched request reaches the deps with its parsed params, a
//     malformed one is refused as `-32602 InvalidParams` before the handler runs, and a second
//     registration of the method is refused.
//   * `session.read`: a known session answers its snapshot; an unknown one maps through
//     `SessionNotFoundError` to `-32602` with `data.type: "session.not_found"`.
//   * `session.subscribe`: the ack precedes every frame; changes go out batched, one frame per
//     window or per full frame, each change with its cursor; a connection that falls behind is
//     dropped for and told on the next frame that fits, or by one frame with no changes once it
//     catches up; a malformed frame cancels the subscription without taking the daemon down;
//     the upstream detaches when the subscription ends.
//
// The streaming primitive's own guarantees (cancel bookkeeping, transport ownership, cancel
// handlers) are covered in `streaming-primitive.test.ts`.

import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import type {
  EventCursor,
  Handler,
  HandlerContext,
  JsonRpcNotification,
  SessionCreateRequest,
  SessionCreateResponse,
  SessionEvent,
  SessionId,
  SessionReadRequest,
  SessionReadResponse,
  SessionStreamChange,
  SessionStreamFrame,
  SessionSubscribeRequest,
  SessionSubscribeResponse,
  SubscriptionId,
  SubscriptionNotifyParams,
} from "@ai-sidekicks/contracts";
import {
  JSONRPC_VERSION,
  SessionCreateRequestSchema,
  SessionCreateResponseSchema,
  JsonRpcErrorCode,
  SessionReadRequestSchema,
  SessionReadResponseSchema,
  SessionSubscribeRequestSchema,
  SessionSubscribeResponseSchema,
  STREAM_FRAME_MAX_CHANGES,
  SUBSCRIPTION_NOTIFY_METHOD,
} from "@ai-sidekicks/contracts";

import { mapJsonRpcError } from "../../jsonrpc-error-mapping.js";
import {
  MethodRegistryImpl,
  RegistryDispatchError,
  RegistryRegistrationError,
} from "../../registry.js";
import { SessionNotFoundError } from "../../session-errors.js";
import { StreamingPrimitive } from "../../streaming-primitive.js";

import { registerSessionCreate, type SessionCreateDeps } from "../session-create.js";
import { registerSessionRead, type SessionReadDeps } from "../session-read.js";
import {
  registerSessionSubscribe,
  SESSION_STREAM_WINDOW_MS,
  type OutboundQueue,
  type SessionSubscribeDeps,
} from "../session-subscribe.js";

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
const TEST_USER_ID = "660e8400-e29b-41d4-a716-446655440001";
// Additional ID for the session-read fixtures. The value is a static
// literal chosen for human-readable test failure output; its byte values
// are otherwise meaningless beyond passing the schema's branded-UUID parse.
const UNKNOWN_SESSION_ID = "aabbccdd-eeff-4011-8022-334455667788" as SessionId;

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
    actor: TEST_USER_ID,
    version: "1.0" as SessionEvent["version"],
    payload: {
      sessionId: TEST_SESSION_ID,
      config: { resourceLimits: { sessions: 10 } },
      metadata: { source: "cli" },
    },
  };
}

/**
 * Build a canonical-shape `SessionReadResponse` for happy- path test.
 * Mirrors the `buildSessionCreateResponse` pattern: every field matches
 * `SessionReadResponseSchema` so the registry's step-4 `safeParse`
 * succeeds and the dispatched value reaches the test assertion intact.
 *
 * `timelineCursors.acknowledged` is intentionally omitted — it is optional per the
 * canonical interface and exercising the absent-key shape catches a regression where a
 * default of `undefined` would slip through and fail `.strict()` parsing.
 */
function buildSessionReadResponse(): SessionReadResponse {
  return {
    session: {
      id: TEST_SESSION_ID,
      state: "active",
      config: {},
      metadata: {},
      createdAt: "2026-01-22T19:14:35.000Z",
      updatedAt: "2026-01-22T19:14:35.000Z",
    },
    timelineCursors: {
      latest: "evt-0042" as SessionReadResponse["timelineCursors"]["latest"],
    },
  };
}

// ----------------------------------------------------------------------------
// `session.create` round-trip through the registry
// ----------------------------------------------------------------------------

describe("session.create round-trip through MethodRegistry dispatch", () => {
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
// ----------------------------------------------------------------------------

describe("malformed session.create payload (verifies handler NEVER runs maps to -32602)", () => {
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

    // CRITICAL ASSERTION — the handler closure must NEVER have
    // executed. If a regression moved the schema check after handler
    // invocation, this assertion would fail.
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it("`invalid_params` registry code maps to JSON-RPC `-32602` on the wire", () => {
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
// `session.subscribe`: harness
// ----------------------------------------------------------------------------
//
// The handler batches changes on a 16 ms window, so these tests fake
// `setTimeout` / `clearTimeout` and leave `setImmediate` real: the ack barrier
// crosses into the check phase with `setImmediate`, and a faked one would never
// release it.

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
  replay: readonly SessionStreamChange<SessionEvent>[] = [],
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
      for (const change of replay) onChange(change);
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

// ----------------------------------------------------------------------------
// `session.subscribe`: the ack, and changes batched into frames
// ----------------------------------------------------------------------------

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

  it("sends the changes of one window as one frame when the window closes, each with its cursor", async () => {
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
  });

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

  it("writes the ack before any frame of a synchronous replay, the replay in order", async () => {
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
    const replay = Array.from({ length: STREAM_FRAME_MAX_CHANGES + 2 }, (_, index) =>
      changeAt(index),
    );
    registerSessionSubscribe(registry, {
      streamingPrimitive: primitive,
      outboundQueue: ALWAYS_ROOM,
      subscribeToSession: (_sessionId, _afterCursor, onChange) => {
        for (const change of replay) onChange(change);
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
      replay
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

// ----------------------------------------------------------------------------
// `session.subscribe`: a connection that falls behind is dropped for, and told
// ----------------------------------------------------------------------------

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

  it("sends one frame with no changes, the drop mark and the newest cursor once a quiet connection catches up", async () => {
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
  });

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

// ----------------------------------------------------------------------------
// `session.subscribe`: a malformed frame never takes the daemon down
// ----------------------------------------------------------------------------
//
// A frame the primitive refuses throws `StreamingValidationError` from a turn
// no dispatch wrapper covers: the barrier's flush, or the upstream's own turn.
// The barrier cancels the subscription and logs; these tests pin that for the
// session stream on both sides of the ack.

describe("session.subscribe survives a malformed frame", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("replay: a malformed event in a replayed frame cancels the subscription and sends nothing after it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const malformed = { cursor: "cursor-0" as EventCursor, event: {} as SessionEvent };
    const replay = [
      malformed,
      ...Array.from({ length: STREAM_FRAME_MAX_CHANGES }, (_, index) => changeAt(index + 1)),
    ];

    const stream = await subscribeWith(ALWAYS_ROOM, replay);
    vi.advanceTimersByTime(SESSION_STREAM_WINDOW_MS);

    expect(stream.send).not.toHaveBeenCalled();
    expect(stream.primitive.cancelSubscription(stream.subscriptionId)).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const [prefix, err] = consoleErrorSpy.mock.calls[0] ?? [];
    expect(prefix).toContain("[session.subscribe] replay event validation/emission failed");
    expect(prefix).toContain(stream.subscriptionId);
    expect((err as Error).name).toBe("StreamingValidationError");
  });

  it("live tail: a malformed event cancels the subscription without throwing into the upstream", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stream = await subscribeWith(ALWAYS_ROOM);

    stream.onChange({ cursor: "cursor-0" as EventCursor, event: {} as SessionEvent });
    expect(() => vi.advanceTimersByTime(SESSION_STREAM_WINDOW_MS)).not.toThrow();

    expect(stream.send).not.toHaveBeenCalled();
    expect(stream.primitive.cancelSubscription(stream.subscriptionId)).toBe(false);
    const [prefix] = consoleErrorSpy.mock.calls[0] ?? [];
    expect(prefix).toContain("[session.subscribe] live-tail event validation/emission failed");
  });
});

// ----------------------------------------------------------------------------
// `session.subscribe`: the upstream detaches when the subscription ends
// ----------------------------------------------------------------------------

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

// ----------------------------------------------------------------------------
// ----------------------------------------------------------------------------

describe("duplicate registerSessionCreate rejected at register-time", () => {
  it("calling registerSessionCreate twice throws RegistryRegistrationError(`duplicate_method`)", () => {
    const registry = new MethodRegistryImpl();
    const deps: SessionCreateDeps = {
      createSession: async () => buildSessionCreateResponse(),
    };

    // First call — succeeds and binds `session.create`.
    registerSessionCreate(registry, deps);

    // Second call — must throw at register-time. The throw surfaces
    // synchronously from `MethodRegistryImpl.register` (no dispatch /
    // no async tick required).
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
// `session.read` round-trip (AC-N2 +) (closure)
// ----------------------------------------------------------------------------
//
// AC-N2 has two arms: (a) happy path — a known sessionId returns a
// `SessionRead`-shape projection; (b) unknown sessionId — the deps throw
// `SessionNotFoundError`, which `mapJsonRpcError` discriminates to the
// canonical wire envelope `-32602 InvalidParams` + `data.type:
// "session.not_found"`.
//
// Wire-mapping check is performed by passing the `RegistryDispatchError`
// the registry rethrows through `mapJsonRpcError` and asserting the
// envelope shape — mirrors T2's two-arm pattern (registry throw +
// wire-mapping numeric) but adds the `data.type` projection check that
// is the load-bearing AC-N2 contract.

describe("session.read round-trip (AC-N2 +)", () => {
  it("dispatches a known sessionId to the readSession deps and returns SessionRead-shape", async () => {
    // Arrange — bind a mock `readSession` against a fresh registry.
    const registry = new MethodRegistryImpl();
    const expectedResponse = buildSessionReadResponse();
    const mockReadSession = vi.fn<(req: SessionReadRequest) => Promise<SessionReadResponse>>(
      async () => expectedResponse,
    );
    const deps: SessionReadDeps = { readSession: mockReadSession };
    registerSessionRead(registry, deps);

    // Act — dispatch with the canonical request body.
    const directCtx: HandlerContext = {};
    const result = await registry.dispatch(
      "session.read",
      { sessionId: TEST_SESSION_ID },
      directCtx,
    );

    // Assert — the deps callback ran exactly once with the parsed params.
    expect(mockReadSession).toHaveBeenCalledTimes(1);
    expect(mockReadSession).toHaveBeenCalledWith({ sessionId: TEST_SESSION_ID });

    // Assert — the dispatched result equals the deps' return value
    // (the registry's step-4 `safeParse(result)` re-parses against
    // `SessionReadResponseSchema` but does not mutate fields).
    expect(result).toStrictEqual(expectedResponse);

    // Assert — the response shape matches `SessionReadResponseSchema`
    // (Standard-Schema-V1 round-trip check; catches a regression where a
    // future fixture change drifts away from the wire contract).
    const parsed = SessionReadResponseSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });

  it("maps an unknown sessionId throw to -32602 + data.type session.not_found via SessionNotFoundError", async () => {
    // Arrange — `readSession` throws `SessionNotFoundError` for the
    // unknown sessionId. This is the typed deps-contract surface
    // documented in `session-read.ts`'s `SessionReadDeps.readSession`
    // JSDoc — unknown ids MUST throw this class (not a plain `Error`)
    // so the discriminator branch in `mapJsonRpcError` produces the
    // canonical envelope rather than collapsing to the `-32603
    // InternalError` catch-all.
    const registry = new MethodRegistryImpl();
    const mockReadSession = vi.fn<(req: SessionReadRequest) => Promise<SessionReadResponse>>(
      async () => {
        throw new SessionNotFoundError("session not found", {
          sessionId: UNKNOWN_SESSION_ID,
        });
      },
    );
    const deps: SessionReadDeps = { readSession: mockReadSession };
    registerSessionRead(registry, deps);

    // Act — dispatch. The registry's `dispatch()` does NOT wrap handler
    // throws (only `method_not_found` / `invalid_params` / `invalid_result`
    // surface as `RegistryDispatchError`; see `registry.ts:348-397`).
    // Handler-side throws propagate verbatim up the await chain — which
    // is exactly what the gateway needs: it passes the raw throw to
    // `mapJsonRpcError` for the wire envelope (see
    // `local-ipc-gateway.ts:1185-1214`).
    const ctx: HandlerContext = {};
    let caught: unknown = null;
    try {
      await registry.dispatch("session.read", { sessionId: UNKNOWN_SESSION_ID }, ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SessionNotFoundError);

    // Act (wire-mapping) — walk through `mapJsonRpcError` exactly like
    // the gateway would (the raw throw is what the discriminator must
    // see). Mirrors T2's wire-mapping arm but the discriminator branch
    // exercised here is the new `SessionNotFoundError` branch
    // (`jsonrpc-error-mapping.ts` — added by this PR).
    const envelope = mapJsonRpcError(caught, 7);

    // Assert — the canonical wire envelope.
    expect(envelope.id).toBe(7);
    expect(envelope.error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(envelope.error.data).toBeDefined();
    const data = envelope.error.data;
    if (data === undefined) throw new Error("unreachable — envelope.error.data was asserted above");
    expect(data.type).toBe("session.not_found");
    // The structured `fields` payload from the throw site projects
    // through to `data.fields`. The `sessionId` value flows verbatim
    // (after the `sanitizeFields` recursive walk, which preserves
    // structurally-safe strings unchanged).
    const fields = data.fields;
    if (fields === undefined) throw new Error("unreachable — fields was passed at throw site");
    // Bracket access — `Record<string, unknown>` requires index-signature
    // access under `noPropertyAccessFromIndexSignature: true`.
    expect(fields["sessionId"]).toBe(UNKNOWN_SESSION_ID);
    // The mock handler ran — confirms the throw originated from the
    // deps layer and propagated through `dispatch()` unchanged (a
    // regression that wrapped handler throws in
    // `RegistryDispatchError("handler_threw")` would make the
    // `instanceof SessionNotFoundError` assertion above fail; this
    // assertion provides the orthogonal cross-check).
    expect(mockReadSession).toHaveBeenCalledTimes(1);
  });

  it("registers `session.read` with mutating: false (pre-handshake gate passes through)", () => {
    // Sanity — requires read-only compatibility to continue across
    // version-mismatch. Flipping this flag to true would break the
    // read-only-fallback contract.
    const registry = new MethodRegistryImpl();
    const deps: SessionReadDeps = {
      readSession: async () => buildSessionReadResponse(),
    };
    registerSessionRead(registry, deps);
    expect(registry.isMutating("session.read")).toBe(false);
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
void SessionReadRequestSchema;
void SessionSubscribeRequestSchema;
void SessionSubscribeResponseSchema;
