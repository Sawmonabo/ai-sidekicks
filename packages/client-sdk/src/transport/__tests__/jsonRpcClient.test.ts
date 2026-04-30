// I-007-3-T4 — SDK Zod-wrapper test suite (T-007p-3-4).
//
// Spec coverage:
//   * Spec-007 line 56 — typed JSON-RPC client transport surface owed to
//     desktop renderer + CLI consumers
//     (docs/specs/007-local-ipc-and-daemon-control.md).
//   * Plan-007 §Cross-Plan Obligations CP-007-4 — `transport/jsonRpcClient.ts`
//     is the SDK-side wrapping primitive that mirrors the daemon-side
//     I-007-7 schema-validates-before-dispatch invariant on the wire's other
//     end. Every outbound payload is Zod-validated BEFORE the wire write;
//     every inbound payload is Zod-validated BEFORE it surfaces to the
//     caller.
//
// Acceptance Criterion verified here (per task contract):
//   * I-007-3-T4 — `JsonRpcClient.call`:
//     a) Corrupted server response → `JsonRpcSchemaError(phase: "result")`
//        (server-corruption signal; the daemon returned a value that does
//        not match the caller's `resultSchema`). The promise rejects;
//        the SDK does NOT silently coerce or swallow.
//     b) Caller-side malformed params → `JsonRpcSchemaError(phase: "params")`
//        (caller bug; fail-fast BEFORE the wire write). The promise
//        rejects; the transport's `send` is NEVER called; the pending
//        request map stays empty.
//
// CP-007-4 verification: the test asserts BOTH phases share a single error
// class (`JsonRpcSchemaError`) discriminated by the `phase` field so test
// observability and downstream telemetry can route the two surfaces
// uniformly. The SDK's contract is "fail-fast-with-typed-error on either
// end of validation"; this file pins both directions of that contract.
//
// Test-fixture posture:
//   * The client-sdk's `package.json` DOES depend on `zod` (devDependencies
//     + runtime — per package.json line 29). So unlike the daemon-side
//     fixtures, this file imports `zod` directly and constructs real Zod
//     schemas for the `paramsSchema` / `resultSchema` slots. This matches
//     the realistic call-site pattern downstream consumers (Plan-001 Phase
//     5 sessionClient) follow.
//   * The transport double is a hand-rolled in-memory class that captures
//     outbound `send()` calls in an array and exposes a `dispatchInbound`
//     method for the test to drive a server-corrupted reply through the
//     captured `onMessage` handler. Mirrors the pattern documented in the
//     `JsonRpcClient` JSDoc (jsonRpcClient.ts:560 — "synchronous-resolution
//     transport (in-memory test double)").
//
// What this file does NOT cover:
//   * Streaming `value` validation (`phase: "value"`) — covered by sibling
//     subscription-flow tests that exercise `subscribe()` + the
//     `$/subscription/notify` corruption path. T4's contract is the `call`-
//     surface validation; the streaming surface has its own corruption
//     code path validated separately.
//   * Transport-close error propagation (`JsonRpcTransportClosedError`) —
//     covered by sibling close-handler tests.
//   * Successful round-trip (no corruption) — covered by sibling
//     happy-path tests; T4's scope is corruption-only per the AC.

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type {
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponseEnvelope,
} from "@ai-sidekicks/contracts";
import { JSONRPC_VERSION, SUBSCRIPTION_CANCEL_METHOD } from "@ai-sidekicks/contracts";

import { JsonRpcClient, JsonRpcRemoteError, JsonRpcSchemaError } from "../jsonRpcClient.js";
import type { ClientTransport } from "../types.js";

// ----------------------------------------------------------------------------
// In-memory ClientTransport double
// ----------------------------------------------------------------------------
//
// Captures every outbound `send(envelope)` call into `sentEnvelopes`. Holds
// the inbound `onMessage` callback so the test can drive a hand-built reply
// envelope through the client's dispatcher. Mirrors the pattern from MCP
// SDK's in-memory transport (per Plan-007:309 reference) but trimmed to the
// fields T4 actually needs.

class InMemoryTransport implements ClientTransport {
  /**
   * Envelopes captured in send-order. Each entry is the JSON-RPC envelope
   * object the client wrote to the transport — useful for both the params-
   * phase test (assert empty after fail-fast rejection) AND the result-
   * phase test (capture the request id for echo correlation).
   */
  public readonly sentEnvelopes: Array<JsonRpcRequest | JsonRpcNotification> = [];

  /**
   * The client registers exactly ONE inbound dispatcher per transport
   * (per types.ts:121-124). We capture it here so the test can drive a
   * server response envelope synchronously.
   */
  #onMessage: ((msg: JsonRpcResponseEnvelope | JsonRpcNotification) => void) | null = null;
  #onClose: ((reason?: Error) => void) | null = null;

  public send(envelope: JsonRpcRequest | JsonRpcNotification): void {
    this.sentEnvelopes.push(envelope);
  }

