// Typed JSON-RPC client transport — Plan-007 Phase 3 (T-007p-3-2).
//
// This file owns the SDK-side runtime that wraps a pluggable byte-frame
// transport (`ClientTransport` from `./types.ts`) with typed `call<P, R>` /
// `subscribe<T>` operations against the daemon's JSON-RPC method-namespace
// registry. Every outbound payload is Zod-validated BEFORE the wire write,
// every inbound payload is Zod-validated BEFORE it surfaces to the caller —
// the SDK does NOT swallow validation errors (per Plan-007:340 / I-007-3-T4).
//
// Spec coverage:
//   * Spec-007 line 56 — "typed JSON-RPC client transport" surface owed to
//     desktop renderer + CLI consumers.
//   * Plan-007 §Cross-Plan Obligations CP-007-4 — `transport/jsonRpcClient.ts`
//     CREATE (transport-layer + Zod wrapping primitive).
//   * Plan-007 lines 309-322 — `JsonRpcClient` class signature contract
//     (constructor + `call<P, R>` + `subscribe<T>`).
//   * MCP TypeScript SDK pattern (Plan-007:309 reference; see
//     https://github.com/modelcontextprotocol/typescript-sdk) — separation
//     of envelope-layer client from byte-framing transport.
//
// Invariants this module enforces at the client boundary (mirrors the
// daemon-side registry/dispatch invariants from Plan-007:95-117):
//   * Caller-side params validation: `paramsSchema.parse(params)` runs
//     BEFORE the wire envelope is constructed. A caller passing a malformed
//     `params` value fails fast with a typed `JsonRpcSchemaError` and never
//     reaches the daemon — the substrate would also reject (I-007-7), but
//     fail-fast at the SDK boundary keeps the error provenance local.
//   * Daemon-side result validation: every successful JSON-RPC response is
//     validated against the caller-provided `resultSchema` BEFORE the
//     promise resolves. A response that fails validation surfaces as
//     `JsonRpcSchemaError` (a CORRUPTED-SERVER signal, distinct from the
//     `-32603` daemon-internal error code). The SDK does NOT silently
//     coerce or swallow.
//   * Streaming-notify validation: every `$/subscription/notify` frame's
//     `params.value` is validated against the per-subscription `valueSchema`
//     BEFORE landing in the consumer queue. Validation failure ENDS the
//     stream with `JsonRpcSchemaError` rejected from pending `next()` calls.
//
// What this file does NOT do:
//   * Implement byte-level framing. `ClientTransport.send` / `onMessage`
//     handle Content-Length-prefixed LSP framing per Spec-007 §Wire Format.
//     This module works at the JSON-RPC envelope layer above framing.
//   * Implement the `daemon.hello` handshake. `opts.protocolVersion` is
//     attached to every outgoing request envelope per Spec-007:54
//     ("every request except health checks must carry it"); the actual
//     handshake (`call("daemon.hello", ...)`) is the caller's concern,
//     typically wired by the bootstrap code that instantiates the client.
//   * Wrap `session.*` methods. Plan-001 Phase 5 owns
//     `packages/client-sdk/src/sessionClient.ts` per F-007p-3-03 boundary
//     resolution; that file consumes `JsonRpcClient` from here.
//   * Re-implement JSON-RPC error mapping. The SDK side does the INVERSE
//     of `mapJsonRpcError` (daemon-side, in
//     `packages/runtime-daemon/src/ipc/jsonrpc-error-mapping.ts`): we
//     receive numeric error codes and surface them as a typed
//     `JsonRpcRemoteError` with `code` / `message` / optional `data`.
//
// BLOCKED-ON-C6 — `protocolVersion` is parameterized over `number | string`
// per the audit directive; mirrors the same parameterization in
// `JsonRpcRequest.protocolVersion`.

import type {
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponseEnvelope,
} from "@ai-sidekicks/contracts";
import {
  JSONRPC_VERSION,
  SUBSCRIPTION_CANCEL_METHOD,
  SUBSCRIPTION_NOTIFY_METHOD,
  SubscriptionNotifyParamsSchema,
} from "@ai-sidekicks/contracts";
import { z } from "zod";
import type { ZodType } from "zod";

import type { ClientTransport, LocalSubscription } from "./types.js";

// --------------------------------------------------------------------------
// JsonRpcErrorCode — JSON-RPC 2.0 numeric error codes (mirror of daemon-side)
// --------------------------------------------------------------------------

/**
 * JSON-RPC 2.0 spec reserved numeric error codes (per
 * https://www.jsonrpc.org/specification §5.1 "Error object"). The SDK
 * declares these locally rather than importing from `@ai-sidekicks/runtime-
 * daemon` — the SDK package deliberately depends ONLY on
 * `@ai-sidekicks/contracts` per the Tier 1 dependency direction (clients
 * depend on contracts; never on the daemon).
 *
 * The five values mirror `JsonRpcErrorCode` in
 * `packages/runtime-daemon/src/ipc/jsonrpc-error-mapping.ts` lines 102-114
 * verbatim. A future amendment that promotes this constant to
 * `@ai-sidekicks/contracts` (so daemon and SDK share one declaration) is
 * tracked under BLOCKED-ON-C7 — until the canonical project dotted-namespace
 * code table lands, the JSON-RPC numerics are duplicated across the two
 * sides for dependency-direction hygiene.
 *
 *   * `-32700 ParseError` — Invalid JSON received by the server.
 *   * `-32600 InvalidRequest` — Envelope is not a valid JSON-RPC Request.
 *   * `-32601 MethodNotFound` — Method does not exist / is not available.
 *   * `-32602 InvalidParams` — Invalid method parameter(s).
 *   * `-32603 InternalError` — Internal JSON-RPC error.
 *
 * BLOCKED-ON-C7: when error-contracts.md §Plan-007 lands, a single
 * canonical declaration in `@ai-sidekicks/contracts` replaces both the
 * daemon-side and SDK-side copies; the imports here flip in place.
 */
