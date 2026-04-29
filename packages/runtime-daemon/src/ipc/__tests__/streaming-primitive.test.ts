// W-007p-2-T11 — StreamingPrimitive test suite (T-007p-2-6).
//
// Spec coverage:
//   * Spec-007 §Required Behavior (lines 43-47) + §Wire Format (lines 50-56)
//     (docs/specs/007-local-ipc-and-daemon-control.md) — Local IPC supports
//     bidirectional streaming notifications; the wire envelope is the same
//     `Content-Length`-framed JSON-RPC envelope.
//
// Invariants verified here (canonical text in
// docs/plans/007-local-ipc-and-daemon-control.md §Invariants lines
// 95-117):
//   * I-007-7 streaming analog — every emitted `$/subscription/notify`
//     value must conform to the per-subscription `valueSchema` BEFORE
//     the gateway sends the frame. Validation failure throws
//     `StreamingValidationError` (programmer error).
//
// W-tests covered here (per Plan-007 §Phase 2 line 383):
//   * W-007p-2-T11 — `LocalSubscription<T>` round-trip + cancel
//                    cleanup. Initial response carries
//                    `subscriptionId`; N notifications correlate;
//                    cancel cleans up server resources; transport
//                    disconnect triggers server-side cleanup.
//
// The streaming tests run synchronously without binding any listener —
// the primitive's `send` callback is a `vi.fn()` we inspect directly.
// This isolates the I-007-7 streaming validation from the wire layer.

import { describe, expect, it, vi } from "vitest";

import type {
  HandlerContext,
  JsonRpcNotification,
  SubscriptionCancelParams,
  SubscriptionCancelResult,
  SubscriptionNotifyParams,
  ZodType,
} from "@ai-sidekicks/contracts";
import {
  JSONRPC_VERSION,
  SUBSCRIPTION_CANCEL_METHOD,
  SUBSCRIPTION_NOTIFY_METHOD,
} from "@ai-sidekicks/contracts";

import { MethodRegistryImpl, RegistryRegistrationError } from "../registry.js";
import {
  StreamingPrimitive,
  StreamingValidationError,
  type StreamingPrimitiveOptions,
} from "../streaming-primitive.js";

// ----------------------------------------------------------------------------
// Test fixtures
// ----------------------------------------------------------------------------

function passthroughSchema<T>(): ZodType<T> {
  return {
    safeParse: (v: unknown): { success: true; data: T } => ({
      success: true,
      data: v as T,
    }),
  } as unknown as ZodType<T>;
}

function rejectingSchema<T>(marker: string): ZodType<T> {
  return {
    safeParse: (
      _v: unknown,
    ): { success: false; error: { issues: ReadonlyArray<unknown> } } => ({
      success: false,
      error: { issues: [{ marker, message: "test-rejection" }] },
    }),
  } as unknown as ZodType<T>;
}

interface PrimitiveFixture {
  readonly registry: MethodRegistryImpl;
  readonly primitive: StreamingPrimitive;
  readonly send: ReturnType<
    typeof vi.fn<(transportId: number, frame: JsonRpcNotification<unknown>) => void>
  >;
}

function makeFixture(): PrimitiveFixture {
  const registry = new MethodRegistryImpl();
  const send = vi.fn<
    (transportId: number, frame: JsonRpcNotification<unknown>) => void
  >();
  const options: StreamingPrimitiveOptions = { registry, send };
  const primitive = new StreamingPrimitive(options);
  return { registry, primitive, send };
}

// ----------------------------------------------------------------------------
// W-007p-2-T11 — round-trip + cancel cleanup
// ----------------------------------------------------------------------------

