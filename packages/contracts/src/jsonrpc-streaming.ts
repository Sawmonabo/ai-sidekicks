// JSON-RPC streaming primitive contracts — `$/subscription/notify` /
// `$/subscription/cancel` wire envelopes + `LocalSubscription<T>` server-side
// producer interface for Plan-007 Phase 2 (T-007p-2-5).
//
// This file owns the CROSS-PACKAGE wire shape every streaming participant
// agrees on. The runtime IMPLEMENTATION (per-subscription state, value-
// schema validation, transport-scoped cancel authorization, cleanup on
// disconnect) lives in
// `packages/runtime-daemon/src/ipc/streaming-primitive.ts` (T-007p-2-5
// sibling).
//
// Spec coverage:
//   * Spec-007 §Wire Format (docs/specs/007-local-ipc-and-daemon-control.md
//     lines 50-56) — JSON-RPC 2.0 + LSP-style framing. The streaming
//     primitive uses LSP-style `$/`-prefixed method names for system
//     notifications (mirrors LSP's `$/cancelRequest` convention).
//   * Spec-007 §Required Behavior (lines 43-47) — Local IPC supports the
//     bidirectional stream of notifications a streaming subscription
//     produces.
//   * Plan-007 §Tier-1 Implementation Tasks line 271 (T-007p-2-5) —
//     "Streaming primitive `LocalSubscription<T>` shipped on top of T-1's
//     wire substrate + T-3's registry."
//   * F-007p-2-14 — Phase 2 ships the PRIMITIVE only; handler binding
//     (`session.subscribe`) lands in Phase 3 (T-007p-3-1).
//
// Invariants this file's interface enforces (canonical text in
// docs/plans/007-local-ipc-and-daemon-control.md §Invariants lines 95-117):
//   * I-007-7 — schema validation runs before handler dispatch. Streaming
//     analog: every emitted `$/subscription/notify` value MUST conform to
//     the per-subscription `valueSchema` BEFORE the gateway sends the
//     frame. Validation failure throws a daemon-internal
//     `StreamingValidationError` (programmer error — the producer returned
//     a malformed value); mirrors the registry's `invalid_result` posture.
//     The cancel-method dispatch path validates params via the registry's
//     standard I-007-7 path (`SubscriptionCancelParamsSchema`).
//
// What this file does NOT define (deferred to sibling tasks / phases):
//   * The runtime `StreamingPrimitive` class with `createSubscription<T>`,
//     `cleanupTransport`, `cancelSubscription` methods — owned by
//     T-007p-2-5 in `packages/runtime-daemon/src/ipc/streaming-primitive.ts`.
//   * Outbound notification framing — owned by T-007p-2-1
//     (`local-ipc-gateway.ts`). The streaming primitive's per-instance
//     `send` callback bridges to the gateway's per-connection write path;
//     the wire format is the same `Content-Length`-framed JSON-RPC
//     envelope.
//   * Concrete `session.subscribe`-style streaming handlers — owned by
//     Phase 3 (T-007p-3-1). Phase 3 binds Phase 2's primitive into a
//     domain-method handler that returns a `subscriptionId` and produces
//     values into the `LocalSubscription<T>` returned by the primitive.
//   * The CLIENT-SIDE `LocalSubscription<T>` shape (with `next(): Promise<T>`,
//     `cancel(): Promise<void>`, `[Symbol.asyncIterator]`) — owned by
//     Plan-007 Phase 3 client-sdk (lines 324-329 of plans/007). The
//     SERVER-SIDE producer interface in this file is intentionally distinct;
//     a future amendment may rename one or the other (e.g.
//     `LocalSubscriptionProducer<T>` server-side) to disambiguate at the
//     type level. For Phase 2 the server-side name follows the task
//     contract verbatim.
//
// Streaming-primitive architecture summary:
//   1. A Phase 3 handler (e.g. `session.subscribe`) calls
//      `streamingPrimitive.createSubscription<T>(transportId, valueSchema)`
//      synchronously and receives a `LocalSubscription<T>` producer
//      handle. The handler returns a typed result containing the
//      `subscriptionId` to the wire client.
//   2. The handler-side producer code calls `subscription.next(value)`
//      zero or more times. Each call validates against `valueSchema`
//      (I-007-7 streaming analog) and emits a `$/subscription/notify`
//      JSON-RPC notification on the per-transport wire.
//   3. The handler-side producer calls `subscription.complete()` when
//      the stream finishes naturally (no further values). Phase 2: this
//      is a server-side state-only marker (no Phase 2 wire frame); future
//      phases MAY introduce a `$/subscription/complete` notification.
//   4. The peer client cancels by sending a `$/subscription/cancel`
//      notification with the `subscriptionId`. The streaming primitive's
//      cancel handler verifies transport-scoped ownership
//      (cancel from peer A MUST NOT tear down peer B's subscription) and
//      removes the entry.
//   5. On transport disconnect, the bootstrap orchestrator calls
//      `streamingPrimitive.cleanupTransport(transportId)` from the
//      composed `onDisconnect` hook — every subscription owned by the
//      closed transport is dropped without further wire I/O.
//
// BLOCKED-ON-C6 — `subscriptionId` is a UUID-shaped branded type;
// `crypto.randomUUID()` (Node 22.12+ native) emits RFC 9562 UUIDs
// matching `z.uuid()`. The brand symbol convention follows session.ts
// §Branded ID Types verbatim. When api-payload-contracts.md §Plan-007
// declares the canonical streaming-id taxonomy, the brand string narrows
// in place; consumers keep the same import lines.