  public onMessage(handler: (msg: JsonRpcResponseEnvelope | JsonRpcNotification) => void): void {
    this.#onMessage = handler;
  }

  public onClose(handler: (reason?: Error) => void): void {
    this.#onClose = handler;
  }

  public close(): Promise<void> {
    if (this.#onClose !== null) {
      this.#onClose(undefined);
    }
    return Promise.resolve();
  }

  /**
   * Drive an inbound envelope through the client's registered handler.
   * Synchronous — the client's `#handleResponse` resolves the pending
   * promise inline, so by the time this method returns the `await` on
   * `client.call(...)` has already settled.
   */
  public dispatchInbound(msg: JsonRpcResponseEnvelope | JsonRpcNotification): void {
    if (this.#onMessage === null) {
      throw new Error("dispatchInbound called before onMessage was registered");
    }
    this.#onMessage(msg);
  }
}

// ----------------------------------------------------------------------------
// I-007-3-T4 — corrupted server response → JsonRpcSchemaError(phase: "result")
// ----------------------------------------------------------------------------

describe("I-007-3-T4 — JsonRpcClient.call rejects with JsonRpcSchemaError on schema violations", () => {
  it("corrupted server response (result fails resultSchema) rejects with `JsonRpcSchemaError(phase: 'result')`", async () => {
    // Arrange — a real Zod schema demanding a specific shape on the result.
    // The server's response will deliberately violate it. We pair this with
    // a permissive params schema so the params-phase doesn't short-circuit.
    const transport = new InMemoryTransport();
    const client = new JsonRpcClient(transport, { protocolVersion: 1 });

    const paramsSchema = z.object({ key: z.string() });
    const resultSchema = z.object({
      sessionId: z.string().uuid(),
      state: z.literal("provisioning"),
    });

    // Act — issue the call. The send happens synchronously per the
    // InMemoryTransport's `send()` push. We capture the envelope's id so
    // the test echoes it on the corrupted response (the client's
    // `#handleResponse` correlates by id and rejects on schema failure).
    const promise = client.call("session.create", { key: "value" }, paramsSchema, resultSchema);

    // The send was synchronous — capture the request id to echo back.
    expect(transport.sentEnvelopes.length).toBe(1);
    const sentEnvelope = transport.sentEnvelopes[0];
    if (sentEnvelope === undefined) throw new Error("unreachable — length asserted above");
    if (!("id" in sentEnvelope)) {
      throw new Error("unreachable — call() emits a request envelope (carries id)");
    }
    const requestId = sentEnvelope.id;

    // Sanity — the request envelope carries the canonical fields.
    expect(sentEnvelope.jsonrpc).toBe(JSONRPC_VERSION);
    expect(sentEnvelope.method).toBe("session.create");

    // Drive a malformed response. The server returned a `result` whose
    // shape does NOT match `resultSchema` — `sessionId` is a non-UUID and
    // `state` is the wrong literal. The client's `#handleResponse` picks
    // up the pending entry, runs `resultSchema.safeParse(result)`, fails,
    // and rejects the promise with `JsonRpcSchemaError(phase: "result")`.
    const malformedResponse: JsonRpcResponseEnvelope = {
      jsonrpc: JSONRPC_VERSION,
      id: requestId,
      result: {
        sessionId: "not-a-uuid",
        state: "wrong-state",
      },
    };
    transport.dispatchInbound(malformedResponse);

    // Assert — the promise rejects with the canonical schema error.
    await expect(promise).rejects.toBeInstanceOf(JsonRpcSchemaError);
    let caught: unknown = null;
    try {
      await promise;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(JsonRpcSchemaError);
    if (caught instanceof JsonRpcSchemaError) {
      // CRITICAL — the `phase` discriminates server-corruption (`"result"`)
      // from caller-bug (`"params"`) from streaming-corruption (`"value"`).
      expect(caught.phase).toBe("result");
      // The Zod issues array is preserved verbatim for downstream
      // observability.
      expect(caught.issues.length).toBeGreaterThan(0);
    }

    // Sanity — the pending map is drained after the rejection (the
    // `#handleResponse` path deletes the entry before resolving / rejecting).
    expect(client.pendingCount).toBe(0);
  });

  it("caller-side malformed params rejects with `JsonRpcSchemaError(phase: 'params')` BEFORE wire write (fail-fast)", async () => {
    // Arrange — `paramsSchema` requires a `key: string`. We pass an object
    // missing that field; `paramsSchema.safeParse(...)` fails inside `call`
    // BEFORE any wire I/O happens, and the throw becomes a Promise
    // rejection (since `call` is async).
    const transport = new InMemoryTransport();
    const client = new JsonRpcClient(transport, { protocolVersion: 1 });

    const paramsSchema = z.object({ key: z.string() });
    const resultSchema = z.unknown();

    // Act + Assert — the rejection is a Promise rejection (not a sync
    // throw) per the `async call()` contract. `await expect(...).rejects`
    // is the canonical Vitest pattern.
    //
    // Cast the malformed params to `unknown` and back to `{ key: string }`
    // so the call site is type-erased — the realistic failure mode is a
    // runtime caller passing in the wrong shape (e.g. from JSON.parse on
    // user input), not a TypeScript-detected mismatch. The cast simulates
    // that runtime path inside an otherwise type-safe test.
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
      // CRITICAL — the `phase` is `"params"` (caller-bug) NOT `"result"`
      // (server-corruption) NOT `"value"` (streaming-corruption).
      expect(caught.phase).toBe("params");
      expect(caught.issues.length).toBeGreaterThan(0);
    }

    // CRITICAL FAIL-FAST ASSERTIONS — the wire was NEVER written and the
    // pending request map was NEVER touched. The validation failure
    // short-circuits before `this.#allocateId()` and the `new Promise`
    // block where the pending entry would otherwise be registered (per
    // jsonRpcClient.ts:534-541 — the throw runs INSIDE the async function
    // body before the Promise constructor). If a regression moved the
    // params-validation call AFTER `transport.send()`, the assertions
    // below would fail.
    expect(transport.sentEnvelopes.length).toBe(0);
    expect(client.pendingCount).toBe(0);
  });

  it("the two phases share one class (`JsonRpcSchemaError`) but discriminate via `.phase`", async () => {
    // Sanity — both rejections produce instances of the SAME class. This
    // is the SDK's API contract (per jsonRpcClient.ts:166-186 — single
    // class with a `phase: "params" | "result" | "value"` discriminator).
    // Test code routes via `instanceof JsonRpcSchemaError` then switches
    // on `.phase`; if the SDK split the surface into two classes the
    // downstream observability would need two `instanceof` branches.
    const transport = new InMemoryTransport();
    const client = new JsonRpcClient(transport, { protocolVersion: 1 });
    const paramsSchema = z.object({ key: z.string() });
    const resultSchema = z.object({ sessionId: z.string().uuid() });

    // Phase A — params failure.
    const malformedParams = { bogus: true } as unknown as { key: string };
    const paramsPromise = client.call("test.method", malformedParams, paramsSchema, resultSchema);
    let paramsErr: unknown = null;
    try {
      await paramsPromise;
    } catch (e) {
      paramsErr = e;
    }
    expect(paramsErr).toBeInstanceOf(JsonRpcSchemaError);

    // Phase B — result failure (separate call after a clean params parse).
    const resultPromise = client.call("test.method", { key: "v" }, paramsSchema, resultSchema);
    expect(transport.sentEnvelopes.length).toBe(1);
    const sent = transport.sentEnvelopes[0];
    if (sent === undefined || !("id" in sent)) throw new Error("unreachable");
    transport.dispatchInbound({
      jsonrpc: JSONRPC_VERSION,
      id: sent.id,
      result: { sessionId: "not-a-uuid" },
    });
    let resultErr: unknown = null;
    try {
      await resultPromise;
    } catch (e) {
      resultErr = e;
    }
    expect(resultErr).toBeInstanceOf(JsonRpcSchemaError);

    // Both errors are JsonRpcSchemaError BUT carry different `.phase`
    // discriminators — the SDK's API contract.
    if (paramsErr instanceof JsonRpcSchemaError && resultErr instanceof JsonRpcSchemaError) {
      expect(paramsErr.phase).toBe("params");
      expect(resultErr.phase).toBe("result");
      expect(paramsErr.phase).not.toBe(resultErr.phase);
    }
  });
});