describe("W-007p-2-T11 — LocalSubscription round-trip + cancel cleanup", () => {
  it("createSubscription returns a subscriptionId; subsequent next(value) emits a `$/subscription/notify` frame", () => {
    const { primitive, send } = makeFixture();
    const sub = primitive.createSubscription<{ tick: number }>(
      42,
      passthroughSchema<{ tick: number }>(),
    );
    expect(typeof sub.subscriptionId).toBe("string");
    expect(sub.subscriptionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(send).not.toHaveBeenCalled();
    sub.next({ tick: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    const [transportId, frame] = send.mock.calls[0] ?? [];
    expect(transportId).toBe(42);
    expect(frame).toBeDefined();
    if (frame === undefined) throw new Error("unreachable");
    expect(frame.jsonrpc).toBe(JSONRPC_VERSION);
    expect(frame.method).toBe(SUBSCRIPTION_NOTIFY_METHOD);
    const params = frame.params as SubscriptionNotifyParams<{ tick: number }>;
    expect(params.subscriptionId).toBe(sub.subscriptionId);
    expect(params.value).toStrictEqual({ tick: 1 });
  });

  it("emits N notifications correlating each to the same subscriptionId", () => {
    const { primitive, send } = makeFixture();
    const sub = primitive.createSubscription<{ n: number }>(
      7,
      passthroughSchema<{ n: number }>(),
    );
    sub.next({ n: 0 });
    sub.next({ n: 1 });
    sub.next({ n: 2 });
    expect(send).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 3; i++) {
      const call = send.mock.calls[i];
      if (call === undefined) throw new Error("unreachable");
      const [transportId, frame] = call;
      expect(transportId).toBe(7);
      expect(frame.method).toBe(SUBSCRIPTION_NOTIFY_METHOD);
      const params = frame.params as SubscriptionNotifyParams<{ n: number }>;
      expect(params.subscriptionId).toBe(sub.subscriptionId);
      expect(params.value).toStrictEqual({ n: i });
    }
  });

  it("I-007-7 streaming analog — next(invalidValue) throws `StreamingValidationError`; no send", () => {
    const { primitive, send } = makeFixture();
    const sub = primitive.createSubscription<unknown>(
      9,
      rejectingSchema<unknown>("invalid-value"),
    );
    let caught: unknown = null;
    try {
      sub.next({ bogus: true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StreamingValidationError);
    if (caught instanceof StreamingValidationError) {
      expect(caught.subscriptionId).toBe(sub.subscriptionId);
      expect(caught.issues).toBeDefined();
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("server-side cancel() removes the entry; subsequent next() is a silent no-op", () => {
    const { primitive, send } = makeFixture();
    const sub = primitive.createSubscription<{ x: number }>(
      11,
      passthroughSchema<{ x: number }>(),
    );
    sub.next({ x: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    sub.cancel();
    sub.next({ x: 2 }); // silent no-op
    expect(send).toHaveBeenCalledTimes(1);
    // Idempotent.
    expect(() => sub.cancel()).not.toThrow();
  });

  it("server-side complete() removes the entry; subsequent next() is a silent no-op", () => {
    const { primitive, send } = makeFixture();
    const sub = primitive.createSubscription<{ y: number }>(
      12,
      passthroughSchema<{ y: number }>(),
    );
    sub.next({ y: 1 });
    sub.complete();
    sub.next({ y: 2 }); // silent no-op per the documented contract
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("constructor eagerly registers `$/subscription/cancel` against the supplied registry (I-007-6)", () => {
    const { registry } = makeFixture();
    expect(registry.has(SUBSCRIPTION_CANCEL_METHOD)).toBe(true);
    // Registered as `mutating: false` per streaming-primitive.ts:521-531
    // — cancel must escape the version-mismatch gate.
    expect(registry.isMutating(SUBSCRIPTION_CANCEL_METHOD)).toBe(false);
  });

  it("constructing a SECOND primitive against the SAME registry throws `RegistryRegistrationError(`duplicate_method`)` per I-007-6", () => {
    const registry = new MethodRegistryImpl();
    const send = vi.fn<
      (transportId: number, frame: JsonRpcNotification<unknown>) => void
    >();
    new StreamingPrimitive({ registry, send });
    let caught: unknown = null;
    try {
      new StreamingPrimitive({ registry, send });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RegistryRegistrationError);
    if (caught instanceof RegistryRegistrationError) {
      expect(caught.registryCode).toBe("duplicate_method");
    }
  });

  it("client-initiated `$/subscription/cancel` with matching transportId removes the subscription", async () => {
    const { primitive, registry, send } = makeFixture();
    const sub = primitive.createSubscription<{ z: number }>(
      33,
      passthroughSchema<{ z: number }>(),
    );
    // The cancel handler runs through the registry's standard dispatch
    // path (with a transport-scoped ctx).
    const cancelParams: SubscriptionCancelParams = {
      subscriptionId: sub.subscriptionId,
    };
    const ctx: HandlerContext = { transportId: 33 };
    const result = (await registry.dispatch(
      SUBSCRIPTION_CANCEL_METHOD,
      cancelParams,
      ctx,
    )) as SubscriptionCancelResult;
    expect(result.canceled).toBe(true);
    // After cancel, next() is a silent no-op (the entry is gone).
    sub.next({ z: 1 });
    expect(send).not.toHaveBeenCalled();
  });

  it("client-initiated `$/subscription/cancel` with MISMATCHED transportId returns `{ canceled: false }` (cross-transport collapse, security)", async () => {
    const { primitive, registry, send } = makeFixture();
    const sub = primitive.createSubscription<{ q: number }>(
      55,
      passthroughSchema<{ q: number }>(),
    );
    // Peer B (transport 56) attempts to cancel peer A's (transport 55) subscription.
    const cancelParams: SubscriptionCancelParams = {
      subscriptionId: sub.subscriptionId,
    };
    const ctx: HandlerContext = { transportId: 56 };
    const result = (await registry.dispatch(
      SUBSCRIPTION_CANCEL_METHOD,
      cancelParams,
      ctx,
    )) as SubscriptionCancelResult;
    expect(result.canceled).toBe(false);
    // The subscription is STILL ALIVE — peer A can still emit values.
    sub.next({ q: 1 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("client-initiated cancel with unknown subscriptionId returns `{ canceled: false }` (unknown collapses to same observable as cross-transport)", async () => {
    const { registry } = makeFixture();
    const cancelParams: SubscriptionCancelParams = {
      // 36-char UUID-shaped string the schema accepts at the wire
      // boundary; the runtime check finds no entry and returns
      // canceled: false per the documented contract.
      subscriptionId: "00000000-0000-4000-8000-000000000000" as SubscriptionCancelParams["subscriptionId"],
    };
    const ctx: HandlerContext = { transportId: 99 };
    const result = (await registry.dispatch(
      SUBSCRIPTION_CANCEL_METHOD,
      cancelParams,
      ctx,
    )) as SubscriptionCancelResult;
    expect(result.canceled).toBe(false);
  });

  it("`cleanupTransport(id)` drops every subscription owned by that transport (transport-disconnect cleanup)", () => {
    const { primitive, send } = makeFixture();
    const sub1 = primitive.createSubscription<{ a: number }>(
      77,
      passthroughSchema<{ a: number }>(),
    );
    const sub2 = primitive.createSubscription<{ b: number }>(
      77,
      passthroughSchema<{ b: number }>(),
    );
    const sub3 = primitive.createSubscription<{ c: number }>(
      78, // different transport; should survive
      passthroughSchema<{ c: number }>(),
    );
    primitive.cleanupTransport(77);
    sub1.next({ a: 1 }); // silent no-op (entry gone)
    sub2.next({ b: 2 }); // silent no-op (entry gone)
    sub3.next({ c: 3 }); // still alive
    expect(send).toHaveBeenCalledTimes(1);
    const lastCall = send.mock.calls[0];
    if (lastCall === undefined) throw new Error("unreachable");
    expect(lastCall[0]).toBe(78);
  });

  it("`cleanupTransport` is idempotent on unknown id", () => {
    const { primitive } = makeFixture();
    expect(() => primitive.cleanupTransport(123)).not.toThrow();
    expect(() => primitive.cleanupTransport(123)).not.toThrow();
  });

  it("`cancelSubscription(id)` (internal-trusted path) returns true for known + false for unknown id", () => {
    const { primitive } = makeFixture();
    const sub = primitive.createSubscription<unknown>(
      88,
      passthroughSchema<unknown>(),
    );
    expect(primitive.cancelSubscription(sub.subscriptionId)).toBe(true);
    // Second call: already removed.
    expect(primitive.cancelSubscription(sub.subscriptionId)).toBe(false);
  });
});
