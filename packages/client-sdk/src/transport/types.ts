// Client-side JSON-RPC transport contract surface — Plan-007 Phase 3
// (T-007p-3-2).
//
// This file owns the TYPE SHAPES that `jsonRpcClient.ts` consumes and that
// downstream consumers (Plan-001 Phase 5 `sessionClient.ts`, the desktop
// shell's Node-socket transport, in-memory test transports) implement against.
// It deliberately contains NO runtime imports — every export is a type or
// interface so the file emits as `.d.ts`-only at the isolated-declarations
// boundary.
//
// Spec coverage:
//   * Spec-007 line 56 — typed JSON-RPC client transport surface owed to
//     desktop renderer + CLI consumers.
//   * Plan-007 §Cross-Plan Obligations CP-007-4 — `transport/jsonRpcClient.ts`
//     + `transport/types.ts` CREATE.
//   * Plan-007 lines 309-331 — task contract for the file pair (the
//     `JsonRpcClient` class signature + `LocalSubscription<T>` /
//     `Handler<Req, Res>` shapes).
//
// What this file does NOT define (deferred to sibling files / phases):
//   * The runtime `JsonRpcClient` class implementation — owned by
//     `./jsonRpcClient.ts` (T-007p-3-2 sibling).
//   * Concrete transport implementations (Node net.Socket, in-memory, browser
//     MessagePort) — owned by Plan-001 Phase 5 + downstream test fixtures.
//     This file declares the abstract `ClientTransport` shape every
//     implementation conforms to.
//   * The `sessionClient` SDK methods — owned by Plan-001 Phase 5
//     (`packages/client-sdk/src/sessionClient.ts`, per F-007p-3-03 boundary
//     resolution + CP-007-4).
//
// Naming-collision note (advisor-flagged):
//   The CLIENT-side `LocalSubscription<T>` declared here is INTENTIONALLY
//   distinct from the SERVER-side producer `LocalSubscription<T>` in
//   `@ai-sidekicks/contracts/jsonrpc-streaming.ts` lines 352-403. The two
//   are NOT structurally compatible:
//     * Server producer: `next(value: T): void`, `complete(): void`,
//       `cancel(): void` — the handler EMITS values into this handle.
//     * Client consumer (this file): `next(): Promise<T | undefined>`,
//       `cancel(): Promise<void>`, `[Symbol.asyncIterator](): AsyncIterator<T>`
//       — the SDK caller CONSUMES values out of this handle.
//   A future phase MAY rename one (e.g. `LocalSubscriptionConsumer<T>` here
//   to disambiguate) per the Phase 2 streaming-primitive header comment
//   (lines 312-322 of jsonrpc-streaming.ts). For Phase 3 each side follows
//   its task-contract verbatim; SDK consumers import from this file (not
//   from `@ai-sidekicks/contracts`) so the name resolves to the consumer
//   shape at the call site.
//
// BLOCKED-ON-C6 — `protocolVersion` is parameterized over `number | string`
// per the audit directive; mirrors the same parameterization in
// `JsonRpcRequest.protocolVersion` at the contracts layer. When
// api-payload-contracts.md §Plan-007 declares the canonical type, this
// union narrows in place.

import type {
  HandlerContext,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponseEnvelope,
} from "@ai-sidekicks/contracts";

// --------------------------------------------------------------------------
// ClientTransport — pluggable byte-frame transport
// --------------------------------------------------------------------------