export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

/**
 * Type alias for the JSON-RPC numeric error code value space. Test code
 * pattern-matches on the numeric without taking a runtime dependency on the
 * `JsonRpcErrorCode` named-constant object.
 */
export type JsonRpcErrorCodeValue = (typeof JsonRpcErrorCode)[keyof typeof JsonRpcErrorCode];

// --------------------------------------------------------------------------
// Typed error classes
// --------------------------------------------------------------------------

/**
 * Thrown by the SDK when the daemon returns a JSON-RPC error response. The
 * `code` is the JSON-RPC numeric (one of the values in `JsonRpcErrorCode`,
 * or a project-extended code once BLOCKED-ON-C7 resolves), `message` is
 * the daemon-sanitized human-readable string (per I-007-8), and `data` is
 * the optional supplementary structured value.
 *
 * Distinct from `JsonRpcSchemaError` — this class wraps the wire's `error`
 * branch (the daemon's I-007-8 path), while `JsonRpcSchemaError` flags
 * SDK-internal validation failures (caller bug or server-corruption).
 */
export class JsonRpcRemoteError extends Error {
  /** The JSON-RPC numeric error code (spec §5.1; see `JsonRpcErrorCode`). */
  public readonly code: number;
  /** Optional supplementary structured data carried on `error.data`. */
  public readonly data: unknown;

  public constructor(code: number, message: string, data: unknown) {
    super(message);
    this.name = "JsonRpcRemoteError";
    this.code = code;
    this.data = data;
  }
}

/**
 * Thrown when Zod validation fails at the SDK boundary. Three failure
 * modes:
 *   * Caller-side `params` validation (caller bug — fail-fast before wire).
 *   * Server-side `result` validation (server-corruption — daemon returned
 *     malformed data).
 *   * Streaming `value` validation (server-corruption — daemon emitted a
 *     malformed `$/subscription/notify` frame).
 *
 * The `phase` field discriminates which surface fired so test code (and
 * downstream observability) can route the error appropriately. Phase 3
 * test ID I-007-3-T4 asserts on this class for the result-validation case
 * specifically.
 */
export class JsonRpcSchemaError extends Error {
  /**
   * Which validation surface fired:
   *   * `"params"` — caller passed malformed params; never reached the wire.
   *   * `"result"` — daemon returned a result that fails the caller's
   *     `resultSchema` (server-corruption signal).
   *   * `"value"` — daemon emitted a streaming `$/subscription/notify`
   *     whose `value` fails the per-subscription `valueSchema` (server-
   *     corruption signal).
   */
  public readonly phase: "params" | "result" | "value";
  /** The originating Zod issue payload (raw `ZodError.issues`). */
  public readonly issues: ReadonlyArray<unknown>;

  public constructor(phase: "params" | "result" | "value", message: string, issues: unknown) {
    super(message);
    this.name = "JsonRpcSchemaError";
    this.phase = phase;
    this.issues = Array.isArray(issues) ? issues : [];
  }
}

/**
 * Thrown by every in-flight `call` / `next()` when the underlying transport
 * disconnects. Carries the transport's reason on `cause` so callers can
 * discriminate clean shutdowns (`reason === undefined`) from error-driven
 * disconnects.
 */
export class JsonRpcTransportClosedError extends Error {
  public constructor(reason: Error | undefined) {
    super(reason !== undefined ? `Transport closed: ${reason.message}` : "Transport closed");
    this.name = "JsonRpcTransportClosedError";
    if (reason !== undefined) {
      // `cause` is the standard ECMAScript Error chaining property.
      // `Object.assign` keeps the assignment compatible with older lib targets
      // that don't model `cause` directly on Error.
      Object.assign(this, { cause: reason });
    }
  }
}

// --------------------------------------------------------------------------
// Internal pending-request entry
// --------------------------------------------------------------------------

interface PendingRequest {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly resultSchema: ZodType<unknown>;
  /**
   * When present, this pending entry is the subscribe-init request for the
   * referenced subscription. `#handleResponse` reads this and installs the
   * `#subscriptions` map entry SYNCHRONOUSLY (in the same frame as the
   * inbound response dispatch) so a coalesced `response` + first
   * `$/subscription/notify` pair — both frames parsed from one transport
   * read — finds the subscription registered when `#handleNotification`
   * runs against the second frame. Without this hook, registration would
   * happen in the `subscribe().then` microtask, which only runs AFTER the
   * current synchronous frame finishes (and the notify has already been
   * dropped against the unknown-id silent-drop branch).
   *
   * The cancel-during-pending race is preserved: the synchronous handler
   * skips registration if `state.status` has already left `"pending"`
   * (because `#cancelSubscription` ran first), and `subscribe().then`
   * still emits the best-effort wire cancel against the daemon-issued id.
   *
   * Declared as a required `| undefined` rather than an optional
   * property so that `exactOptionalPropertyTypes: true` (tsconfig) can
   * narrow correctly when the issuer passes `undefined` for a non-
   * subscribe call.
   */
  readonly subscriptionInitState: SubscriptionState<unknown> | undefined;
}

// --------------------------------------------------------------------------
// Internal subscription state
// --------------------------------------------------------------------------

/**
 * Per-subscription internal state. The handle returned to the caller
 * (`LocalSubscriptionHandle` below) holds a back-reference to this state so
 * `cancel()` and `next()` can drive it.
 *
 * Lifecycle states:
 *   * `pending` — initial response not yet arrived. Notifications targeted
 *     at this subscription are buffered (the daemon would not emit any
 *     before issuing the subscriptionId, but the SDK is defensive).
 *   * `active` — initial response arrived; subscriptionId populated;
 *     notifications drain into the queue.
 *   * `completed` — server-side cancel, client-cancel, or transport close.
 *     Subsequent `next()` calls drain remaining queue then return
 *     `undefined`.
 *   * `errored` — a `value` schema validation failure or transport error
 *     occurred. Subsequent `next()` calls reject with the stored error.
 */