// ----------------------------------------------------------------------------
// Test infrastructure sanity — the InMemoryTransport double's contract
// ----------------------------------------------------------------------------
//
// Quick smoke tests that the transport double itself satisfies its
// `ClientTransport` interface contract. Without these, a regression in the
// transport double could mask T4's substantive assertions (e.g. if `send`
// silently swallowed envelopes, the params-phase fail-fast assertion would
// trivially pass even with broken validation).

describe("InMemoryTransport double — sanity", () => {
  it("captures sent envelopes in send-order", () => {
    const transport = new InMemoryTransport();
    const env1: JsonRpcRequest = { jsonrpc: JSONRPC_VERSION, id: 1, method: "a" };
    const env2: JsonRpcRequest = { jsonrpc: JSONRPC_VERSION, id: 2, method: "b" };
    transport.send(env1);
    transport.send(env2);
    expect(transport.sentEnvelopes.length).toBe(2);
    expect(transport.sentEnvelopes[0]).toBe(env1);
    expect(transport.sentEnvelopes[1]).toBe(env2);
  });

  it("dispatchInbound delivers to the registered onMessage handler", () => {
    const transport = new InMemoryTransport();
    const received = vi.fn<(msg: JsonRpcResponseEnvelope | JsonRpcNotification) => void>();
    transport.onMessage(received);
    const env: JsonRpcResponseEnvelope = {
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      result: { ok: true },
    };
    transport.dispatchInbound(env);
    expect(received).toHaveBeenCalledTimes(1);
    expect(received).toHaveBeenCalledWith(env);
  });
});