/**
 * The pluggable byte-frame transport boundary the `JsonRpcClient` consumes.
 * Implementations OWN:
 *   * Establishing and tearing down the underlying connection (Unix socket,
 *     Windows named pipe, in-memory MessagePort, etc.).
 *   * `Content-Length`-prefixed LSP framing (per Spec-007 §Wire Format) on
 *     the way out and reverse-framing on the way in. The substrate's
 *     `parseFrame` / `encodeFrame` (in
 *     `packages/runtime-daemon/src/ipc/local-ipc-gateway.ts`) is the
 *     canonical algorithm; transport implementations on the SDK side
 *     reimplement (or import via a future framing-helper move) the same
 *     framing rules.
 *   * Backpressure handling for outbound writes. The interface declares
 *     `send` as `void | Promise<void>` so Node `net.Socket` implementations
 *     can return the awaitable that resolves when the kernel buffer drains.
 *
 * The `JsonRpcClient` works at the JSON-RPC envelope layer above framing —
 * it produces `JsonRpcRequest` / `JsonRpcNotification` objects and consumes
 * `JsonRpcResponseEnvelope` / `JsonRpcNotification` objects. Bytes are the
 * transport's concern.
 *
 * Design note: this matches the MCP TypeScript SDK transport boundary
 * (per Plan-007:309 reference). Their `Transport` interface has `send`,
 * `onmessage`, `onclose`, `onerror`, `start`, `close`. We collapse `start`
 * into the constructor (the transport is connected by the time it reaches
 * the client) and treat `onerror` as a specialization of `onClose(reason)`.
 */
export interface ClientTransport {
  /**
   * Send a JSON-RPC envelope (request or notification) to the daemon.
   *
   * Implementations MUST:
   *   1. JSON-encode the envelope (`JSON.stringify`).
   *   2. Frame it with the LSP `Content-Length: <bytes>\r\n\r\n<body>`
   *      header per Spec-007 §Wire Format.
   *   3. Write the framed bytes to the underlying transport.
   *
   * The return type is `void | PromiseLike<void>` so synchronous
   * transports (in-memory test doubles), asynchronous transports (Node
   * `net.Socket` write paths that await drain), AND non-native thenables
   * (cross-realm Promises from workers/iframes, custom thenable wrappers)
   * all fit. Callers route the awaitable through `Promise.resolve(...)`
   * to absorb arbitrary thenables before attaching rejection handlers,
   * since `PromiseLike` only contractually exposes `.then` (TC39 spec)
   * — `.catch` and `.finally` are NOT guaranteed.
   */
  send(envelope: JsonRpcRequest | JsonRpcNotification): void | PromiseLike<void>;

  /**
   * Register the inbound message dispatcher. The transport MUST call the
   * handler EXACTLY ONCE per parsed inbound envelope; the handler is
   * responsible for discriminating response-vs-notification (`"id" in msg`
   * → response; otherwise notification).
   *
   * Per the JSON-RPC §5 contract, the inbound stream may carry:
   *   * `JsonRpcResponseEnvelope` — success or error responses to outbound
   *     requests (correlated by `id`).
   *   * `JsonRpcNotification` — server-emitted notifications (e.g.
   *     `$/subscription/notify` per the streaming primitive).
   *
   * The handler is registered ONCE and called for every inbound frame.
   * Implementations SHOULD throw if `onMessage` is called more than once
   * per transport instance (a single client owns the inbound stream).
   */
  onMessage(handler: (msg: JsonRpcResponseEnvelope | JsonRpcNotification) => void): void;

  /**
   * Register a transport-close observer. Called EXACTLY ONCE when the
   * transport disconnects (peer-initiated, local-initiated, or error).
   *
   * The optional `reason` carries the underlying error when available.
   * Clean shutdowns invoke the handler with `reason: undefined`. The
   * `JsonRpcClient` uses this hook to reject every in-flight request with
   * a typed transport-closed error.
   */
  onClose(handler: (reason?: Error) => void): void;

  /**
   * Initiate transport shutdown. Returns a promise that resolves when the
   * underlying connection is fully torn down (kernel buffers drained,
   * socket closed). After `close()` resolves:
   *   * The `onClose` handler has fired.
   *   * Subsequent `send()` calls MUST throw.
   *   * The transport instance is single-use; reuse requires a fresh
   *     instance.
   */
  close(): Promise<void>;
}