import { z } from "zod";

// --------------------------------------------------------------------------
// Method-name constants
// --------------------------------------------------------------------------

/**
 * Outbound `$/subscription/notify` notification method name — sent by the
 * daemon to the client whenever a producer calls `subscription.next(value)`.
 * The frame is a JSON-RPC 2.0 notification (no `id` field) per spec §4.1.
 *
 * The `$/`-prefix follows LSP convention for system-namespace methods that
 * are NOT part of the user-namespace registry (compare LSP's
 * `$/cancelRequest`). The runtime `METHOD_NAME_LSP_REGEX` in
 * `packages/runtime-daemon/src/ipc/registry.ts` line 115 accepts the
 * `$/segment[/segment]*` shape; both `$/subscription/notify` and
 * `$/subscription/cancel` match.
 *
 * BLOCKED-ON-C6 — when api-payload-contracts.md §Plan-007 lands the
 * canonical streaming method-name table, replace this constant with the
 * imported canonical string. The conservative inline form is LSP-style per
 * F-007p-2-14 leaning, so a name accepted today remains accepted under
 * the canonical taxonomy.
 *
 * Important: this method is OUTBOUND-ONLY (server-emitted). The streaming
 * primitive does NOT register a handler for it on the inbound dispatch
 * surface — the daemon never receives `$/subscription/notify` traffic; it
 * only emits it.
 */
export const SUBSCRIPTION_NOTIFY_METHOD = "$/subscription/notify" as const;
export type SubscriptionNotifyMethod = typeof SUBSCRIPTION_NOTIFY_METHOD;

/**
 * Inbound `$/subscription/cancel` notification method name — sent by the
 * client to the daemon to tear down a server-side subscription. The
 * daemon registers a handler for this method against the registry surface;
 * dispatch validates `SubscriptionCancelParamsSchema` per I-007-7 before
 * the handler runs.
 *
 * Why register as `mutating: false` (mirrors `daemon.hello`'s rationale):
 * tearing down a wire-level subscription is PROTOCOL state, not DOMAIN
 * state. Classifying cancel as mutating would refuse cancellation when
 * the connection is in `done-incompatible` state — the client could not
 * clean up subscriptions opened pre-mismatch. The non-mutating
 * classification keeps the cancellation surface available regardless of
 * negotiation state. (T-007p-2-4 §registerHandshakeMethod JSDoc lines
 * 539-561 carries the canonical version of this argument.)
 *
 * BLOCKED-ON-C6 — same replacement plan as `SUBSCRIPTION_NOTIFY_METHOD`.
 */
export const SUBSCRIPTION_CANCEL_METHOD = "$/subscription/cancel" as const;
export type SubscriptionCancelMethod = typeof SUBSCRIPTION_CANCEL_METHOD;

// --------------------------------------------------------------------------
// SubscriptionId — branded UUID type
// --------------------------------------------------------------------------

/**
 * The opaque per-subscription identifier. Branded (TypeScript nominal)
 * over a UUID string at runtime — `crypto.randomUUID()` (Node 22.12+
 * native) emits RFC 9562 UUIDs matching `z.uuid()`'s acceptance.
 *
 * Brand pattern follows session.ts §Branded ID Types verbatim:
 *   * runtime is a plain UUID string;
 *   * compile-time is a nominal type that prevents accidentally passing a
 *     `SessionId` where a `SubscriptionId` was expected.
 */