// ----------------------------------------------------------------------------
// Codex P1 regression — subscribe-init MUST register synchronously
// ----------------------------------------------------------------------------
//
// External adversarial review (Codex GPT-5.5 xhigh, 2026-04-29) flagged a
// race in `JsonRpcClient.subscribe()`: the subscription was registered into
// `#subscriptions` inside the `subscribe().then` microtask callback, which
// only runs AFTER the current synchronous frame finishes. When a transport
// parser delivered the subscribe-init response and the first
// `$/subscription/notify` frame back-to-back from the same socket read
// (normal frame coalescing on a stream socket), the notify ran through
// `#handleNotification` BEFORE the registration microtask fired, hitting the
// unknown-id silent-drop branch and losing the first event.
//
// The daemon-side wire-ordering invariant (Plan-007 I-007-10 — daemon
// writes the subscribe response BEFORE the first notify frame) was a
// necessary precondition but not sufficient on its own; the SDK had to
// install `#subscriptions` synchronously in the same frame as the response
// dispatch. The fix moved registration into `#handleResponse` (between
// `pending.delete` and `pending.resolve`) so the very next inbound
// `#handleInbound` call — even if dispatched in the same synchronous parse
// loop — finds the subscription registered.
//
// This test pins that synchronous-registration contract by driving exactly
// the coalesced delivery scenario through the in-memory transport: it
// invokes `transport.dispatchInbound(response)` immediately followed by
// `transport.dispatchInbound(notify)` with NO awaits, microtask drains, or
// timer ticks between the two calls. If the SDK regressed back to
// microtask-deferred registration, the notify would land against an empty
// `#subscriptions` map and `subscription.next()` would never resolve (or
// would resolve `undefined` once the test transport closed).
//
// Spec coverage:
//   * Plan-007 §Cross-Plan Obligations CP-007-4 — SDK-side wrapping
//     primitive must respect the daemon's wire-ordering invariant.
//   * Plan-007 I-007-10 — wire-ordering invariant (daemon side, paired
//     contract).

describe("subscribe-init registers #subscriptions synchronously (Codex P1 regression)", () => {
  it("a coalesced response+notify pair (delivered in one synchronous frame) lands the first event", async () => {
    // Arrange — a value schema for a trivial event payload.
    const transport = new InMemoryTransport();
    const client = new JsonRpcClient(transport, { protocolVersion: 1 });
    const valueSchema = z.object({ kind: z.literal("event"), seq: z.number() });

    // Act 1 — open the subscription. `subscribe()` returns a handle
    // synchronously; the init request is on the wire immediately.
    const subscription = client.subscribe<z.infer<typeof valueSchema>>(
      "test.subscribe",
      { topic: "x" },
      valueSchema,
    );

    // Capture the subscribe-init request id from the captured envelope.
    expect(transport.sentEnvelopes.length).toBe(1);
    const sentEnvelope = transport.sentEnvelopes[0];
    if (sentEnvelope === undefined) throw new Error("unreachable — length asserted above");
    if (!("id" in sentEnvelope)) {
      throw new Error("unreachable — subscribe init emits a request envelope");
    }
    const requestId = sentEnvelope.id;
    expect(sentEnvelope.method).toBe("test.subscribe");

    // Act 2 — drive response + notify BACK-TO-BACK in the same synchronous
    // frame. NO awaits, NO `await Promise.resolve()`, NO timer ticks. This
    // is the exact coalescing pattern Codex P1 identified: a single
    // transport read parses both frames and emits both `onMessage` calls
    // before any microtask drains.
    // SubscriptionId schema is UUID-branded — the wrapper validation in
    // `#handleNotification` runs `SubscriptionNotifyParamsSchema(value)`
    // which rejects non-UUID ids with a value-phase schema error.
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
    transport.dispatchInbound(response);
    transport.dispatchInbound(notify);

    // Assert — the queued event surfaces via `next()`. If the SDK had
    // regressed to microtask-deferred registration, the notify would have
    // hit the unknown-id silent-drop branch and `next()` would block
    // forever (or, after we close the transport, resolve `undefined`).
    const first = await subscription.next();
    expect(first).toEqual({ kind: "event", seq: 1 });

    // Sanity — the dispatcher map saw exactly one registration. The
    // pending map is drained because the init response was correlated.
    expect(client.subscriptionCount).toBe(1);
    expect(client.pendingCount).toBe(0);
  });

  it("a second notify delivered in the same synchronous frame as the response also lands", async () => {
    // Stronger variant — TWO notifies coalesced with the response. This
    // pins the invariant that registration is observable to ALL inbound
    // frames in the same synchronous parse loop, not just the first one
    // after the response.
    const transport = new InMemoryTransport();
    const client = new JsonRpcClient(transport, { protocolVersion: 1 });
    const valueSchema = z.object({ kind: z.literal("event"), seq: z.number() });

    const subscription = client.subscribe<z.infer<typeof valueSchema>>(
      "test.subscribe",
      { topic: "x" },
      valueSchema,
    );

    const sentEnvelope = transport.sentEnvelopes[0];
    if (sentEnvelope === undefined || !("id" in sentEnvelope)) {
      throw new Error("unreachable — subscribe init emits a request envelope");
    }
    const requestId = sentEnvelope.id;

    const subscriptionId = "22222222-2222-4222-8222-222222222222";
    const response: JsonRpcResponseEnvelope = {
      jsonrpc: JSONRPC_VERSION,
      id: requestId,
      result: { subscriptionId },
    };
    const notify1: JsonRpcNotification = {
      jsonrpc: JSONRPC_VERSION,
      method: "$/subscription/notify",
      params: { subscriptionId, value: { kind: "event", seq: 1 } },
    };
    const notify2: JsonRpcNotification = {
      jsonrpc: JSONRPC_VERSION,
      method: "$/subscription/notify",
      params: { subscriptionId, value: { kind: "event", seq: 2 } },
    };
    transport.dispatchInbound(response);
    transport.dispatchInbound(notify1);
    transport.dispatchInbound(notify2);

    expect(await subscription.next()).toEqual({ kind: "event", seq: 1 });
    expect(await subscription.next()).toEqual({ kind: "event", seq: 2 });
    expect(client.subscriptionCount).toBe(1);
  });
});