// --------------------------------------------------------------------------
// LocalSubscription<T> — client-side consumer handle
// --------------------------------------------------------------------------

/**
 * Client-side consumer handle returned by `JsonRpcClient.subscribe<T>`.
 * The Phase 5 `sessionClient.subscribe(...)` method (Plan-001 Phase 5
 * ownership) wraps this with typed `EventEnvelope` consumption.
 *
 * Lifecycle:
 *   1. `JsonRpcClient.subscribe(method, params, valueSchema)` returns a
 *      handle SYNCHRONOUSLY. The `subscriptionId` is initially the empty
 *      string `""` and is mutated to the daemon-issued UUID once the
 *      initial JSON-RPC response arrives. See the `subscriptionId` JSDoc
 *      below for the visibility contract.
 *   2. The daemon emits zero or more `$/subscription/notify` frames; each
 *      validated value lands in this handle's internal queue.
 *   3. The consumer calls `next()` (one-shot polling) or iterates via
 *      `for await (const v of sub)` (the iterator interface). Both paths
 *      drain the same internal queue.
 *   4. The consumer calls `cancel()` to terminate. The client emits a
 *      `$/subscription/cancel` request to the daemon and awaits the ack.
 *      Subsequent `next()` calls return `undefined` (stream complete).
 *
 * Stream-completion semantics:
 *   * Server-initiated cancel → `next()` returns `undefined` once the
 *     queue drains.
 *   * Transport disconnect → `next()` rejects with the transport-closed
 *     error from `onClose`'s reason.
 *   * Client `cancel()` → `next()` returns `undefined` once the queue
 *     drains; the cancel ack is awaited inside `cancel()`.
 *
 * Naming intentionally distinct from the SERVER-side `LocalSubscription<T>`
 * in `@ai-sidekicks/contracts/jsonrpc-streaming.ts` (see file header comment
 * for the rationale). Consumers MUST import from this file; importing from
 * `@ai-sidekicks/contracts` would resolve to the producer shape and fail
 * the call-site type-check.
 */
export interface LocalSubscription<T> {
  /**
   * The opaque subscription identifier issued by the daemon. Populated AFTER
   * the initial JSON-RPC response resolves; appears as the empty-string
   * sentinel `""` to readers before that point. **Read-only on the public
   * interface — only the SDK's internal subscribe path writes this field.**
   * Readers MUST NOT consume this field synchronously after `subscribe()`
   * returns.
   *
   * Visibility contract:
   *   * Before the initial response: empty string `""`.
   *   * After the initial response (or first iterator tick / first
   *     `next()` settle): the daemon-issued UUID per the `SubscriptionId`
   *     brand in `@ai-sidekicks/contracts/jsonrpc-streaming.ts`.
   *
   * Why `string` and not `SubscriptionId` (the branded type): the plan
   * body (Plan-007:325) names `subscriptionId: string` literally, and the
   * brand is a server-side construction concern. SDK consumers that need
   * the brand can `SubscriptionIdSchema.parse()` from `@ai-sidekicks/
   * contracts` after the field is populated.
   *
   * Alternative considered: expose as `Promise<string>` getter. Rejected
   * because the plan body is explicit on the synchronous shape, and the
   * mutation pattern matches the documented "initial response carries
   * subscriptionId" contract from T-007p-2-5 (jsonrpc-streaming.ts:84).
   * Trade-off accepted: callers reading `subscriptionId` synchronously
   * see the empty-string sentinel — JSDoc documents the contract.
   */
  readonly subscriptionId: string;

  /**
   * Pull the next value from the subscription's queue.
   *
   *   * Resolves with the next value when one is available.
   *   * Resolves with `undefined` once the stream completes (server-side
   *     cancel, client `cancel()`, or natural termination).
   *   * Rejects when the transport closes with a non-nominal reason —
   *     surfaces the transport's reason as the rejection error.
   *
   * Callers SHOULD NOT mix `next()` polling with iterator consumption;
   * both paths drain the same underlying queue and interleaved consumption
   * is implementation-defined.
   */
  next(): Promise<T | undefined>;

