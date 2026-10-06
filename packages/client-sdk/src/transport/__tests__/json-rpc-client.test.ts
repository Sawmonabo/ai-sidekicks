// Tests for `JsonRpcClient`: Zod validation at both ends of the wire, subscribe-init
// registration, cancel idempotency, protocol-version emission and remote-error mapping, driven
// through the scripted daemon with replies delivered by hand.

import { describe, expect, it } from "vitest";
import { z } from "zod";

import type {
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcResponseEnvelope,
} from "@ai-sidekicks/contracts/jsonrpc/jsonrpc";
import { JSONRPC_VERSION } from "@ai-sidekicks/contracts/jsonrpc/jsonrpc";
import {
  SUBSCRIPTION_CANCEL_METHOD,
  SUBSCRIPTION_END_METHOD,
} from "@ai-sidekicks/contracts/jsonrpc/streaming";

import {
  buildSubscriptionNotify,
  createScriptedDaemon,
  type ScriptedDaemon,
  TEST_CLIENT_OPTIONS,
} from "../../__tests__/scripted-daemon.test-support.js";
import {
  JsonRpcClient,
  JsonRpcRemoteError,
  JsonRpcSchemaError,
  JsonRpcSubscriptionOverflowError,
} from "../json-rpc-client.js";

/** The params every test subscription sends. */
const TOPIC_PARAMS_SCHEMA = z.object({ topic: z.string() });

// Schema violations reject with JsonRpcSchemaError