type SubscriptionStatus = "pending" | "active" | "completed" | "errored";

interface SubscriptionState<T> {
  status: SubscriptionStatus;
  subscriptionId: string;
  readonly valueSchema: ZodType<T>;
  /** Queued values awaiting consumption. */
  readonly queue: Array<T>;
  /** Pending consumer awaiters (one per `next()` call past the queue). */
  readonly waiters: Array<{
    readonly resolve: (value: T | undefined) => void;
    readonly reject: (error: Error) => void;
  }>;
  /** Set when status transitions to `errored`. */
  error: Error | undefined;
}

// --------------------------------------------------------------------------
// LocalSubscription handle implementation
// --------------------------------------------------------------------------

/**
 * Concrete implementation of the `LocalSubscription<T>` interface. Holds a
 * back-reference to its `SubscriptionState<T>` and to the parent client
 * (so `cancel()` can emit the cancel wire frame).
 *
 * Why a class rather than an object literal: `[Symbol.asyncIterator]()`
 * needs to construct a fresh iterator object that closes over the same
 * state, and `subscriptionId` is mutated in place (Option A from the
 * advisor's `subscriptionId` analysis — sync return, post-init mutation).
 * A class encapsulates the mutation behind a typed accessor.
 */
class LocalSubscriptionHandle<T> implements LocalSubscription<T> {
  readonly #state: SubscriptionState<T>;
  readonly #cancel: () => Promise<void>;

  public constructor(state: SubscriptionState<T>, cancelFn: () => Promise<void>) {
    this.#state = state;
    this.#cancel = cancelFn;
  }

  public get subscriptionId(): string {
    return this.#state.subscriptionId;
  }

  public next(): Promise<T | undefined> {
    return pullFromSubscription(this.#state);
  }

  public cancel(): Promise<void> {
    return this.#cancel();
  }

  public [Symbol.asyncIterator](): AsyncIterator<T> {
    const state = this.#state;
    const cancel = (): Promise<void> => this.#cancel();
    return {
      next(): Promise<IteratorResult<T>> {
        return pullFromSubscription(state).then(
          (value): IteratorResult<T> =>
            value === undefined ? { value: undefined, done: true } : { value, done: false },
        );
      },
      /**
       * Implements early-cleanup contract — `for await ... break` triggers
       * this and we emit a wire-level cancel via the handle's `cancel()` so
       * the daemon releases its `StreamingPrimitive` entry.
       */
      async return(): Promise<IteratorResult<T>> {
        await cancel();
        return { value: undefined, done: true };
      },
    };
  }
}

/**
 * Pull the next value from a subscription's queue/waiter chain. Returns
 * `undefined` when the subscription has completed and the queue has
 * drained; rejects when the subscription has errored.
 *
 * Hoisted out of the handle class so the iterator factory can reuse the
 * same algorithm without duplicating the queue/waiter logic.
 */
function pullFromSubscription<T>(state: SubscriptionState<T>): Promise<T | undefined> {
  // Drain queued values first regardless of status — values that landed
  // before completion / error are still valid to surface.
  if (state.queue.length > 0) {
    // Non-null assertion: length > 0 guarantees `shift()` returns T, but
    // `noUncheckedIndexedAccess: true` widens the inferred type. The
    // explicit cast here is the documented pattern for queue drains.
    const value = state.queue.shift() as T;
    return Promise.resolve(value);
  }
  if (state.status === "completed") {
    return Promise.resolve(undefined);
  }
  if (state.status === "errored" && state.error !== undefined) {
    return Promise.reject(state.error);
  }
  // Park a waiter — fulfilled when the next `$/subscription/notify` lands
  // or the subscription terminates.
  return new Promise<T | undefined>((resolve, reject) => {
    state.waiters.push({ resolve, reject });
  });
}

/**
 * Push an already-validated value into a subscription's queue, draining
 * any pending waiter first.
 *
 * Precondition: the caller MUST have validated `value` against
 * `state.valueSchema` before invoking. `#handleNotification` does this at
 * the wire boundary via `SubscriptionNotifyParamsSchema(state.valueSchema)`,
 * which validates the wrapper shape AND the per-subscription `value` in a
 * single Zod parse. Centralizing the validation there (a) eliminates the
 * double-validation that previously ran here, and (b) keeps the
 * server-corruption cleanup path (`#subscriptions` map delete +
 * best-effort wire cancel) co-located with the wire-level
 * `#handleNotification` scope, where it has access to `this.call` and
 * `this.#subscriptions`.
 */
function pushSubscriptionValue<T>(state: SubscriptionState<T>, value: T): void {
  if (state.status === "completed" || state.status === "errored") {
    // Race-tolerance: notifications that arrive after cancel/error are
    // dropped per the streaming-primitive's documented contract
    // (jsonrpc-streaming.ts:373-377 — "silent no-op after `complete()` or
    // `cancel()`"). The SDK mirrors the same posture for inbound frames
    // that race against client-side cancel.
    return;
  }
  // Hand off to a waiting consumer if one exists; otherwise queue the value.
  const waiter = state.waiters.shift();
  if (waiter !== undefined) {
    waiter.resolve(value);
    return;
  }
  state.queue.push(value);
}

/**
 * Transition a subscription to `completed`. Wakes every pending waiter
 * with `undefined` (stream end). Idempotent — calling on an already-
 * terminated subscription is a no-op.
 */
function completeSubscription<T>(state: SubscriptionState<T>): void {
  if (state.status === "completed" || state.status === "errored") {
    return;
  }
  state.status = "completed";
  // Drain waiters. Queued values remain consumable per the
  // pullFromSubscription contract (drain queue first, then surface
  // status).
  while (state.waiters.length > 0) {
    const waiter = state.waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve(undefined);
    }
  }
}