export type SubscriptionId = string & { readonly __brand: "SubscriptionId" };

/**
 * Zod schema for `SubscriptionId`. Cast through `unknown` for the same
 * reason session.ts:48-51 does — Zod's `.brand<>()` produces a
 * `$ZodBranded<>` shape whose internal symbol marker is not structurally
 * compatible with our `__brand` field, but the runtime parser is correct
 * and the public type stays nominal.
 */
export const SubscriptionIdSchema: z.ZodType<SubscriptionId> = z
  .uuid()
  .brand<"SubscriptionId">() as unknown as z.ZodType<SubscriptionId>;

// --------------------------------------------------------------------------
// $/subscription/notify — outbound notification params
// --------------------------------------------------------------------------

/**
 * The `$/subscription/notify` notification's `params` payload. Carries the
 * `subscriptionId` (so the client can route the value to the matching
 * `LocalSubscription` it holds) plus the typed `value` produced by the
 * server-side producer.
 *
 * `T` is the per-subscription value type; the runtime schema at the
 * substrate boundary is constructed via `SubscriptionNotifyParamsSchema(
 * valueSchema)` so each subscription enforces its own value contract
 * (I-007-7 streaming analog).
 *
 * Wire shape (one per `subscription.next(value)`):
 *   ```json
 *   {
 *     "jsonrpc": "2.0",
 *     "method": "$/subscription/notify",
 *     "params": { "subscriptionId": "...", "value": <T> }
 *   }
 *   ```
 */
export interface SubscriptionNotifyParams<T> {
  readonly subscriptionId: SubscriptionId;
  readonly value: T;
}

/**
 * Factory: build the per-subscription `params` schema given a `valueSchema`.
 * The schema enforces:
 *   * `subscriptionId` is a UUID-shaped branded string (matches the id the
 *     primitive issued at `createSubscription` time);
 *   * `value` conforms to the per-subscription `valueSchema` provided by
 *     the Phase 3 handler at subscription-creation time.
 *
 * The `.strict()` posture rejects unknown top-level fields — a server-side
 * regression that emitted an extra field would fail validation rather
 * than silently leaking the value. Mirrors the negotiation envelopes'
 * `.strict()` pattern (`jsonrpc-negotiation.ts` lines 165-172).
 *
 * Explicit return type annotation `z.ZodType<SubscriptionNotifyParams<T>>`
 * is REQUIRED by `isolatedDeclarations: true` in tsconfig.base.json — a
 * generic factory's return type cannot be inferred at the type-emit boundary
 * by downstream packages without an explicit annotation (TS9010).
 *
 * Cast through `unknown` for the same `exactOptionalPropertyTypes` /
 * `$ZodBranded` mismatch reason carried elsewhere in this corpus.
 */
export function SubscriptionNotifyParamsSchema<T>(
  valueSchema: z.ZodType<T>,
): z.ZodType<SubscriptionNotifyParams<T>> {
  return z
    .object({
      subscriptionId: SubscriptionIdSchema,
      value: valueSchema,
    })
    .strict() as unknown as z.ZodType<SubscriptionNotifyParams<T>>;
}

// --------------------------------------------------------------------------
// $/subscription/cancel — inbound notification params + result
// --------------------------------------------------------------------------

/**
 * The `$/subscription/cancel` notification's `params` payload. Carries
 * only the `subscriptionId` — the per-transport ownership check is the
 * primitive's responsibility (cancel from peer A MUST NOT tear down peer
 * B's subscription; the handler verifies `ctx.transportId` matches the
 * subscription's owning transport before removing the entry).
 *
 * Wire shape:
 *   ```json
 *   {
 *     "jsonrpc": "2.0",
 *     "id": <correlation-id>,
 *     "method": "$/subscription/cancel",
 *     "params": { "subscriptionId": "..." }
 *   }
 *   ```
 *
 * Note: the wire envelope is a JSON-RPC REQUEST (carries `id`), not a
 * notification — the client SHOULD know whether the cancel succeeded
 * (which the `SubscriptionCancelResult.canceled` boolean conveys). A
 * client that fires-and-forgets the cancel can still send a `null` id to
 * suppress the response per the `extractIdSafely` discriminator in the
 * gateway (§4.1 spec compliance).
 */
export interface SubscriptionCancelParams {
  readonly subscriptionId: SubscriptionId;
}

/**
 * Zod schema for `SubscriptionCancelParams`. `.strict()` rejects unknown
 * fields per the same posture as `SubscriptionNotifyParamsSchema`.
 *
 * Explicit return type annotation per `isolatedDeclarations: true`.
 */