describe("JsonRpcClient.call rejects with JsonRpcSchemaError on schema violations", () => {
  it(
    "corrupted server response (result fails resultSchema) " +
      "rejects with `JsonRpcSchemaError(phase: 'result')`",
    async () => {
      // A result that violates resultSchema, with valid params so the params phase cannot fire.
      const transport = createScriptedDaemon();
      const client = new JsonRpcClient(transport, TEST_CLIENT_OPTIONS);

      const paramsSchema = z.object({ key: z.string() });
      const resultSchema = z.object({
        sessionId: z.uuid(),
        state: z.literal("provisioning"),
      });

      // Keep the request id so the reply can echo it.
      const promise = client.call("session.create", { key: "value" }, paramsSchema, resultSchema);

      expect(transport.sentEnvelopes.length).toBe(1);
      const sentEnvelope = transport.sentEnvelopes[0];
      if (sentEnvelope === undefined) throw new Error("unreachable — length asserted above");
      if (!("id" in sentEnvelope)) {
        throw new Error("unreachable — call() emits a request envelope (carries id)");
      }
      const requestId = sentEnvelope.id;

      expect(sentEnvelope.jsonrpc).toBe(JSONRPC_VERSION);
      expect(sentEnvelope.method).toBe("session.create");
      // protocolVersion is sent unconditionally on every request.
      expect(sentEnvelope.protocolVersion).toBe("2026-05-01");

      // Reply with a result that violates resultSchema: a non-UUID id and the wrong state literal.
      const malformedResponse: JsonRpcResponseEnvelope = {
        jsonrpc: JSONRPC_VERSION,
        id: requestId,
        result: {
          sessionId: "not-a-uuid",
          state: "wrong-state",
        },
      };
      transport.deliverInbound(malformedResponse);

      await expect(promise).rejects.toBeInstanceOf(JsonRpcSchemaError);
      let caught: unknown = null;
      try {
        await promise;
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(JsonRpcSchemaError);
      if (caught instanceof JsonRpcSchemaError) {
        // phase separates a corrupt result from bad params and a bad streamed value.
        expect(caught.phase).toBe("result");
        // The Zod issues are kept for diagnostics.
        expect(caught.issues.length).toBeGreaterThan(0);
      }
    },
  );

  it(
    "caller-side malformed params rejects with " +
      "`JsonRpcSchemaError(phase: 'params')` BEFORE wire write (fail-fast)",
    async () => {
      // Params missing `key` fail before any wire I/O.
      const transport = createScriptedDaemon();
      const client = new JsonRpcClient(transport, TEST_CLIENT_OPTIONS);

      const paramsSchema = z.object({ key: z.string() });
      const resultSchema = z.unknown();

      // The failure is a rejection, not a sync throw, because `call` is async. The cast simulates a
      // runtime caller passing the wrong shape.
      const malformedParams = { wrongField: 42 } as unknown as { key: string };
      const promise = client.call("session.create", malformedParams, paramsSchema, resultSchema);

      await expect(promise).rejects.toBeInstanceOf(JsonRpcSchemaError);
      let caught: unknown = null;
      try {
        await promise;
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(JsonRpcSchemaError);
      if (caught instanceof JsonRpcSchemaError) {
        // phase is "params", not "result" or "value".
        expect(caught.phase).toBe("params");
        expect(caught.issues.length).toBeGreaterThan(0);
      }

      // Fail fast: nothing was sent and no pending entry was created, so validation must run
      // before the entry is parked and before `send`.
      expect(transport.sentEnvelopes.length).toBe(0);
    },
  );
});

// Subscribe-init registers the subscription synchronously
//
// A response and the first notify can arrive in one transport read. If registration waited for a
// microtask, the notify would hit the unknown-id drop and the first event would be lost.

describe("subscribe-init registers #subscriptions synchronously", () => {
  it(
    "a coalesced response+notify pair (delivered " +
      "in one synchronous frame) lands the first event",
    async () => {
      const transport = createScriptedDaemon();
      const client = new JsonRpcClient(transport, TEST_CLIENT_OPTIONS);
      const valueSchema = z.object({ kind: z.literal("event"), seq: z.number() });

      // subscribe() returns synchronously and the init request is already sent.
      const subscription = client.subscribe(
        "test.subscribe",
        { topic: "x" },
        TOPIC_PARAMS_SCHEMA,
        valueSchema,
      );

      expect(transport.sentEnvelopes.length).toBe(1);
      const sentEnvelope = transport.sentEnvelopes[0];
      if (sentEnvelope === undefined) throw new Error("unreachable — length asserted above");
      if (!("id" in sentEnvelope)) {
        throw new Error("unreachable — subscribe init emits a request envelope");
      }
      const requestId = sentEnvelope.id;
      expect(sentEnvelope.method).toBe("test.subscribe");

      // Deliver response and notify back to back with no await between them, as one read would.
      // The id is a UUID because the notify wrapper schema is UUID-branded.
      const subscriptionId = "11111111-1111-4111-8111-111111111111";
      const response: JsonRpcResponseEnvelope = {
        jsonrpc: JSONRPC_VERSION,
        id: requestId,
        result: { subscriptionId },
      };
      const notify: JsonRpcNotification = {
        jsonrpc: JSONRPC_VERSION,
        method: "$/subscription/notify",
        params: {
          subscriptionId,
          value: { kind: "event", seq: 1 },
        },
      };
      transport.deliverInbound(response);
      transport.deliverInbound(notify);

      // With deferred registration the notify would be dropped and next() would never resolve.
      const first = await subscription.next();
      expect(first).toEqual({ kind: "event", seq: 1 });
    },
  );
});

// A malformed subscriptionId is rejected at the SDK boundary
//
// The registration gate and the result schema both require a UUID, so a non-UUID id neither
// registers nor leaves an orphan entry behind.

describe("malformed subscriptionId rejected at SDK boundary", () => {
  it(
    "non-UUID subscriptionId fails the init schema; no " +
      "#subscriptions entry; iterator surfaces JsonRpcSchemaError",
    async () => {
      const transport = createScriptedDaemon();
      const client = new JsonRpcClient(transport, TEST_CLIENT_OPTIONS);
      const valueSchema = z.object({ kind: z.literal("event"), seq: z.number() });

      const subscription = client.subscribe(
        "test.subscribe",
        { topic: "x" },
        TOPIC_PARAMS_SCHEMA,
        valueSchema,
      );

      expect(transport.sentEnvelopes.length).toBe(1);
      const sentEnvelope = transport.sentEnvelopes[0];
      if (sentEnvelope === undefined || !("id" in sentEnvelope)) {
        throw new Error("unreachable — subscribe init emits a request envelope");
      }
      const requestId = sentEnvelope.id;

      // A non-UUID id must fail both the registration gate and the resolve-path parse.
      const malformedResponse: JsonRpcResponseEnvelope = {
        jsonrpc: JSONRPC_VERSION,
        id: requestId,
        result: { subscriptionId: "not-a-uuid" },
      };
      transport.deliverInbound(malformedResponse);

      // The iterator surfaces the schema error.
      let caught: unknown = null;
      try {
        await subscription.next();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(JsonRpcSchemaError);
      if (caught instanceof JsonRpcSchemaError) {
        // phase "result" marks a corrupt daemon reply.
        expect(caught.phase).toBe("result");
        expect(caught.issues.length).toBeGreaterThan(0);
      }
    },
  );
});

// cancel() is idempotent
//
// Two cancel() calls before the first wire cancel resolves must send one frame.

describe("cancel() idempotency", () => {
  it(
    "concurrent cancel() emits exactly one wire frame, both " +
      "promises resolve, and a later cancel() sends nothing",
    async () => {
      // Answer the subscribe-init so the state is active, then cancel twice.
      const transport = createScriptedDaemon();
      const client = new JsonRpcClient(transport, TEST_CLIENT_OPTIONS);
      const valueSchema = z.object({ kind: z.literal("event"), seq: z.number() });

      const subscription = client.subscribe(
        "test.subscribe",
        { topic: "x" },
        TOPIC_PARAMS_SCHEMA,
        valueSchema,
      );

      // Answer the init; the state is active synchronously.
      const initEnvelope = transport.sentEnvelopes[0];
      if (initEnvelope === undefined || !("id" in initEnvelope)) {
        throw new Error("unreachable — subscribe init emits a request envelope");
      }
      const subscriptionId = "44444444-4444-4444-8444-444444444444";
      transport.deliverInbound({
        jsonrpc: JSONRPC_VERSION,
        id: initEnvelope.id,
        result: { subscriptionId },
      });

      // Two cancels in one synchronous frame: the second must find the first one in flight.
      const cancelP1 = subscription.cancel();
      const cancelP2 = subscription.cancel();

      // One cancel frame on the wire, not two.
      const cancelEnvelopes = transport.sentEnvelopes.filter(
        (env) => "method" in env && env.method === SUBSCRIPTION_CANCEL_METHOD,
      );
      expect(cancelEnvelopes.length).toBe(1);

      // Ack the cancel so both promises resolve.
      const cancelEnvelope = cancelEnvelopes[0];
      if (cancelEnvelope === undefined || !("id" in cancelEnvelope)) {
        throw new Error("unreachable — cancel envelope is a request");
      }
      transport.deliverInbound({
        jsonrpc: JSONRPC_VERSION,
        id: cancelEnvelope.id,
        result: { canceled: true },
      });

      // Both promises resolve to undefined and observe the same outcome.
      const [r1, r2] = await Promise.all([cancelP1, cancelP2]);
      expect(r1).toBeUndefined();
      expect(r2).toBeUndefined();

      // After cancel the subscription is completed, so next() resolves `undefined`.
      const tail = await subscription.next();
      expect(tail).toBeUndefined();

      // A cancel after settlement hits the terminal guard and sends nothing.
      const cancelP3 = subscription.cancel();
      const cancelEnvelopesAfter = transport.sentEnvelopes.filter(
        (env) => "method" in env && env.method === SUBSCRIPTION_CANCEL_METHOD,
      );
      expect(cancelEnvelopesAfter.length).toBe(1);
      await expect(cancelP3).resolves.toBeUndefined();
    },
  );

  it(
    "concurrent cancel() preserves error propagation when " +
      "daemon nacks (one frame, both observe error path)",
    async () => {
      // The daemon answers the cancel with an error. Neither cancel() rejects; the subscription
      // becomes errored and next() rejects with the wire error.
      const transport = createScriptedDaemon();
      const client = new JsonRpcClient(transport, TEST_CLIENT_OPTIONS);
      const valueSchema = z.object({ kind: z.literal("event"), seq: z.number() });

      const subscription = client.subscribe(
        "test.subscribe",
        { topic: "x" },
        TOPIC_PARAMS_SCHEMA,
        valueSchema,
      );

      const initEnvelope = transport.sentEnvelopes[0];
      if (initEnvelope === undefined || !("id" in initEnvelope)) {
        throw new Error("unreachable — subscribe init emits a request envelope");
      }
      const subscriptionId = "66666666-6666-4666-8666-666666666666";
      transport.deliverInbound({
        jsonrpc: JSONRPC_VERSION,
        id: initEnvelope.id,
        result: { subscriptionId },
      });

      // Act — concurrent cancel; daemon responds with an error envelope.
      const cancelP1 = subscription.cancel();
      const cancelP2 = subscription.cancel();

      // One cancel frame on the wire.
      const cancelEnvelopes = transport.sentEnvelopes.filter(
        (env) => "method" in env && env.method === SUBSCRIPTION_CANCEL_METHOD,
      );
      expect(cancelEnvelopes.length).toBe(1);

      const cancelEnvelope = cancelEnvelopes[0];
      if (cancelEnvelope === undefined || !("id" in cancelEnvelope)) {
        throw new Error("unreachable — cancel envelope is a request");
      }

      // The daemon nacks the cancel with a JSON-RPC error.
      transport.deliverInbound({
        jsonrpc: JSONRPC_VERSION,
        id: cancelEnvelope.id,
        error: { code: -32603, message: "internal daemon failure" },
      });

      // Both cancel() promises resolve: a failed cancel ends the stream locally instead of
      // rejecting.
      await expect(cancelP1).resolves.toBeUndefined();
      await expect(cancelP2).resolves.toBeUndefined();

      // The subscription is errored: next() rejects with the wire error.
      let nextErr: unknown = null;
      try {
        await subscription.next();
      } catch (err) {
        nextErr = err;
      }
      expect(nextErr).toBeInstanceOf(JsonRpcRemoteError);
      if (nextErr instanceof JsonRpcRemoteError) {
        expect(nextErr.code).toBe(-32603);
        expect(nextErr.message).toBe("internal daemon failure");
      }
    },
  );
});

// A send() that returns a thenable without .catch
//
// PromiseLike only requires .then, so the client must not call .catch on send's result directly:
// it would throw a TypeError and hide the transport's real error.

describe("thenable transport.send rejection propagates", () => {
  /** The scripted daemon with a `send` that returns a thenable having only `.then`, rejecting. */
  function createThenableSendRejectingTransport(rejectionError: Error): ScriptedDaemon {
    const daemon = createScriptedDaemon();
    return {
      ...daemon,
      send(envelope): PromiseLike<void> {
        void daemon.send(envelope);
        // Rejects through its second argument on a microtask.
        return {
          then<TResult1, TResult2>(
            _onFulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null,
            onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
          ): PromiseLike<TResult1 | TResult2> {
            return new Promise<TResult1 | TResult2>((resolve, reject) => {
              queueMicrotask(() => {
                if (onRejected) {
                  try {
                    resolve(onRejected(rejectionError));
                  } catch (callbackErr) {
                    reject(callbackErr);
                  }
                } else {
                  reject(rejectionError);
                }
              });
            });
          },
        };
      },
    };
  }

  it(
    "transport.send returning a thenable WITHOUT `.catch` " +
      "propagates the rejection (no synthetic TypeError)",
    async () => {
      const sendErr = new Error("transport write failed");
      const transport = createThenableSendRejectingTransport(sendErr);
      const client = new JsonRpcClient(transport, TEST_CLIENT_OPTIONS);

      const paramsSchema = z.object({ key: z.string() });
      const resultSchema = z.object({ ok: z.boolean() });

      const promise = client.call("test.method", { key: "value" }, paramsSchema, resultSchema);

      // `Promise.resolve` absorbs the thenable; a direct `.catch` would have thrown synchronously.
      let caught: unknown = null;
      try {
        await promise;
      } catch (err) {
        caught = err;
      }

      // The transport's own error, not a TypeError from calling `.catch` on the thenable.
      expect(caught).toBe(sendErr);
      expect((caught as Error).message).toBe("transport write failed");

      // The envelope was sent before the thenable rejected.
      expect(transport.sentEnvelopes.length).toBe(1);
    },
  );
});

// The daemon rejects a non-handshake request without a valid protocolVersion. Every envelope is
// built by one function, so one request shows what call, subscribe-init and cancel all send.

describe("protocolVersion is sent as the caller gave it", () => {
  it("a different caller-advertised protocolVersion appears verbatim on the wire", () => {
    // The caller's version goes out verbatim; the client adds no default.
    const transport = createScriptedDaemon();
    const customVersion = "2027-01-15";
    const client = new JsonRpcClient(transport, {
      ...TEST_CLIENT_OPTIONS,
      protocolVersion: customVersion,
    });
    const paramsSchema = z.unknown();
    const resultSchema = z.unknown();

    void client.call("test.method", undefined, paramsSchema, resultSchema);

    expect(transport.sentEnvelopes.length).toBe(1);
    const envelope = transport.sentEnvelopes[0];
    if (envelope === undefined || !("id" in envelope)) {
      throw new Error("unreachable — call() emits a request envelope");
    }
    expect(envelope.protocolVersion).toBe(customVersion);
  });
});

// JsonRpcRemoteError carries the structured error.data
//
// A rejected call exposes `data` verbatim so clients switch on the dotted `data.type` rather than
// the numeric code.

describe("JsonRpcRemoteError surfaces error.data on rejection", () => {
  it("rejects with data.type and data.fields for the daemon's typed domain error", async () => {
    const transport = createScriptedDaemon();
    const client = new JsonRpcClient(transport, TEST_CLIENT_OPTIONS);
    const paramsSchema = z.object({ repoId: z.string() });
    const resultSchema = z.unknown();

    const promise = client.call("repo.mountRead", { repoId: "r-7" }, paramsSchema, resultSchema);

    const sentEnvelope = transport.sentEnvelopes[0];
    if (sentEnvelope === undefined || !("id" in sentEnvelope)) {
      throw new Error("unreachable — call() emits a request envelope");
    }

    // A typed domain error: -32602 with data.type and data.fields.
    transport.deliverInbound({
      jsonrpc: JSONRPC_VERSION,
      id: sentEnvelope.id,
      error: {
        code: -32602,
        message: "repo r-7 is not attached",
        data: { type: "repo.not_found", fields: { repoId: "r-7" } },
      },
    });

    let caught: unknown = null;
    try {
      await promise;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(JsonRpcRemoteError);
    if (caught instanceof JsonRpcRemoteError) {
      expect(caught.code).toBe(-32602);
      // The dotted discriminator surfaces verbatim — clients switch on this.
      expect(caught.data?.type).toBe("repo.not_found");
      expect(caught.data?.fields).toEqual({ repoId: "r-7" });
    }
  });
});

// A slow consumer and a failed cancel both end the subscription with an error the caller sees

describe("subscription ends with an error instead of growing or vanishing", () => {
  const subscriptionId = "44444444-4444-4444-8444-444444444444";
  const valueSchema = z.object({ seq: z.number() });

  function requestIdAt(transport: ScriptedDaemon, index: number): JsonRpcId {
    const envelope = transport.sentEnvelopes[index];
    if (envelope === undefined || !("id" in envelope)) throw new Error("no request at " + index);
    return envelope.id;
  }

  function cancelFrames(transport: ScriptedDaemon): ScriptedDaemon["sentEnvelopes"] {
    return transport.sentEnvelopes.filter(
      (envelope) => "method" in envelope && envelope.method === SUBSCRIPTION_CANCEL_METHOD,
    );
  }

  it("a consumer past the queue bound gets the queued values, then an overflow error", async () => {
    const transport = createScriptedDaemon();
    const client = new JsonRpcClient(transport, {
      ...TEST_CLIENT_OPTIONS,
      maxQueuedValuesPerSubscription: 2,
    });
    const subscription = client.subscribe(
      "test.subscribe",
      { topic: "x" },
      TOPIC_PARAMS_SCHEMA,
      valueSchema,
    );
    transport.deliverInbound({
      jsonrpc: JSONRPC_VERSION,
      id: requestIdAt(transport, 0),
      result: { subscriptionId },
    });
    for (const seq of [1, 2, 3, 4]) {
      transport.deliverInbound(buildSubscriptionNotify(subscriptionId, { seq }));
    }

    expect(cancelFrames(transport).length).toBe(1);
    transport.deliverInbound({
      jsonrpc: JSONRPC_VERSION,
      id: requestIdAt(transport, 1),
      result: { canceled: true },
    });
    expect(await subscription.next()).toEqual({ seq: 1 });
    expect(await subscription.next()).toEqual({ seq: 2 });
    await expect(subscription.next()).rejects.toBeInstanceOf(JsonRpcSubscriptionOverflowError);
  });

  it("a cancel sent before the subscribe reply waits for it, keeping the refusal", async () => {
    const transport = createScriptedDaemon();
    const client = new JsonRpcClient(transport, TEST_CLIENT_OPTIONS);
    const subscription = client.subscribe(
      "test.subscribe",
      { topic: "x" },
      TOPIC_PARAMS_SCHEMA,
      valueSchema,
    );
    const cancelPromise = subscription.cancel();
    expect(cancelFrames(transport).length).toBe(0);

    transport.deliverInbound({
      jsonrpc: JSONRPC_VERSION,
      id: requestIdAt(transport, 0),
      result: { subscriptionId },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancelFrames(transport).length).toBe(1);
    transport.deliverInbound({
      jsonrpc: JSONRPC_VERSION,
      id: requestIdAt(transport, 1),
      error: { code: -32603, message: "cancel failed" },
    });

    await cancelPromise;
    await expect(subscription.next()).rejects.toBeInstanceOf(JsonRpcRemoteError);
  });

  it("a stream the daemon ends keeps its queued values, then ends as the daemon says", async () => {
    const transport = createScriptedDaemon();
    const client = new JsonRpcClient(transport, TEST_CLIENT_OPTIONS);
    const open = (
      id: string,
    ): ReturnType<typeof client.subscribe<{ topic: string }, { seq: number }>> => {
      const subscription = client.subscribe(
        "test.subscribe",
        { topic: id },
        TOPIC_PARAMS_SCHEMA,
        valueSchema,
      );
      transport.deliverInbound({
        jsonrpc: JSONRPC_VERSION,
        id: requestIdAt(transport, transport.sentEnvelopes.length - 1),
        result: { subscriptionId: id },
      });
      transport.deliverInbound(buildSubscriptionNotify(id, { seq: 1 }));
      return subscription;
    };
    const completedId = "55555555-5555-4555-8555-555555555555";
    const refusedId = "66666666-6666-4666-8666-666666666666";
    const completed = open(completedId);
    const refused = open(refusedId);
    const error = { code: -32603, message: "ended", data: { type: "session.not_found" } };

    transport.deliverInbound({
      jsonrpc: JSONRPC_VERSION,
      method: SUBSCRIPTION_END_METHOD,
      params: { subscriptionId: completedId, reason: "completed" },
    });
    transport.deliverInbound({
      jsonrpc: JSONRPC_VERSION,
      method: SUBSCRIPTION_END_METHOD,
      params: { subscriptionId: refusedId, reason: "refused", error },
    });
    // A value after its end is dropped as an unknown id.
    transport.deliverInbound(buildSubscriptionNotify(completedId, { seq: 2 }));

    expect(await completed.next()).toEqual({ seq: 1 });
    expect(await completed.next()).toBeUndefined();
    expect(await refused.next()).toEqual({ seq: 1 });
    await expect(refused.next()).rejects.toMatchObject({
      constructor: JsonRpcRemoteError,
      code: -32603,
      data: { type: "session.not_found" },
    });
    // The daemon already dropped both, so neither end is answered with a cancel.
    expect(cancelFrames(transport)).toHaveLength(0);
  });
});