/**
 * Transition a subscription to `errored`. Wakes every pending waiter with
 * the supplied error and stores it so future `next()` calls reject
 * consistently. Idempotent.
 */
function completeSubscriptionWithError<T>(state: SubscriptionState<T>, error: Error): void {
  if (state.status === "completed" || state.status === "errored") {
    return;
  }
  state.status = "errored";
  state.error = error;
  while (state.waiters.length > 0) {
    const waiter = state.waiters.shift();
    if (waiter !== undefined) {
      waiter.reject(error);
    }
  }
}

// --------------------------------------------------------------------------
// JsonRpcClient
// --------------------------------------------------------------------------

/**
 * Optional `JsonRpcClient` constructor options. Phase 3 ships with a single
 * field; the type stays open for additive extension (telemetry hooks,
 * default-timeout configuration, request-context decorators) at later
 * phases.
 *
 * BLOCKED-ON-C6 — `protocolVersion` narrows to one of `number` / `string`
 * when api-payload-contracts.md §Plan-007 declares the canonical type.
 */
export interface JsonRpcClientOptions {
  /**
   * The protocol version attached to every outgoing JSON-RPC request
   * envelope per Spec-007:54 ("every request except health checks must
   * carry it"). Phase 3 attaches the value to every request unconditionally
   * — the daemon's substrate accepts both `number` and `string` runtime
   * shapes per BLOCKED-ON-C6, so a permissive emitter is safe. When
   * undefined, the field is OMITTED from the envelope (no `undefined`
   * carry per `exactOptionalPropertyTypes: true`).
   */
  readonly protocolVersion?: number | string;
}

/**
 * Typed JSON-RPC client wrapping a `ClientTransport` with `call<P, R>` and
 * `subscribe<T>` operations. Single-instance per transport — the constructor
 * registers the inbound dispatcher and close handler exactly once.
 *
 * Usage shape (Phase 5 `sessionClient.ts` consumer):
 *   ```typescript
 *   const transport = await openLocalIpcTransport(socketPath);
 *   const client = new JsonRpcClient(transport, { protocolVersion: 1 });
 *   const session = await client.call(
 *     "session.create",
 *     payload,
 *     SessionCreateRequestSchema,
 *     SessionCreateResponseSchema,
 *   );
 *   const subscription = client.subscribe(
 *     "session.subscribe",
 *     { sessionId: session.id },
 *     EventEnvelopeSchema,
 *   );
 *   for await (const event of subscription) { ... }
 *   ```
 */
export class JsonRpcClient {
  readonly #transport: ClientTransport;
  readonly #protocolVersion: number | string | undefined;
  readonly #pending = new Map<JsonRpcId, PendingRequest>();
  readonly #subscriptions = new Map<string, SubscriptionState<unknown>>();
  #nextId = 1;
  #closed = false;
  #closeReason: Error | undefined = undefined;

  public constructor(transport: ClientTransport, opts?: JsonRpcClientOptions) {
    this.#transport = transport;
    this.#protocolVersion = opts?.protocolVersion;

    // Register inbound dispatcher exactly once per transport.
    transport.onMessage((msg) => {
      this.#handleInbound(msg);
    });

    // Register close handler — rejects all in-flight requests and ends all
    // subscriptions.
    transport.onClose((reason) => {
      this.#handleClose(reason);
    });
  }

  /**
   * Issue a typed JSON-RPC request and await the typed response.
   *
   * Thin wrapper over `#issueRequest`. See `#issueRequest`'s JSDoc for
   * the full order-of-operations and throws contract — they are identical
   * for `call`, which simply omits the subscribe-init state.
   *
   * @param method - The dotted-namespace method name (e.g. `session.create`).
   * @param params - The method's request payload.
   * @param paramsSchema - Zod schema for `P`. Validates `params` BEFORE
   *   the wire write.
   * @param resultSchema - Zod schema for `R`. Validates the daemon's
   *   `result` AFTER the wire response.
   * @returns The validated `R` value.
   */
  public async call<P, R>(
    method: string,
    params: P,
    paramsSchema: ZodType<P>,
    resultSchema: ZodType<R>,
  ): Promise<R> {
    return this.#issueRequest(method, params, paramsSchema, resultSchema, undefined);
  }