export const SubscriptionCancelParamsSchema: z.ZodType<SubscriptionCancelParams> = z
  .object({
    subscriptionId: SubscriptionIdSchema,
  })
  .strict() as unknown as z.ZodType<SubscriptionCancelParams>;

/**
 * The `$/subscription/cancel` request's response payload.
 *
 *   * `canceled === true` — the subscription was found, owned by the
 *     calling transport, and removed.
 *   * `canceled === false` — the subscription id is unknown OR is owned
 *     by a different transport. Both branches collapse to the same
 *     observable result by design — the daemon does not differentiate
 *     "doesn't exist" from "exists but you don't own it" because the
 *     latter would leak existence of subscriptions across transports
 *     (a side-channel). Mirrors the conservative posture in
 *     `cleanupTransport`'s "idempotent on unknown id" contract.
 */
export interface SubscriptionCancelResult {
  readonly canceled: boolean;
}

/**
 * Zod schema for `SubscriptionCancelResult`. `.strict()` rejects unknown
 * fields.
 */
export const SubscriptionCancelResultSchema: z.ZodType<SubscriptionCancelResult> = z
  .object({
    canceled: z.boolean(),
  })
  .strict() as unknown as z.ZodType<SubscriptionCancelResult>;

// --------------------------------------------------------------------------
// LocalSubscription<T> — server-side producer interface
// --------------------------------------------------------------------------

/**
 * Server-side producer handle returned by
 * `StreamingPrimitive.createSubscription<T>`. The Phase 3 handler that
 * created the subscription calls these methods to emit values, signal
 * natural completion, or unilaterally cancel from the server side.
 *
 * Naming note (advisor-flagged for Phase 3 amendment):
 *   The CLIENT-side `LocalSubscription<T>` declared in Plan-007 lines
 *   324-329 carries a different shape (`next(): Promise<T | undefined>`,
 *   `cancel(): Promise<void>`, `[Symbol.asyncIterator]`). The two
 *   interfaces are intentionally distinct — the SERVER-side is a value-
 *   producing handle, the CLIENT-side is a value-consuming handle. A
 *   future Phase 3 amendment MAY rename one (e.g.
 *   `LocalSubscriptionProducer<T>` server-side, `LocalSubscriptionConsumer<T>`
 *   client-side) to disambiguate at the type level. For Phase 2 the
 *   server-side name follows the T-007p-2-5 task contract verbatim;
 *   the disambiguation is deferred to Phase 3's planning surface.
 *
 * Lifecycle:
 *   * `createSubscription` → returns a fresh `LocalSubscription<T>` with
 *     a unique `subscriptionId`. The primitive registers the subscription
 *     against the producer's `transportId` for cleanup-on-disconnect.
 *   * `next(value)` → validates against the per-subscription `valueSchema`
 *     and sends a `$/subscription/notify` frame on the producer's
 *     transport. Validation failure throws `StreamingValidationError`
 *     (programmer error; daemon-internal). After `complete()` or
 *     `cancel()` has fired, `next()` is a SILENT NO-OP — the caller's
 *     value is discarded without throwing. (Rationale: async producers
 *     race against transport-disconnect cleanup; throwing on every
 *     post-teardown emit would force every handler author to write
 *     defensive guards. The no-op posture is the documented contract.)
 *   * `complete()` → marks the subscription as complete from the producer's
 *     side. Phase 2: state-only (no Phase 2 wire frame is emitted —
 *     `$/subscription/complete` is a future-phase concern). Future
 *     `next(value)` calls are silent no-ops. Idempotent.
 *   * `cancel()` → server-initiated unilateral cancel. Removes the entry
 *     from the primitive's per-subscription map. Phase 2: state-only;
 *     a future-phase `$/subscription/cancel` (server→client) frame may
 *     supplement. Future `next(value)` calls are silent no-ops.
 *     Idempotent.
 *   * `onCancel(fn)` → register a callback that fires when the
 *     subscription terminates via an externally-imposed cancel
 *     (`cancel()`, `cleanupTransport()` on transport disconnect, or
 *     a CLIENT-initiated `$/subscription/cancel` wire frame). Does
 *     NOT fire on `complete()` — natural producer-driven termination
 *     is already known to the producer. Used by handlers to release
 *     upstream resources (e.g., dispose an in-memory event-bus
 *     watcher, abort an in-flight fetch) without leaking on cancel.
 *
 * Note: the SERVER-side `cancel()` is distinct from the CLIENT-initiated
 * `$/subscription/cancel` notification handled by the registered
 * cancel-method handler. Both paths lead to entry-removal but originate
 * differently. `onCancel` handlers fire on BOTH paths plus
 * `cleanupTransport`.
 */