// ----------------------------------------------------------------------------
// Phase D Round 4 F2 — malformed subscriptionId rejected at SDK boundary
// ----------------------------------------------------------------------------
//
// Codex F2 (P2): `subscribeInitResultSchema` previously accepted any
// non-empty string for `subscriptionId` (`z.string().min(1)`), looser than
// the canonical `SubscriptionIdSchema` (RFC 9562 UUID, brand-narrowed to
// `SubscriptionId`). A daemon-corruption / proxy-injection that returned a
// non-UUID `subscriptionId` was therefore registered into `#subscriptions`
// synchronously by `#handleResponse`'s defensive shape extraction
// (`typeof + length > 0`) AHEAD of the per-pending result-schema parse,
// leaving an orphan `#subscriptions` entry alive after the consumer-side
// promise rejected.
//
// The fix tightens BOTH gates simultaneously:
//   1. `subscribeInitResultSchema` now uses `SubscriptionIdSchema` directly
//      (UUID brand-narrowed). The schema's `.loose()` posture is preserved
//      so additional fields beyond `subscriptionId` (e.g. cursor) still
//      pass.
//   2. `#handleResponse`'s synchronous registration gate switched from a
//      raw `typeof + length > 0` shape probe to
//      `subscribeInitResultSchema.safeParse(env.result)`. This keeps the
//      sync-registration validation IN LOCKSTEP with the resolve-path
//      schema so a malformed init NEVER registers and the
//      `subscribe().then(err)` cleanup path's documented assumption ("no
//      `#subscriptions` entry to clean up here") stays true.
//
// This test pins the joint contract: a malformed `subscriptionId` (a) does
// NOT register synchronously, (b) surfaces as `JsonRpcSchemaError(phase:
// "result")` on the consumer-side iterator, (c) leaves no orphan entries
// behind. A regression that loosens either gate (e.g. reverts to
// `z.string().min(1)`, or restores the raw shape probe) fails one of the
// three assertions.
//
// Spec coverage:
//   * Plan-007 §Cross-Plan Obligations CP-007-4 — SDK-side wrapping
//     primitive must enforce the canonical contracts schemas.
//   * `jsonrpc-streaming.ts:166` — `SubscriptionIdSchema` is the canonical
//     UUID-branded schema.