  /**
   * Internal: shared request-issuance pipeline used by both public `call`
   * and `subscribe`. The `subscriptionInitState` parameter lets subscribe
   * carry the per-subscription state object through to the pending entry
   * so `#handleResponse` can install `#subscriptions` synchronously
   * (see `PendingRequest.subscriptionInitState` JSDoc for the wire-
   * coalescing race this prevents).
   *
   * Order of operations:
   *   1. `paramsSchema.parse(params)` — fail-fast on caller-side malformed
   *      input (throws `JsonRpcSchemaError(phase: "params")`).
   *   2. Generate the next request id (monotonic numeric counter; spec
   *      §4 allows string/number/null — numeric is sufficient).
   *   3. Park a `PendingRequest` keyed by id.
   *   4. Send the framed envelope via `transport.send`.
   *   5. The promise resolves when the inbound dispatcher correlates a
   *      response by id and validates `result` against `resultSchema`
   *      (rejects with `JsonRpcSchemaError(phase: "result")` on failure).
   *      An error response rejects with `JsonRpcRemoteError`. For
   *      subscribe inits, `#handleResponse` ALSO installs `#subscriptions`
   *      synchronously before invoking `pending.resolve` so the next
   *      coalesced inbound frame can be dispatched against the new id.
   *
   * The `protocolVersion` from constructor opts is attached to every
   * outgoing envelope per Spec-007:54.
   *
   * @throws JsonRpcSchemaError - When `params` fail caller-side validation
   *   (phase: `"params"`) or `result` fails server-side validation
   *   (phase: `"result"`).
   * @throws JsonRpcRemoteError - When the daemon returns a JSON-RPC error
   *   response.
   * @throws JsonRpcTransportClosedError - When the transport disconnects
   *   before the response arrives.
   */
  async #issueRequest<P, R>(
    method: string,
    params: P,
    paramsSchema: ZodType<P>,
    resultSchema: ZodType<R>,
    subscriptionInitState: SubscriptionState<unknown> | undefined,
  ): Promise<R> {
    // Step 1: caller-side params validation. Fail-fast before any wire
    // I/O — the daemon would also reject (I-007-7), but local validation
    // keeps the error provenance close to the caller.
    const paramsParsed = paramsSchema.safeParse(params);
    if (!paramsParsed.success) {
      throw new JsonRpcSchemaError(
        "params",
        `Request params for ${method} failed schema validation`,
        paramsParsed.error.issues,
      );
    }

    // Refuse new calls on a closed transport — the `send()` would also
    // throw, but the typed error here gives consistent rejection semantics
    // for callers that may have queued a call across a close event.
    if (this.#closed) {
      throw new JsonRpcTransportClosedError(this.#closeReason);
    }

    // Step 2: allocate the request id and envelope. Numeric ids are
    // monotonically incrementing; spec §4 allows the full string/number/null
    // space but numeric is the simplest correct discriminator.
    const id = this.#allocateId();
    const envelope = this.#buildRequestEnvelope(id, method, paramsParsed.data);

    // Step 3 + 4: park the pending entry then send. Park BEFORE send so a
    // synchronous-resolution transport (in-memory test double) cannot race
    // ahead of the entry being registered. This mirrors the substrate's
    // own `state.dispatchInFlight++` ordering in
    // `local-ipc-gateway.ts`'s `#dispatchFrame` (we hold the slot before
    // permitting the response side to consume it).
    return new Promise<R>((resolve, reject) => {
      this.#pending.set(id, {
        resolve: (raw: unknown) => {
          // Step 5a: validate result against resultSchema BEFORE resolving
          // the caller's promise. Server-corruption surface (I-007-3-T4).
          const resultParsed = resultSchema.safeParse(raw);
          if (!resultParsed.success) {
            reject(
              new JsonRpcSchemaError(
                "result",
                `Response result for ${method} failed schema validation`,
                resultParsed.error.issues,
              ),
            );
            return;
          }
          resolve(resultParsed.data);
        },
        reject,
        resultSchema: resultSchema as ZodType<unknown>,
        subscriptionInitState,
      });

      // Send is the last action; if it throws synchronously, drop the
      // pending entry and surface the error.
      try {
        const sendResult = this.#transport.send(envelope);
        // `send` may return a Promise — if so, propagate rejection to the
        // caller. Note: a fulfilled-send Promise is not the response; the
        // response arrives via `onMessage`.
        if (sendResult instanceof Promise) {
          sendResult.catch((err: unknown) => {
            this.#pending.delete(id);
            reject(err instanceof Error ? err : new Error(String(err)));
          });
        }
      } catch (err) {
        this.#pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Open a typed streaming subscription against the daemon.
   *
   * Order of operations:
   *   1. Construct a `LocalSubscriptionHandle<T>` with empty `subscriptionId`
   *      (Option A — sync return, post-init mutation per advisor analysis).
   *   2. Issue an outbound `call` for `method` with the supplied `params`.
   *      The daemon's subscribe-handler (Plan-007 Phase 3 sibling, e.g.
   *      `session.subscribe`) returns `{ subscriptionId }` per T-007p-2-5
   *      contract.
   *   3. When the initial response arrives, mutate the handle's
   *      `subscriptionId` and register the subscription state against
   *      the inbound `$/subscription/notify` dispatcher.
   *   4. Each subsequent `$/subscription/notify` whose
   *      `params.subscriptionId` matches lands its `params.value` (after
   *      `valueSchema.parse`) in the handle's queue.
   *   5. The caller terminates with `handle.cancel()` — the SDK emits a
   *      `$/subscription/cancel` request and awaits ack.
   *
   * The subscribe call's `params` carries no SDK-side schema; the typed
   * sessionClient wrapper (Plan-001 Phase 5) is responsible for
   * call-site param validation.
   *
   * Note on synchronous return + asynchronous initialization: the
   * `subscriptionId` is empty until the initial response settles. Callers
   * MUST NOT consume `handle.subscriptionId` synchronously after
   * `subscribe()` returns; it is populated before the FIRST `next()` /
   * iterator tick resolves a value (because the daemon issues the id in
   * the initial response BEFORE emitting any notifications).
   *
   * @param method - The dotted-namespace subscribe method (e.g.
   *   `session.subscribe`).
   * @param params - The subscribe payload. Type-erased at this layer
   *   (`unknown`) per the Plan-007:321 contract — typed wrappers
   *   (Plan-001 Phase 5) narrow per-method.
   * @param valueSchema - Zod schema for the per-notification `value` shape.
   *   Every inbound `$/subscription/notify` is validated against this
   *   schema before reaching the consumer queue.
   * @returns A `LocalSubscription<T>` consumer handle.
   */
  public subscribe<T>(
    method: string,
    params: unknown,
    valueSchema: ZodType<T>,
  ): LocalSubscription<T> {
    const state: SubscriptionState<T> = {
      status: "pending",
      subscriptionId: "",
      valueSchema,
      queue: [],
      waiters: [],
      error: undefined,
    };

    // Pre-build the cancel function so the handle has a stable reference
    // even if the initial response is still in flight when the caller
    // invokes `cancel()`. The cancel implementation handles the
    // "id-not-yet-known" case by waiting for the initial response.
    const handle = new LocalSubscriptionHandle<T>(state, () => this.#cancelSubscription(state));

    // Issue the subscribe request. Note: we pass an `unknown`-typed
    // params/result schema pair to `call` — the wrappers (Plan-001 Phase 5
    // sessionClient) construct the typed schemas. At this layer the
    // contract is "the daemon returns at minimum `{ subscriptionId: string }`"
    // per T-007p-2-5.
    const initSchema: ZodType<{ subscriptionId: string }> = subscribeInitResultSchema as ZodType<{
      subscriptionId: string;
    }>;
    const passthroughParams: ZodType<unknown> = passthroughSchema;

    // Cast through `unknown` because `SubscriptionState<T>` has `T` in
    // contravariant position on the waiter resolve callbacks, breaking
    // direct subtype assignment to `SubscriptionState<unknown>`. The
    // dispatcher map's runtime contract is "route by subscriptionId
    // string", so erasing the type at the map boundary is correct;
    // `pushSubscriptionValue` casts back into the original `T` via the
    // captured `valueSchema`.
    const dispatcherState = state as unknown as SubscriptionState<unknown>;

    // Issue via `#issueRequest` so the pending entry carries the
    // `subscriptionInitState` metadata. This causes `#handleResponse`
    // to install `#subscriptions` synchronously when the init response
    // arrives, BEFORE the next inbound frame can be dispatched (see
    // `PendingRequest.subscriptionInitState` JSDoc for the wire-
    // coalescing race this prevents).
    void this.#issueRequest(method, params, passthroughParams, initSchema, dispatcherState).then(
      (result) => {
        // Cancel-during-pending race reconciliation: if the consumer
        // invoked `handle.cancel()` while the subscribe init was still in
        // flight, `#cancelSubscription` already settled the state to
        // `completed`. The synchronous registration in `#handleResponse`
        // saw `state.status !== "pending"` and skipped registration, so
        // the subscription is correctly detached on the dispatcher side.
        // We MUST emit a best-effort wire cancel now so the daemon
        // cleans up its subscription registry (otherwise the daemon
        // holds an orphaned subscription that only transport-close
        // reaps).
        if (state.status === "completed" || state.status === "errored") {
          void this.call(
            SUBSCRIPTION_CANCEL_METHOD,
            { subscriptionId: result.subscriptionId },
            passthroughSchema,
            cancelResultSchema,
          ).catch(() => {
            // Best-effort: swallow cancel failures. The local state is
            // already terminal; a failed cleanup-cancel cannot un-do
            // that. The daemon's transport-disconnect path is the
            // ultimate safety net if this best-effort cancel never
            // lands.
          });
          return;
        }
        // The success path is otherwise a no-op here — the synchronous
        // `#handleResponse` block already populated `state.subscriptionId`,
        // transitioned `state.status` to `"active"`, and registered the
        // state against `#subscriptions` BEFORE this microtask ran.
        //
        // DO NOT re-add `this.#subscriptions.set(...)` here. Registration
        // is intentionally synchronous in `#handleResponse` to defeat the
        // wire-coalescing race where a subscribe response and its first
        // `$/subscription/notify` arrive in the same transport read — a
        // microtask-deferred registration drops that first notification.
        // See `PendingRequest.subscriptionInitState` JSDoc for the full
        // explainer and the regression test
        // `__tests__/jsonRpcClient.test.ts > subscribe-init registers
        //  #subscriptions synchronously (Codex P1 regression)`.
      },
      (err: unknown) => {
        // Subscribe init failed. End the subscription with the error so
        // any pending iterator/await calls surface it. (If the consumer
        // already called cancel-before-init, the state is already
        // terminal; `completeSubscriptionWithError`'s status-guard
        // makes the call a no-op.) The synchronous `#handleResponse`
        // block also skipped registration (the result-shape check or
        // the schema-parse failure means no `subscriptionId` was
        // available), so there is no `#subscriptions` entry to clean
        // up here.
        completeSubscriptionWithError(state, err instanceof Error ? err : new Error(String(err)));
      },
    );

    return handle;
  }

  /**
   * Test-only inspection helper — returns the count of in-flight requests.
   * Documented as test-surface; production callers SHOULD NOT rely on this
   * count for application logic. Kept exported because the Phase 3 test
   * suite (T-007p-3-4) needs to verify pending-entry cleanup on transport
   * close.
   */
  public get pendingCount(): number {
    return this.#pending.size;
  }

  /**
   * Test-only inspection helper — returns the count of active subscriptions.
   */
  public get subscriptionCount(): number {
    return this.#subscriptions.size;
  }

  // ------------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------------

  #allocateId(): number {
    const id = this.#nextId;
    this.#nextId += 1;
    return id;
  }

  #buildRequestEnvelope(id: JsonRpcId, method: string, params: unknown): JsonRpcRequest {
    // Conditional spread for `params` (a request MAY omit `params` per
    // spec §4) and `protocolVersion` (omitted when constructor opts did
    // not carry one) per `exactOptionalPropertyTypes: true`.
    const envelope: JsonRpcRequest = {
      jsonrpc: JSONRPC_VERSION,
      id,
      method,
      ...(params !== undefined ? { params } : {}),
      ...(this.#protocolVersion !== undefined ? { protocolVersion: this.#protocolVersion } : {}),
    };
    return envelope;
  }

  #handleInbound(msg: JsonRpcResponseEnvelope | JsonRpcNotification): void {
    // Discriminate response (has `id`) from notification (no `id`).
    if ("id" in msg) {
      this.#handleResponse(msg);
      return;
    }
    this.#handleNotification(msg);
  }

  #handleResponse(env: JsonRpcResponseEnvelope): void {
    const pending = this.#pending.get(env.id);
    if (pending === undefined) {
      // Unknown id — defensive drop. A correctly-behaved daemon never
      // emits a response without a matching outbound request, but a
      // misbehaving peer / racing reconnect / proxy injection should not
      // crash the client.
      return;
    }
    this.#pending.delete(env.id);
    if ("error" in env) {
      pending.reject(new JsonRpcRemoteError(env.error.code, env.error.message, env.error.data));
      return;
    }

    // Subscribe-init synchronous registration. The daemon's wire-ordering
    // invariant (I-007-10 — the daemon writes the subscribe response
    // BEFORE the first `$/subscription/notify`) guarantees the response
    // precedes notifies on the wire, but that is only sufficient if the
    // SDK installs the subscription dispatcher entry SYNCHRONOUSLY in the
    // same frame as the response. If the parser delivers the response
    // and the first notify back-to-back from a single transport read
    // (normal coalescing on a stream socket), `#handleNotification` runs
    // immediately after this method returns — BEFORE `subscribe().then`
    // has had a chance to fire as a microtask. Without sync registration
    // here, that first notification would hit the unknown-id silent-drop
    // branch and be lost.
    //
    // We use a defensive shape extraction (typeof check) rather than
    // running `subscribeInitResultSchema.safeParse(env.result)`: the
    // schema is `{ subscriptionId: string }` so the two are equivalent
    // for any conforming response, and the per-pending result-schema
    // validation happens inside `pending.resolve(...)` immediately
    // below. If the daemon returned a malformed init response, the
    // shape check fails, registration is skipped, and the failing
    // result-schema validation surfaces via the Promise rejection on
    // the consumer side as usual.
    //
    // Cancel-during-pending: if `handle.cancel()` ran while the init
    // was in flight, `#cancelSubscription` already moved
    // `state.status` out of `"pending"`. We skip registration in that
    // case so the subscription stays detached; the
    // `subscribe().then` success branch then emits the best-effort
    // wire-level cancel against the daemon-issued id so the daemon's
    // subscription registry doesn't hold an orphan.
    if (pending.subscriptionInitState !== undefined) {
      const result = env.result;
      if (typeof result === "object" && result !== null) {
        const sid = (result as { subscriptionId?: unknown }).subscriptionId;
        if (typeof sid === "string" && sid.length > 0) {
          const state = pending.subscriptionInitState;
          if (state.status === "pending") {
            state.subscriptionId = sid;
            state.status = "active";
            this.#subscriptions.set(sid, state);
          }
        }
      }
    }

    pending.resolve(env.result);
  }

  #handleNotification(env: JsonRpcNotification): void {
    if (env.method !== SUBSCRIPTION_NOTIFY_METHOD) {
      // Unknown notification method — defensive drop. Phase 3 only knows
      // about `$/subscription/notify`. Future phases (e.g.
      // `$/subscription/complete`) will add discriminator branches.
      return;
    }
    // Route the notification to the matching subscription. We do NOT
    // pre-validate the params shape against `SubscriptionNotifyParamsSchema`
    // generically here — instead we extract the `subscriptionId` defensively
    // and look up the per-subscription state, then let
    // `pushSubscriptionValue` run the typed `valueSchema.parse` against
    // `params.value`. This keeps the value-validation surface attached to
    // the per-subscription `valueSchema` (rather than a generic schema
    // that would lose the `T` type).
    const params = env.params;
    if (typeof params !== "object" || params === null) {
      return;
    }
    const subscriptionIdRaw = (params as { subscriptionId?: unknown }).subscriptionId;
    if (typeof subscriptionIdRaw !== "string" || subscriptionIdRaw.length === 0) {
      return;
    }
    const state = this.#subscriptions.get(subscriptionIdRaw);
    if (state === undefined) {
      // Race-tolerance: a notification arrived for a subscription we no
      // longer track (cancel raced ahead, init failed, etc.). Drop silently
      // per the streaming-primitive's documented contract.
      return;
    }
    // Validate the wrapper shape (subscriptionId + value) using the
    // per-subscription valueSchema-aware factory from contracts. This
    // single Zod parse covers BOTH the wrapper shape AND the per-
    // subscription `value` — `pushSubscriptionValue` consumes the
    // validated `parsed.data.value` directly without re-validation.
    const wrapperSchema = SubscriptionNotifyParamsSchema(state.valueSchema);
    const parsed = wrapperSchema.safeParse(params);
    if (!parsed.success) {
      // Server-corruption: end the subscription with a value-phase
      // schema error. We classify wrapper-shape failures as `value` phase
      // because the SDK consumer only ever sees per-value validation
      // (the wrapper structure is an implementation detail of the
      // streaming primitive, not part of the SDK's public surface).
      completeSubscriptionWithError(
        state,
        new JsonRpcSchemaError(
          "value",
          "Streaming notification frame failed schema validation",
          parsed.error.issues,
        ),
      );
      // Remove from the dispatcher map so subsequent stray notifications
      // for this id hit the "subscription not found, drop silently" branch
      // above instead of the "errored, drop silently" guard inside
      // `pushSubscriptionValue`. Without this delete, the daemon's
      // `StreamingPrimitive` entry would persist (the producer keeps
      // calling `subscription.next(value)` and the daemon keeps framing
      // notifications the SDK silently drops).
      this.#subscriptions.delete(state.subscriptionId);
      // Best-effort wire cancel so the daemon releases its
      // `StreamingPrimitive` entry. The local state has already
      // transitioned to `errored` — the response (success or failure) is
      // irrelevant; we just need the daemon to clean up. `void` + `.catch`
      // is the documented fire-and-forget idiom in this repo.
      void this.call(
        SUBSCRIPTION_CANCEL_METHOD,
        { subscriptionId: state.subscriptionId },
        passthroughSchema,
        cancelResultSchema,
      ).catch(() => {
        // Swallow rejections (transport-closed, daemon-already-dropped-it,
        // schema-validation on the cancel ack). The local state is already
        // terminal; nothing to do on failure.
      });
      return;
    }
    // Push the wrapper-validated value. The wrapper parse already ran
    // `state.valueSchema` against `value` as part of its shape check, so
    // `parsed.data.value` is the validated `T` (erased to `unknown` at the
    // dispatcher-map boundary).
    pushSubscriptionValue(state, parsed.data.value);
  }

  #handleClose(reason: Error | undefined): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#closeReason = reason;

    const transportError = new JsonRpcTransportClosedError(reason);

    // Reject every pending request.
    for (const [, entry] of this.#pending) {
      entry.reject(transportError);
    }
    this.#pending.clear();

    // End every active subscription. Use `errored` rather than `completed`
    // when the transport closed with a non-nominal reason — consumers can
    // discriminate clean-close (resolve `undefined`) from error-close
    // (reject with the transport error) on their pending `next()` calls.
    for (const [, state] of this.#subscriptions) {
      if (reason !== undefined) {
        completeSubscriptionWithError(state, transportError);
      } else {
        completeSubscription(state);
      }
    }
    this.#subscriptions.clear();
  }

  /**
   * Internal: emit a `$/subscription/cancel` request for a subscription
   * and complete the local state once the daemon acks. The cancel wire
   * envelope is a JSON-RPC REQUEST (carries `id`) per
   * `jsonrpc-streaming.ts:252-257` — the client awaits the
   * `SubscriptionCancelResult` to confirm teardown.
   *
   * Cancel-before-init handling: if the subscribe initial response has
   * not yet settled when the caller invokes `cancel()`, the
   * `subscriptionId` is the empty-string sentinel and we cannot emit a
   * meaningful cancel here. We settle the local state to `completed`
   * (treating consumer-initiated cancel as a clean teardown — pending
   * `next()` calls resolve `undefined`, mirroring the post-init clean
   * cancel path). The race with the in-flight init response is
   * reconciled in `subscribe().then`: when the init response lands and
   * carries the daemon-issued `subscriptionId`, the success branch
   * sees `state.status === "completed"` and emits a best-effort
   * wire-level cancel against the just-issued id so the daemon
   * cleans up its subscription registry. (Without that reconcile,
   * the daemon would hold an orphaned subscription that only
   * transport-close reaps.)
   */
  async #cancelSubscription<T>(state: SubscriptionState<T>): Promise<void> {
    if (state.status === "completed" || state.status === "errored") {
      // Idempotent.
      return;
    }
    if (state.status === "pending" || state.subscriptionId === "") {
      // Cancel-before-init: end locally without a wire frame. The
      // in-flight subscribe init response, when it lands, hits the
      // race-reconciliation branch in `subscribe().then` and emits a
      // best-effort wire cancel against the daemon-issued id so the
      // daemon registry cleans up. We settle the local state to
      // `completed` (consumer-initiated cancel is a clean teardown,
      // not an error condition) so any pending `next()` calls
      // resolve `undefined`.
      completeSubscription(state);
      return;
    }
    // Active subscription — emit the cancel wire frame and await the ack.
    // The cancel result schema is the canonical
    // `SubscriptionCancelResultSchema` from contracts; we pass through
    // the standard `call` machinery so result-schema validation runs.
    try {
      await this.call(
        SUBSCRIPTION_CANCEL_METHOD,
        { subscriptionId: state.subscriptionId },
        // The cancel params + result schemas live in contracts; we
        // re-use a passthrough for params to avoid coupling the SDK to
        // the brand-validating schema (the daemon validates regardless,
        // and the SDK's params shape for cancel is internal).
        passthroughSchema,
        cancelResultSchema,
      );
    } catch (err) {
      // A failed cancel (wire error, schema corruption) still locally
      // ends the subscription — the consumer's `next()` should not hang
      // waiting for a cancel that the daemon may not have processed.
      // We surface the cancel error on the subscription so the consumer
      // can see why the stream stopped.
      completeSubscriptionWithError(state, err instanceof Error ? err : new Error(String(err)));
      // Remove from the dispatcher map so future stray notifications
      // don't reactivate it.
      this.#subscriptions.delete(state.subscriptionId);
      return;
    }
    // Successful cancel: complete the subscription and remove from
    // dispatcher.
    completeSubscription(state);
    this.#subscriptions.delete(state.subscriptionId);
  }
}