  /**
   * Initiate client-side cancellation. The client emits a
   * `$/subscription/cancel` JSON-RPC request to the daemon and awaits the
   * ack. After this resolves:
   *   * The daemon has removed the subscription from its per-transport map.
   *   * Subsequent `next()` calls drain any queued values, then return
   *     `undefined`.
   *   * Inbound `$/subscription/notify` frames carrying this
   *     `subscriptionId` are silently dropped (race-tolerant per
   *     T-007p-2-5's wire-frame contract — server may have queued frames
   *     before the cancel arrived).
   *
   * Idempotent: a second `cancel()` call resolves immediately without
   * re-emitting the wire frame.
   */
  cancel(): Promise<void>;

  /**
   * Asynchronous iterator factory. Returns a FRESH iterator object whose
   * `next()` resolves an `IteratorResult<T>`:
   *   * `{ value: T, done: false }` while the queue has values.
   *   * `{ value: undefined, done: true }` once the stream completes.
   *
   * Implementation detail: the returned iterator shares the same
   * underlying queue as the handle's `next()` method — `for await` over
   * this subscription is mutually exclusive with direct `next()` polling.
   *
   * Returns `AsyncIterator<T>` (not `AsyncIterableIterator<T>`) per the
   * Plan-007:328 task contract verbatim. Callers using `for await`
   * directly on the subscription work because the JS runtime invokes
   * `[Symbol.asyncIterator]()` once at loop start; mixing repeated
   * `for await` blocks against the same subscription is implementation-
   * defined for the same reason as the `next()` / iterator interleaving
   * note above.
   */
  [Symbol.asyncIterator](): AsyncIterator<T>;
}

// --------------------------------------------------------------------------
// Handler<Req, Res> — client-side handler shape (Plan-007:330)
// --------------------------------------------------------------------------

/**
 * Type alias for a typed JSON-RPC handler function. Structurally identical
 * to `Handler<P, R>` in `@ai-sidekicks/contracts/jsonrpc-registry.ts`
 * (lines 105-123); the rename to `<Req, Res>` follows the Plan-007:330
 * task contract verbatim.
 *
 * Why redeclare instead of re-export under an alias: TypeScript's
 * `export type Handler<Req, Res> = ContractsHandler<Req, Res>` pattern
 * works at the type level but loses the JSDoc surface — IDE hover on
 * `Handler<Req, Res>` would show the contracts-side `<P, R>` parameter
 * names, contradicting the SDK's documented signature. A direct
 * redeclaration keeps the parameter names and JSDoc local.
 *
 * The handler is GUARANTEED:
 *   * `params: Req` — already validated against the registered `paramsSchema`
 *     by the registry's I-007-7 enforcement (the handler never observes
 *     malformed payloads).
 *   * `ctx: HandlerContext` — the per-dispatch context populated by the
 *     substrate (`transportId` available when wired through the gateway).
 *
 * The handler MUST resolve to `Res` — the registry validates the result
 * against the registered `resultSchema` after the handler returns (defensive
 * programmer-error surface; failures map to JSON-RPC `-32603` per
 * `mapJsonRpcError`).
 *
 * SDK-side relevance: this type is exported for symmetry with the
 * server-side registration surface and for use by future SDK utilities that
 * mock handler implementations (e.g. unit tests that route SDK calls
 * through an in-process registry without the wire substrate). Phase 3 itself
 * does not consume `Handler<Req, Res>` inside `jsonRpcClient.ts` — the
 * client side calls handlers via the wire, not by direct invocation.
 */
export type Handler<Req, Res> = (params: Req, ctx: HandlerContext) => Promise<Res>;