export interface LocalSubscription<T> {
  /**
   * The opaque subscription identifier. The Phase 3 handler returns this
   * value to the client in its typed result; the client uses it to route
   * inbound `$/subscription/notify` frames to the matching consumer-side
   * handle.
   */
  readonly subscriptionId: SubscriptionId;

  /**
   * Emit a value to the client. The runtime validates `value` against the
   * per-subscription `valueSchema` provided at creation time (I-007-7
   * streaming analog) and constructs a `$/subscription/notify`
   * notification frame on the producer's transport.
   *
   * @throws StreamingValidationError when `value` fails the per-subscription
   *   schema. Programmer error — the producer returned a value that does
   *   not match the registered shape. Daemon-internal; T-007p-2-2's
   *   error-mapping does not promote this to a wire response (the wire
   *   envelope is a NOTIFICATION, which by spec §4.1 receives no
   *   response).
   *
   * Silent no-op after `complete()` or `cancel()` — the value is
   * discarded without throwing or sending. The `T` parameter type is
   * preserved at the signature level so call-site type-checking against
   * the per-subscription value type still applies.
   */
  next(value: T): void;

  /**
   * Mark the subscription as complete from the producer's side. Phase 2:
   * state-only — no wire frame is emitted at this layer. Future phases
   * MAY introduce a `$/subscription/complete` (server→client) notification.
   *
   * Idempotent. After `complete()`, subsequent `next(value)` calls are
   * silent no-ops.
   */
  complete(): void;

  /**
   * Server-initiated unilateral cancel. Removes the entry from the
   * primitive's per-subscription map. Phase 2: state-only; future-phase
   * `$/subscription/cancel` (server→client) frames may supplement.
   *
   * Idempotent. After `cancel()`, subsequent `next(value)` calls are
   * silent no-ops. Distinct from the CLIENT-initiated
   * `$/subscription/cancel` notification handled by the registered
   * cancel-method handler — both paths lead to entry-removal but
   * originate differently.
   */
  cancel(): void;

  /**
   * Register a callback that fires once when the subscription terminates
   * via an EXTERNALLY-IMPOSED cancel — i.e., one of:
   *
   *   * `cancel()` (server-initiated unilateral cancel)
   *   * `cleanupTransport()` (transport-disconnect bulk cleanup driven
   *     by the bootstrap orchestrator's `onDisconnect` composition)
   *   * CLIENT-initiated `$/subscription/cancel` notification, which
   *     the streaming primitive's registered cancel-method handler
   *     dispatches via `cancelSubscription(transportId, subscriptionId)`
   *
   * Handlers do NOT fire on `complete()` — natural producer-driven
   * termination is by definition already known to the producer; firing
   * `onCancel` there would be self-callback noise.
   *
   * Semantics:
   *
   *   * Multiple registrations are allowed; handlers fire in registration
   *     order.
   *   * Per-handler error isolation: a handler that throws does NOT
   *     prevent subsequent handlers from firing. Errors are caught and
   *     swallowed at this layer (handlers are intentionally fire-and-
   *     forget — the producer cannot block cancel teardown). Handler
   *     authors that need to surface failures must do so through their
   *     own logging/metrics path.
   *   * Handlers fire AFTER the entry is removed from the per-
   *     subscription / per-transport maps, so a handler that re-enters
   *     the primitive (e.g., consults `cancelSubscription` for the same
   *     id) observes the post-cancel state.
   *   * Mirrors AbortSignal-style semantics: registering an `onCancel`
   *     handler on an ALREADY-canceled subscription fires the handler
   *     synchronously before `onCancel` returns. This makes the lifecycle
   *     hook robust to race conditions where an upstream resource is
   *     acquired after cancel has already fired (the handler still runs
   *     and releases the resource, rather than leaking).
   *   * Idempotent registration: registering the same function reference
   *     twice queues two separate firings. Callers that need single-fire
   *     semantics must dedupe at the call site.
   *
   * Used by Phase 3 handlers (e.g., `session.subscribe`) to release
   * upstream resources — the discarded `unsubscribe` handle from
   * `subscribeToSession` is the canonical leak this hook closes.
   */
  onCancel(fn: () => void): void;
}
