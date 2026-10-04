// StreamingPrimitive: every value is validated before its `$/subscription/notify` frame is sent,
// a cancel is honored only from the owning connection, and a cancel or disconnect releases the
// subscription and runs its cancel handlers.

import { describe, expect, it, vi } from "vitest";

import type { HandlerContext } from "@ai-sidekicks/contracts/jsonrpc-registry";
import type { JsonRpcNotification } from "@ai-sidekicks/contracts/jsonrpc";
import type {
  SubscriptionCancelParams,
  SubscriptionCancelResult,
  SubscriptionNotifyParams,
} from "@ai-sidekicks/contracts/jsonrpc-streaming";
import { JSONRPC_VERSION } from "@ai-sidekicks/contracts/jsonrpc";
import {
  SUBSCRIPTION_CANCEL_METHOD,
  SUBSCRIPTION_NOTIFY_METHOD,
} from "@ai-sidekicks/contracts/jsonrpc-streaming";

import { MethodRegistryImpl } from "../registry.js";
import {
  StreamingPrimitive,
  StreamingValidationError,
  type StreamingPrimitiveOptions,
} from "../streaming-primitive.js";

import { passthroughSchema, rejectingSchema } from "../__fixtures__/zod-schemas.js";
import { captureThrow } from "../../__fixtures__/capture-failure.js";

interface PrimitiveFixture {
  readonly registry: MethodRegistryImpl;
  readonly primitive: StreamingPrimitive;
  readonly send: ReturnType<
    typeof vi.fn<(transportId: number, frame: JsonRpcNotification<unknown>) => void>
  >;
}

function makeFixture(): PrimitiveFixture {
  const registry = new MethodRegistryImpl();
  const send = vi.fn<(transportId: number, frame: JsonRpcNotification<unknown>) => void>();
  const options: StreamingPrimitiveOptions = { registry, send };
  const primitive = new StreamingPrimitive(options);
  return { registry, primitive, send };
}