// --------------------------------------------------------------------------
// Internal helper schemas
// --------------------------------------------------------------------------
//
// These are minimal Zod schemas used inside `JsonRpcClient` to type-erase
// edge cases that don't fit the typed `call<P, R>` surface (subscribe-init
// shape, cancel-result shape, passthrough for sub-methods that bypass
// strict caller-side validation). The `z` import is hoisted to the top of
// the file alongside the other module imports.

/**
 * Passthrough schema — accepts any value verbatim. Used inside `subscribe`
 * for the params side (the typed sessionClient wrapper handles
 * per-subscription param validation upstream) and inside cancel emission
 * (the daemon owns the param validation contract).
 */
const passthroughSchema: ZodType<unknown> = z.unknown();

/**
 * Initial subscribe response shape per T-007p-2-5: at minimum
 * `{ subscriptionId: string }`. Phase 3 handlers may layer additional
 * fields (e.g. `session.subscribe` could return `{ subscriptionId, cursor }`)
 * — the schema below uses `.passthrough()`-equivalent permissive parsing
 * to accept additional fields without rejecting. The SDK's subscribe
 * primitive only consumes `subscriptionId`; the typed wrapper at the
 * sessionClient layer is responsible for the full shape.
 */
const subscribeInitResultSchema: ZodType<{ subscriptionId: string }> = z
  .object({
    subscriptionId: z.string().min(1),
  })
  .loose();

/**
 * Cancel-result schema mirrors `SubscriptionCancelResultSchema` from
 * contracts but redeclares locally to avoid the `.strict()` ⊃ runtime cast
 * pattern that the contracts factory uses. The shape is `{ canceled: boolean }`
 * per `jsonrpc-streaming.ts:288-300`.
 */
const cancelResultSchema: ZodType<{ canceled: boolean }> = z.object({
  canceled: z.boolean(),
});