describe("Phase D Round 4 F2 — malformed subscriptionId rejected at SDK boundary (Codex P2 regression)", () => {
  it("non-UUID subscriptionId fails the init schema; no #subscriptions entry; iterator surfaces JsonRpcSchemaError", async () => {
    // Arrange — open `subscribe()`, capture the init request id.
    const transport = new InMemoryTransport();
    const client = new JsonRpcClient(transport, { protocolVersion: 1 });
    const valueSchema = z.object({ kind: z.literal("event"), seq: z.number() });

    const subscription = client.subscribe<z.infer<typeof valueSchema>>(
      "test.subscribe",
      { topic: "x" },
      valueSchema,
    );

    expect(transport.sentEnvelopes.length).toBe(1);
    const sentEnvelope = transport.sentEnvelopes[0];
    if (sentEnvelope === undefined || !("id" in sentEnvelope)) {
      throw new Error("unreachable — subscribe init emits a request envelope");
    }
    const requestId = sentEnvelope.id;

    // Act — drive a response with a NON-UUID `subscriptionId`. Per the F2
    // fix, the synchronous gate's `subscribeInitResultSchema.safeParse(...)`
    // rejects this AND the resolve-path schema parse rejects it (same
    // schema). Registration must NOT land.
    const malformedResponse: JsonRpcResponseEnvelope = {
      jsonrpc: JSONRPC_VERSION,
      id: requestId,
      result: { subscriptionId: "not-a-uuid" },
    };
    transport.dispatchInbound(malformedResponse);

    // Assert (b) — the consumer iterator surfaces the schema error on
    // `next()`. The pending Promise rejected with `JsonRpcSchemaError(phase:
    // "result")` because the resolve-path `resultSchema.safeParse(raw)`
    // (line 617) failed, and `subscribe()`'s `.then(err)` handler called
    // `completeSubscriptionWithError(state, err)` (line 792).
    let caught: unknown = null;
    try {
      await subscription.next();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(JsonRpcSchemaError);
    if (caught instanceof JsonRpcSchemaError) {
      // CRITICAL — the rejected error carries `phase: "result"` (server-
      // corruption signal) and not `"params"` / `"value"`. The
      // `JsonRpcSchemaError` class's `phase` discriminator is the SDK's
      // documented contract for routing observability.
      expect(caught.phase).toBe("result");
      expect(caught.issues.length).toBeGreaterThan(0);
    }

    // Assert (a) — the synchronous registration gate REJECTED the malformed
    // init. `client.subscriptionCount` is the introspection knob exposing
    // `#subscriptions.size` (jsonRpcClient.ts:812-814 — test-surface
    // accessor). A regression that reverts to the loose `typeof + length`
    // probe would tick this to 1 (orphan entry); the F2 fix holds it at 0.
    expect(client.subscriptionCount).toBe(0);

    // Assert (c) — the pending request map is also drained. `#handleResponse`
    // delegates to `pending.delete(env.id)` BEFORE running the schema
    // checks (jsonRpcClient.ts:858), so the pending entry is removed
    // regardless of the validation outcome. Verifying both maps are empty
    // closes the orphan-entry surface that F2's advisor flag identified.
    expect(client.pendingCount).toBe(0);
  });

  it("a CANONICAL UUID still passes the init schema (sanity — F2 must not over-reject)", async () => {
    // Sanity guard — the F2 tightening MUST NOT break the canonical happy
    // path. A response with a valid RFC 9562 UUID `subscriptionId` registers
    // exactly once and the iterator surfaces subsequent notify values.
    // This guards against an over-zealous regression that, e.g., picked
    // a non-loose schema and dropped the additional-fields-allowed
    // posture.
    const transport = new InMemoryTransport();
    const client = new JsonRpcClient(transport, { protocolVersion: 1 });
    const valueSchema = z.object({ kind: z.literal("event"), seq: z.number() });

    const subscription = client.subscribe<z.infer<typeof valueSchema>>(
      "test.subscribe",
      { topic: "x" },
      valueSchema,
    );

    const sentEnvelope = transport.sentEnvelopes[0];
    if (sentEnvelope === undefined || !("id" in sentEnvelope)) {
      throw new Error("unreachable — subscribe init emits a request envelope");
    }
    const requestId = sentEnvelope.id;

    // Canonical RFC 9562 UUIDv4 (the literal value here is the same shape
    // `crypto.randomUUID()` produces; static literal for repeatability).
    const subscriptionId = "33333333-3333-4333-8333-333333333333";
    transport.dispatchInbound({
      jsonrpc: JSONRPC_VERSION,
      id: requestId,
      // Include an additional field beyond `subscriptionId` to verify
      // `.loose()` (passthrough) semantics survive the F2 tightening. The
      // SDK's subscribe primitive only consumes `subscriptionId`; the
      // typed wrapper layer (Plan-001 Phase 5 sessionClient) handles the
      // full shape. Dropping `.loose()` would mean future subscribe
      // handlers couldn't piggy-back additional fields on the init
      // response — a contract regression.
      result: { subscriptionId, cursor: "evt-0042" },
    });
    transport.dispatchInbound({
      jsonrpc: JSONRPC_VERSION,
      method: "$/subscription/notify",
      params: { subscriptionId, value: { kind: "event", seq: 1 } },
    });

    expect(await subscription.next()).toEqual({ kind: "event", seq: 1 });
    expect(client.subscriptionCount).toBe(1);
    expect(client.pendingCount).toBe(0);
  });
});

// ----------------------------------------------------------------------------
// Phase D Round 5 F3 — cancel() idempotency
// ----------------------------------------------------------------------------
//
// Codex F3 (P2 ACTIONABLE): `LocalSubscription.cancel()` is documented as
// idempotent (`types.ts:245-247` — "a second `cancel()` call resolves
// immediately without re-emitting the wire frame"), but the prior
// implementation only short-circuited after the state became
// `"completed"` / `"errored"`. If a caller invoked `cancel()` twice before
// the first `$/subscription/cancel` RPC resolved, both calls passed the
// guard and each emitted its own cancel request — violating the public
// contract and surfacing avoidable failures under concurrent cancellation
// patterns.
//
// The fix adds an `cancelInFlight: Promise<void> | undefined` field to the
// per-subscription state and splits `#cancelSubscription` into a public
// guard (terminal-status / cancel-before-init / in-flight) and a private
// `#emitCancelRpc` wire-emit half. The public guard registers the
// in-flight promise SYNCHRONOUSLY (before any await) so a second
// concurrent caller observes a non-undefined `cancelInFlight` and awaits
// the same promise. The wire frame is emitted exactly once.
//
// Spec coverage:
//   * `types.ts:245-247` — cancel idempotency contract.
//   * Plan-007 §Cross-Plan Obligations CP-007-4 — SDK-side wrapping
//     primitive must enforce its public surface contract.

describe("Phase D Round 5 F3 — cancel() idempotency (Codex P2 regression)", () => {
  it("concurrent cancel() emits exactly one wire frame; both promises resolve", async () => {
    // Arrange — open a subscription, drive the init response so status
    // reaches `"active"`, then issue concurrent `cancel()` calls.
    const transport = new InMemoryTransport();
    const client = new JsonRpcClient(transport, { protocolVersion: 1 });
    const valueSchema = z.object({ kind: z.literal("event"), seq: z.number() });

    const subscription = client.subscribe<z.infer<typeof valueSchema>>(
      "test.subscribe",
      { topic: "x" },
      valueSchema,
    );

    // Capture the subscribe-init request id and ack the response. Status
    // reaches `"active"` synchronously per the F2 fix's synchronous
    // registration in `#handleResponse`.
    const initEnvelope = transport.sentEnvelopes[0];
    if (initEnvelope === undefined || !("id" in initEnvelope)) {
      throw new Error("unreachable — subscribe init emits a request envelope");
    }
    const subscriptionId = "44444444-4444-4444-8444-444444444444";
    transport.dispatchInbound({
      jsonrpc: JSONRPC_VERSION,
      id: initEnvelope.id,
      result: { subscriptionId },
    });

    // Sanity — registration landed; pending map drained.
    expect(client.subscriptionCount).toBe(1);
    expect(client.pendingCount).toBe(0);

    // Act — TWO concurrent `cancel()` calls in the same synchronous frame.
    // The fix's contract: the second caller's third-guard check observes a
    // non-undefined `state.cancelInFlight` registered by the first caller
    // BEFORE its first await, awaits the same promise, and the wire emits
    // exactly one cancel frame.
    const cancelP1 = subscription.cancel();
    const cancelP2 = subscription.cancel();

    // CRITICAL — the wire frame count for cancel methods is 1, not 2.
    // Filtering by method name is robust to envelope ordering and avoids
    // brittle indexing assumptions. If a regression removed the in-flight
    // guard, both callers would push their own envelope and this would
    // tick to 2.
    const cancelEnvelopes = transport.sentEnvelopes.filter(
      (env) => "method" in env && env.method === SUBSCRIPTION_CANCEL_METHOD,
    );
    expect(cancelEnvelopes.length).toBe(1);

    // Find the cancel request id and ack it so both promises can resolve.
    const cancelEnvelope = cancelEnvelopes[0];
    if (cancelEnvelope === undefined || !("id" in cancelEnvelope)) {
      throw new Error("unreachable — cancel envelope is a request");
    }
    transport.dispatchInbound({
      jsonrpc: JSONRPC_VERSION,
      id: cancelEnvelope.id,
      result: { canceled: true },
    });

    // Both promises resolve to undefined and observe the same outcome.
    const [r1, r2] = await Promise.all([cancelP1, cancelP2]);
    expect(r1).toBeUndefined();
    expect(r2).toBeUndefined();

    // After cancel resolution the subscription is in a terminal state. The
    // `next()` call drains any queued values then resolves `undefined` per
    // the documented `pullFromSubscription` contract — the cleanest probe
    // for the `completed` status.
    const tail = await subscription.next();
    expect(tail).toBeUndefined();

    // Sanity — `#subscriptions` cleaned up by `#emitCancelRpc` after a
    // successful daemon ack.
    expect(client.subscriptionCount).toBe(0);
  });

  it("post-resolve cancel() is a no-op (third call after settlement emits no new wire frame)", async () => {
    // Arrange — same active-subscription setup; concurrent cancel followed
    // by a third call AFTER the first two have settled. Verifies the
    // terminal-status guard at the top of `#cancelSubscription` intercepts
    // post-settlement calls before the in-flight guard is even consulted.
    const transport = new InMemoryTransport();
    const client = new JsonRpcClient(transport, { protocolVersion: 1 });
    const valueSchema = z.object({ kind: z.literal("event"), seq: z.number() });

    const subscription = client.subscribe<z.infer<typeof valueSchema>>(
      "test.subscribe",
      { topic: "x" },
      valueSchema,
    );

    const initEnvelope = transport.sentEnvelopes[0];
    if (initEnvelope === undefined || !("id" in initEnvelope)) {
      throw new Error("unreachable — subscribe init emits a request envelope");
    }
    const subscriptionId = "55555555-5555-4555-8555-555555555555";
    transport.dispatchInbound({
      jsonrpc: JSONRPC_VERSION,
      id: initEnvelope.id,
      result: { subscriptionId },
    });

    // Concurrent cancel pair settles cleanly.
    const cancelP1 = subscription.cancel();
    const cancelP2 = subscription.cancel();

    const cancelEnvelopesBefore = transport.sentEnvelopes.filter(
      (env) => "method" in env && env.method === SUBSCRIPTION_CANCEL_METHOD,
    );
    expect(cancelEnvelopesBefore.length).toBe(1);

    const cancelEnvelope = cancelEnvelopesBefore[0];
    if (cancelEnvelope === undefined || !("id" in cancelEnvelope)) {
      throw new Error("unreachable — cancel envelope is a request");
    }
    transport.dispatchInbound({
      jsonrpc: JSONRPC_VERSION,
      id: cancelEnvelope.id,
      result: { canceled: true },
    });
    await Promise.all([cancelP1, cancelP2]);

    // Act — third cancel call AFTER settlement. Status is `"completed"`,
    // so the terminal-status guard returns immediately without emitting a
    // wire frame.
    const cancelP3 = subscription.cancel();

    // Assert — still exactly one cancel envelope on the wire (no new
    // frame emitted by the post-resolve call).
    const cancelEnvelopesAfter = transport.sentEnvelopes.filter(
      (env) => "method" in env && env.method === SUBSCRIPTION_CANCEL_METHOD,
    );
    expect(cancelEnvelopesAfter.length).toBe(1);

    // The third promise resolves immediately (no wire round-trip needed).
    await expect(cancelP3).resolves.toBeUndefined();
  });

  it("concurrent cancel() preserves error propagation when daemon nacks (one frame, both observe error path)", async () => {
    // Arrange — same active-subscription setup; the daemon will respond to
    // the cancel with a JSON-RPC error response. Both `cancelP1` and
    // `cancelP2` should observe the same outcome: the catch in
    // `#emitCancelRpc` swallows the error (so neither caller's
    // `cancel()` rejects), but the subscription transitions to `"errored"`
    // via `completeSubscriptionWithError`. A subsequent `subscription.next()`
    // call should reject with the wire error (`JsonRpcRemoteError`).
    const transport = new InMemoryTransport();
    const client = new JsonRpcClient(transport, { protocolVersion: 1 });
    const valueSchema = z.object({ kind: z.literal("event"), seq: z.number() });

    const subscription = client.subscribe<z.infer<typeof valueSchema>>(
      "test.subscribe",
      { topic: "x" },
      valueSchema,
    );

    const initEnvelope = transport.sentEnvelopes[0];
    if (initEnvelope === undefined || !("id" in initEnvelope)) {
      throw new Error("unreachable — subscribe init emits a request envelope");
    }
    const subscriptionId = "66666666-6666-4666-8666-666666666666";
    transport.dispatchInbound({
      jsonrpc: JSONRPC_VERSION,
      id: initEnvelope.id,
      result: { subscriptionId },
    });

    // Act — concurrent cancel; daemon responds with an error envelope.
    const cancelP1 = subscription.cancel();
    const cancelP2 = subscription.cancel();

    // Exactly one cancel frame on the wire (in-flight guard held).
    const cancelEnvelopes = transport.sentEnvelopes.filter(
      (env) => "method" in env && env.method === SUBSCRIPTION_CANCEL_METHOD,
    );
    expect(cancelEnvelopes.length).toBe(1);

    const cancelEnvelope = cancelEnvelopes[0];
    if (cancelEnvelope === undefined || !("id" in cancelEnvelope)) {
      throw new Error("unreachable — cancel envelope is a request");
    }

    // Daemon NACKs the cancel with a JSON-RPC error. The SDK's
    // `#issueRequest` reject path surfaces this as `JsonRpcRemoteError`
    // through `#emitCancelRpc`'s catch, which then runs
    // `completeSubscriptionWithError` against the shared state.
    transport.dispatchInbound({
      jsonrpc: JSONRPC_VERSION,
      id: cancelEnvelope.id,
      error: { code: -32603, message: "internal daemon failure", data: undefined },
    });

    // Both `cancel()` promises resolve (the catch in `#emitCancelRpc` does
    // NOT re-raise; it converts the wire error to local `errored` status).
    // The public `cancel()` contract is "resolve once teardown is settled
    // locally", regardless of whether the daemon ack was clean.
    await expect(cancelP1).resolves.toBeUndefined();
    await expect(cancelP2).resolves.toBeUndefined();

    // The subscription's terminal status is `"errored"` — verified via
    // the iterator surface (a pending `next()` call rejects with the
    // wire error per the `pullFromSubscription` contract for
    // `status === "errored"`).
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

    // `#subscriptions` cleaned up by the `#emitCancelRpc` catch path.
    expect(client.subscriptionCount).toBe(0);
  });
});