describe("LocalSubscriptionProducer round-trip + cancel cleanup", () => {
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
    const sub = primitive.createSubscription<{ n: number }>(7, passthroughSchema<{ n: number }>());
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

  it("next(invalidValue) throws `StreamingValidationError` and sends nothing", () => {
    const { primitive, send } = makeFixture();
    const sub = primitive.createSubscription<unknown>(9, rejectingSchema<unknown>("invalid-value"));
    const caught = captureThrow(() => sub.next({ bogus: true }));
    expect(caught).toBeInstanceOf(StreamingValidationError);
    if (caught instanceof StreamingValidationError) {
      expect(caught.subscriptionId).toBe(sub.subscriptionId);
      expect(caught.issues).toBeDefined();
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("server-side cancel() or complete() removes the entry; a later next() is a silent no-op", () => {
    const { primitive, send } = makeFixture();
    const sub = primitive.createSubscription<{ x: number }>(11, passthroughSchema<{ x: number }>());
    sub.next({ x: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    sub.cancel();
    sub.next({ x: 2 }); // silent no-op
    expect(send).toHaveBeenCalledTimes(1);
    // Idempotent.
    expect(() => sub.cancel()).not.toThrow();

    const completed = primitive.createSubscription<{ y: number }>(
      12,
      passthroughSchema<{ y: number }>(),
    );
    completed.next({ y: 1 });
    completed.complete();
    completed.next({ y: 2 }); // silent no-op
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("client-initiated `$/subscription/cancel` with matching transportId removes the subscription", async () => {
    const { primitive, registry, send } = makeFixture();
    const sub = primitive.createSubscription<{ z: number }>(33, passthroughSchema<{ z: number }>());
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
    sub.next({ z: 1 });
    expect(send).not.toHaveBeenCalled();
  });

  it("client-initiated `$/subscription/cancel` from another transport, or of an unknown id, answers `{ canceled: false }`", async () => {
    const { primitive, registry, send } = makeFixture();
    const sub = primitive.createSubscription<{ q: number }>(55, passthroughSchema<{ q: number }>());
    // Transport 56 tries to cancel a subscription owned by transport 55.
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
    // The subscription is still alive.
    sub.next({ q: 1 });
    expect(send).toHaveBeenCalledTimes(1);

    // An unknown id answers the same as another transport's, so the answer reveals nothing.
    const unknownCancelParams: SubscriptionCancelParams = {
      // Passes the wire schema, but no such subscription exists.
      subscriptionId:
        "00000000-0000-4000-8000-000000000000" as SubscriptionCancelParams["subscriptionId"],
    };
    const unknownResult = (await registry.dispatch(
      SUBSCRIPTION_CANCEL_METHOD,
      unknownCancelParams,
      {
        transportId: 99,
      },
    )) as SubscriptionCancelResult;
    expect(unknownResult.canceled).toBe(false);
  });

  it("`cleanupTransport(id)` drops every subscription owned by that transport and no other", () => {
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
      78, // different transport; survives
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
});

// onCancel lets a producer release its upstream event source when a subscription is torn down.
describe("LocalSubscriptionProducer.onCancel lifecycle hook", () => {
  it("fires registered handlers when cancel() is called", () => {
    const { primitive } = makeFixture();
    const sub = primitive.createSubscription<unknown>(1, passthroughSchema<unknown>());
    const handler = vi.fn<() => void>();
    sub.onCancel(handler);
    expect(handler).not.toHaveBeenCalled();
    sub.cancel();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire handlers on complete() — natural producer-driven termination is silent", () => {
    const { primitive } = makeFixture();
    const sub = primitive.createSubscription<unknown>(1, passthroughSchema<unknown>());
    const handler = vi.fn<() => void>();
    sub.onCancel(handler);
    sub.complete();
    expect(handler).not.toHaveBeenCalled();
  });

  it("fires handlers when cleanupTransport() drops the subscription (transport-disconnect path)", () => {
    const { primitive } = makeFixture();
    const sub = primitive.createSubscription<unknown>(42, passthroughSchema<unknown>());
    const handler = vi.fn<() => void>();
    sub.onCancel(handler);
    primitive.cleanupTransport(42);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("fires handlers when cancelSubscription() drops the subscription (wire-cancel trusted path)", () => {
    const { primitive } = makeFixture();
    const sub = primitive.createSubscription<unknown>(42, passthroughSchema<unknown>());
    const handler = vi.fn<() => void>();
    sub.onCancel(handler);
    expect(primitive.cancelSubscription(sub.subscriptionId)).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("a handler registered AFTER cancel fires at once, so an upstream acquired late is still released", () => {
    const { primitive } = makeFixture();
    const sub = primitive.createSubscription<unknown>(1, passthroughSchema<unknown>());
    sub.cancel();
    const handler = vi.fn<() => void>();
    sub.onCancel(handler);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("registration AFTER complete is silently dropped (matches no-fire-on-complete semantic)", () => {
    const { primitive } = makeFixture();
    const sub = primitive.createSubscription<unknown>(1, passthroughSchema<unknown>());
    sub.complete();
    const handler = vi.fn<() => void>();
    expect(() => sub.onCancel(handler)).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it("multiple handlers fire in registration order on cancel()", () => {
    const { primitive } = makeFixture();
    const sub = primitive.createSubscription<unknown>(1, passthroughSchema<unknown>());
    const order: number[] = [];
    sub.onCancel(() => order.push(1));
    sub.onCancel(() => order.push(2));
    sub.onCancel(() => order.push(3));
    sub.cancel();
    expect(order).toStrictEqual([1, 2, 3]);
  });

  it("per-handler error isolation: every handler runs, then cancel throws the failure", () => {
    const { primitive } = makeFixture();
    const sub = primitive.createSubscription<unknown>(1, passthroughSchema<unknown>());
    const before = vi.fn<() => void>();
    const after = vi.fn<() => void>();
    const failure = new Error("handler-internal failure");
    sub.onCancel(before);
    sub.onCancel(() => {
      throw failure;
    });
    sub.onCancel(after);
    const thrown = captureThrow(() => sub.cancel());
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toStrictEqual([failure]);
    expect(before).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("cleanupTransport() bulk path: a throwing handler in one subscription does NOT prevent sibling subscription handlers from firing", () => {
    const { primitive } = makeFixture();
    const subA = primitive.createSubscription<unknown>(7, passthroughSchema<unknown>());
    const subB = primitive.createSubscription<unknown>(7, passthroughSchema<unknown>());
    const aHandler = vi.fn<() => void>();
    const bHandler = vi.fn<() => void>();
    subA.onCancel(() => {
      throw new Error("A handler internal failure");
    });
    subA.onCancel(aHandler);
    subB.onCancel(bHandler);
    expect(() => primitive.cleanupTransport(7)).not.toThrow();
    expect(aHandler).toHaveBeenCalledTimes(1);
    // A's failure must not reach B.
    expect(bHandler).toHaveBeenCalledTimes(1);
  });

  it("handlers fire AFTER the entry is removed from the maps (re-entrant handler observes post-cancel state)", () => {
    const { primitive } = makeFixture();
    const sub = primitive.createSubscription<unknown>(99, passthroughSchema<unknown>());
    let observedCancelable: boolean | null = null;
    sub.onCancel(() => {
      // Re-entering the primitive returns false because the entry is already gone.
      observedCancelable = primitive.cancelSubscription(sub.subscriptionId);
    });
    sub.cancel();
    expect(observedCancelable).toBe(false);
  });

  it("idempotent cancel(): a second cancel() does NOT re-fire handlers (handler queue cleared after first fire)", () => {
    const { primitive } = makeFixture();
    const sub = primitive.createSubscription<unknown>(1, passthroughSchema<unknown>());
    const handler = vi.fn<() => void>();
    sub.onCancel(handler);
    sub.cancel();
    sub.cancel(); // idempotent
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
