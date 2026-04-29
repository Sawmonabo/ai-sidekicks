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
import { JSONRPC_VERSION } from "@ai-sidekicks/contracts";

import { JsonRpcClient, JsonRpcSchemaError } from "../jsonRpcClient.js";
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
