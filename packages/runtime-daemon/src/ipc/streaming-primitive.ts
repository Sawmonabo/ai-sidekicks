// Streaming primitive — `LocalSubscription<T>` server-side producer with
// `$/subscription/notify` outbound emission and `$/subscription/cancel`
// inbound handling (Plan-007 Phase 2, T-007p-2-5).
//
// Spec coverage:
//   * Spec-007 §Required Behavior (lines 43-47) + §Wire Format (lines 50-56)
//     (docs/specs/007-local-ipc-and-daemon-control.md) — Local IPC supports
//     bidirectional streaming notifications; the wire envelope is the same
//     `Content-Length`-framed JSON-RPC envelope as request/response.
//
// Invariants this module owns at the streaming boundary (canonical text in
// docs/plans/007-local-ipc-and-daemon-control.md §Invariants lines 95-117):
//   * I-007-7 (schema validation runs before handler dispatch) streaming
//     analog: every emitted `$/subscription/notify` value MUST conform to
//     the per-subscription `valueSchema` BEFORE the gateway sends the
//     frame. Validation failure throws `StreamingValidationError`
//     (programmer error — the producer returned malformed data); mirrors
//     the registry's `invalid_result` posture from
//     `MethodRegistryImpl.dispatch` step 4. The cancel-method dispatch
//     path uses the registry's standard I-007-7 path
//     (`SubscriptionCancelParamsSchema`) — no special-case handling here.
//
// Plan citations:
//   * F-007p-2-14 — Phase 2 ships the PRIMITIVE only; handler binding
//     (`session.subscribe`) lands in Phase 3 (T-007p-3-1). The streaming
//     primitive is a CONSTRUCTION-TIME utility for Phase 3 handlers; the
//     Phase 2 substrate does NOT bind it to any specific domain method.
//
// What this module does NOT do (deferred to sibling tasks):
//   * Cross-package wire-envelope schemas (`SubscriptionNotifyParamsSchema`,
//     `SubscriptionCancelParamsSchema`, the branded `SubscriptionId`,
//     and the `LocalSubscription<T>` interface) — owned by
//     `packages/contracts/src/jsonrpc-streaming.ts`. The runtime-daemon's
//     `package.json` deliberately does NOT depend on `zod`, so the Zod
//     schemas live in the contracts package; this module IMPORTS them.
//   * Outbound framing — owned by T-007p-2-1 (`local-ipc-gateway.ts`).
//     The streaming primitive emits a `JsonRpcNotification` envelope and
//     delegates the framing to a `send` callback the bootstrap
//     orchestrator wires to the gateway's per-connection write path.
//   * Phase 3 `session.subscribe` (or other domain-method) handlers that
//     bind the primitive — owned by T-007p-3-* tasks.
//
// Architectural shape — composition (NOT gateway-method patching):
//   The gateway's `#sendEnvelope(state, JsonRpcResponse | JsonRpcErrorResponse)`
//   is a private surface deliberately typed for response envelopes only;
//   notifications are not in that union (T-007p-2-1's framing decision —
//   the gateway dispatch path is request/response oriented, with
//   notifications being a SUBSTRATE-emitted side channel that the
//   gateway has no opinion on except "frame it via `encodeFrame`"). The
//   streaming primitive therefore takes a `send: (transportId, frame) =>
//   void` callback at construction; the bootstrap orchestrator wires the
//   callback to whichever per-transport write path is appropriate.
//
//   Recommendation: composition via constructor `send` callback.
//   Alternative considered: extending the gateway with a public outbound-
//     notification surface (e.g. `gateway.sendNotification(transportId,
//     frame)`).
//   Why this wins: the gateway's public surface is INTENTIONALLY MINIMAL
//     per T-007p-2-1's "Recommendation alternative considered: module-
//     singleton matching `SecureDefaults`" rationale — every public method
//     is a stability commitment. Adding a notification-emission method
//     widens the gateway's contract before Phase 3 has demonstrated the
//     final shape. Composition lets the Phase-3 wiring evolve without
//     touching the gateway, and keeps T-007p-2-5's task scope strictly
//     additive (the task contract's "out of scope: local-ipc-gateway.ts
//     modification" directive).
//   Trade-off accepted: the bootstrap orchestrator must plumb the per-
//     transport write path into the streaming primitive. Tier 1 has
//     exactly one consumer (the orchestrator), which makes the plumbing
//     a one-line lambda.
//
// `subscriptionId` is a UUID string at runtime; `crypto.randomUUID()`
// (Node 22.12+ native) emits RFC 9562 UUIDs that match
// `SubscriptionIdSchema` (`z.uuid().brand<>()`). The brand symbol
// convention follows session.ts §Branded ID Types verbatim; the
// contracts-side schema enforces it. Per BL-102 no-mirror disposition,
// the brand is canonical in `packages/contracts/src/jsonrpc-streaming.ts`
// and `api-payload-contracts.md` does not maintain a doc-side mirror.

import type {
  Handler,
  JsonRpcNotification,
  LocalSubscription,
  MethodRegistry,
  SubscriptionCancelParams,
  SubscriptionCancelResult,
  SubscriptionId,
  SubscriptionNotifyParams,
  ZodType,
} from "@ai-sidekicks/contracts";
import {
  JSONRPC_VERSION,
  SUBSCRIPTION_CANCEL_METHOD,
  SUBSCRIPTION_NOTIFY_METHOD,
  SubscriptionCancelParamsSchema,
  SubscriptionCancelResultSchema,
} from "@ai-sidekicks/contracts";

// --------------------------------------------------------------------------
// StreamingValidationError — daemon-internal validation failure
// --------------------------------------------------------------------------

/**
 * Error thrown synchronously from `LocalSubscription<T>.next(value)` when
 * the producer-supplied value fails the per-subscription `valueSchema`.
 *
 * This is a PROGRAMMER ERROR — the Phase 3 handler that registered the
 * subscription provided a `valueSchema`, and its own producer code returned
 * a value that does not match. Mirrors the `RegistryDispatchError(
 * registryCode: "invalid_result")` posture from `MethodRegistryImpl`'s
 * dispatch step 4 (`registry.ts` lines 397-405): the daemon refuses to put
 * malformed data on the wire because the client is not at fault and the
 * client cannot recover.
 *
 * Why throw synchronously rather than returning false / silently dropping:
 *   1. The handler author SHOULD see this fail at the call site so the
 *      bug is visible in the daemon's logs (not a silent data loss).
 *   2. The wire envelope is a NOTIFICATION — by JSON-RPC §4.1, the daemon
 *      MUST NOT emit a response. Even if we wanted to surface the
 *      validation failure to the client, the wire has no place to put it.
 *      Throwing in-process is the only honest signal.
 *   3. The throw escapes back to the producer's call stack, which Phase 3
 *      handler authors should observe in their unit tests. Silent drop
 *      would let regressions hide.
 *
 * `subscriptionId` is carried for diagnostics — the daemon's log lines
 * routinely correlate streaming events by `subscriptionId`, so the error
 * carries the same correlation key.
 *
 * Subclassing `Error`:
 *   * `name` is set so stack traces / `instanceof` discrimination works
 *     uniformly across the daemon's error-handling surfaces. Mirrors the
 *     pattern in `RegistryDispatchError` and `NegotiationError`.
 *   * `subscriptionId` exposes the diagnostic correlation key.
 *   * `issues` carries the raw `ZodIssue[]`-shaped array produced by
 *     `safeParse` for downstream test introspection. Type erased to
 *     `ReadonlyArray<unknown>` so the daemon doesn't re-export zod's
 *     issue shape (matches `RegistryDispatchError.issues`'s
 *     erasure-at-the-boundary pattern in `registry.ts` lines 209-221).
 */
export class StreamingValidationError extends Error {
  readonly subscriptionId: SubscriptionId;
  readonly issues: ReadonlyArray<unknown> | undefined;

  constructor(subscriptionId: SubscriptionId, message: string, issues?: ReadonlyArray<unknown>) {
    super(message);
    this.name = "StreamingValidationError";
    this.subscriptionId = subscriptionId;
    this.issues = issues;
  }
}

// --------------------------------------------------------------------------
// Internal: per-subscription entry
// --------------------------------------------------------------------------

/**
 * Storage shape for a single live subscription. Per-subscription state
 * the primitive needs to:
 *   * route an emitted value to the correct transport (`transportId`);
 *   * validate the value before send (`valueSchema`);
 *   * verify cancel ownership (the cancel handler's transport-scoped auth
 *     check compares incoming `ctx.transportId` against the entry's
 *     `transportId`);
 *   * clean up on transport disconnect (`transportId` is the reverse-
 *     index key).
 *
 * Note `valueSchema` is typed `ZodType<unknown>` for the same monomorphic-
 * storage reason `RegistryEntry.paramsSchema` is in `registry.ts` lines
 * 243-248: the per-subscription `T` is erased at storage time because a
 * single `Map<SubscriptionId, SubscriptionEntry>` holds every active
 * subscription regardless of value type.
 */
/**
 * Lifecycle state for a single subscription. Drives both the silent-no-op
 * posture of `next()` (anything other than `active` collapses to no-op) and
 * the `onCancel`-firing logic — only `canceled` triggers handler firing,
 * `complete` is intentionally inert at this seam (natural producer-driven
 * termination is already known to the producer; firing `onCancel` there
 * would be self-callback noise).
 */
type SubscriptionState = "active" | "complete" | "canceled";

interface SubscriptionEntry {
  readonly transportId: number;
  readonly valueSchema: ZodType<unknown>;
  /**
   * Mutable lifecycle marker. Transitions are monotonic: `active` →
   * `complete` (via `complete()`) OR `active` → `canceled` (via
   * `cancel()` / `cleanupTransport()` / `cancelSubscription()`). Once
   * non-`active`, subsequent teardown calls are idempotent no-ops.
   */
  state: SubscriptionState;
  /**
   * Handler queue for `onCancel`. Mutable contents (push on registration,
   * cleared after firing) so registration-after-cancel does NOT replay
   * already-fired handlers. The `readonly` modifier on the field reflects
   * the reference's stability — the array identity is set once at entry
   * construction and never reassigned.
   */
  readonly onCancelHandlers: Array<() => void>;
}

// --------------------------------------------------------------------------
// StreamingPrimitive
// --------------------------------------------------------------------------

/**
 * Constructor options for `StreamingPrimitive`.
 *
 *   * `send` — per-transport outbound notification callback. The
 *     orchestrator wires this to the gateway's per-connection
 *     `socket.write(encodeFrame(envelope))` path. The signature accepts
 *     the framing-erased `JsonRpcNotification<unknown>` envelope — the
 *     orchestrator's lambda is responsible for `encodeFrame` and
 *     `socket.write`. (The streaming primitive is FRAMING-AGNOSTIC at
 *     this seam; the gateway owns Content-Length wrapping.)
 *
 *     The callback MUST be non-throwing: a transport that has already
 *     disconnected (closed socket, broken pipe) typically logs and
 *     continues. The streaming primitive does NOT discriminate on the
 *     callback's behavior — it fires-and-forgets. (The orchestrator's
 *     `cleanupTransport` is the canonical path for closed-connection
 *     handling; transient send failures are observability concerns.)
 *
 *   * `registry` — the method-namespace registry against which the
 *     streaming primitive registers `$/subscription/cancel`. Constructor
 *     injection mirrors the gateway's pattern (`local-ipc-gateway.ts`
 *     lines 654-665). The registry's `register()` is called eagerly
 *     during `StreamingPrimitive` construction so a duplicate registration
 *     (programmer error) surfaces deterministically before any listener
 *     binds.
 */
export interface StreamingPrimitiveOptions {
  readonly send: (transportId: number, frame: JsonRpcNotification<unknown>) => void;
  readonly registry: MethodRegistry;
}

/**
 * Server-side streaming primitive. Phase 3 handlers (e.g.
 * `session.subscribe`) call `createSubscription<T>` synchronously and
 * receive a `LocalSubscription<T>` producer handle. The primitive owns:
 *
 *   * the per-subscription state map (`#subscriptions`) keyed by
 *     `subscriptionId`;
 *   * the reverse-index map (`#subscriptionsByTransport`) keyed by
 *     `transportId` so transport-disconnect cleanup is O(k) in the
 *     number of subscriptions for that transport rather than O(n)
 *     across all subscriptions;
 *   * the registered `$/subscription/cancel` handler that processes
 *     client-initiated cancellation with transport-scoped authorization.
 *
 * Per-instance lifecycle:
 *   * Constructor registers `$/subscription/cancel` on the registry at
 *     construction time (eager registration; bootstrap-deterministic).
 *   * Bootstrap orchestrator MUST call `cleanupTransport(transportId)`
 *     from the composed `onDisconnect` hook — without this, the
 *     primitive's per-subscription map leaks one entry per closed
 *     subscription. The orchestrator composes this into a combined hook
 *     alongside `ProtocolNegotiator.cleanupTransport`.
 */
export class StreamingPrimitive {
  readonly #send: (transportId: number, frame: JsonRpcNotification<unknown>) => void;
  readonly #subscriptions: Map<SubscriptionId, SubscriptionEntry>;
  // Reverse index: transportId → set of subscriptionIds owned by that
  // transport. Lets `cleanupTransport(id)` operate in O(k) where k is the
  // number of subscriptions for that transport, rather than O(n) over
  // every active subscription. Mirrors the index-pattern used in
  // collaboration-control-plane's per-session subscription map.
  readonly #subscriptionsByTransport: Map<number, Set<SubscriptionId>>;

  constructor(options: StreamingPrimitiveOptions) {
    this.#send = options.send;
    this.#subscriptions = new Map();
    this.#subscriptionsByTransport = new Map();
    // Eager registration: bootstrap-deterministic per the I-007-6
    // duplicate-registration check in `MethodRegistryImpl.register` —
    // a duplicate `$/subscription/cancel` registration (e.g. someone
    // constructed two primitives sharing one registry) throws here at
    // construction time, before any wire I/O.
    this.#registerCancelHandler(options.registry);
  }

  /**
   * Create a new subscription owned by `transportId` with values typed
   * against `valueSchema`. Returns the producer handle the Phase 3
   * handler emits values into.
   *
   * Synchronous: no I/O; the subscription is registered locally and the
   * `subscriptionId` is generated via `crypto.randomUUID()` (Node 22.12+
   * native, RFC 9562 UUID).
   *
   * The handler typically returns the `subscriptionId` to the wire client
   * (e.g. as the `result` of a `session.subscribe` request) so the client
   * can route inbound `$/subscription/notify` frames to the matching
   * consumer-side handle.
   *
   * @param transportId - The wire-side transport that owns this
   *   subscription. The reverse-index key for cleanup-on-disconnect; the
   *   ownership key for cancel-authorization (`$/subscription/cancel`
   *   from a different transport is refused).
   * @param valueSchema - Per-subscription Zod schema validating each
   *   `value` argument to `subscription.next(value)` (I-007-7 streaming
   *   analog).
   */
  createSubscription<T>(transportId: number, valueSchema: ZodType<T>): LocalSubscription<T> {
    // Branding cast: `crypto.randomUUID()` returns `string`. The runtime
    // shape matches `SubscriptionIdSchema` (UUID); the cast asserts the
    // brand. Mirrors the assertion-cast pattern used at session-id
    // generation sites in `runtime-daemon/src/sessions/projector.ts`.
    const subscriptionId = crypto.randomUUID() as SubscriptionId;

    const entry: SubscriptionEntry = {
      transportId,
      // Erase to `ZodType<unknown>` for monomorphic storage (mirrors
      // `RegistryEntry.paramsSchema` in `registry.ts` lines 327-345).
      // The runtime contract is preserved: `safeParse` is type-erased
      // and the per-subscription `T` is recovered at the call site.
      valueSchema: valueSchema as ZodType<unknown>,
      state: "active",
      onCancelHandlers: [],
    };
    this.#subscriptions.set(subscriptionId, entry);

    // Reverse-index update. `Map.get` returns `T | undefined` under
    // `noUncheckedIndexedAccess: true`; create a fresh set if this
    // transport has no prior subscriptions.
    let bucket = this.#subscriptionsByTransport.get(transportId);
    if (bucket === undefined) {
      bucket = new Set<SubscriptionId>();
      this.#subscriptionsByTransport.set(transportId, bucket);
    }
    bucket.add(subscriptionId);

    // Closure capture of `this` via arrow methods — the producer handle
    // is what the Phase 3 handler holds, so the bound methods MUST
    // close over the primitive instance.
    const send = this.#send;
    const subscriptions = this.#subscriptions;
    const removeFromTransport = (id: SubscriptionId): void => {
      const e = subscriptions.get(id);
      if (e === undefined) {
        return;
      }
      const t = this.#subscriptionsByTransport.get(e.transportId);
      if (t !== undefined) {
        t.delete(id);
        if (t.size === 0) {
          // Drop empty buckets so the reverse index doesn't accumulate
          // dead entries for transports that opened then closed
          // subscriptions but are still alive (no transport-disconnect
          // cleanup yet).
          this.#subscriptionsByTransport.delete(e.transportId);
        }
      }
    };

    const fireOnCancelHandlers = (): void => {
      // Per-handler error isolation. A handler that throws does NOT
      // prevent subsequent handlers from firing — the producer cannot
      // block cancel teardown by throwing in `onCancel`. Errors are
      // intentionally swallowed at this layer; handler authors that
      // need to surface failures must do so through their own
      // logging/metrics path. Mirrors the orchestrator-handles-it
      // posture used for `next()`'s send failures.
      for (const handler of entry.onCancelHandlers) {
        try {
          handler();
        } catch {
          // Intentional swallow — see comment above.
        }
      }
      // Clear after firing so an `onCancel` registration AFTER cancel
      // does not replay already-fired handlers. The synchronous-fire
      // branch on `onCancel` registration handles the post-cancel case.
      entry.onCancelHandlers.length = 0;
    };

    const subscription: LocalSubscription<T> = {
      subscriptionId,
      next(value: T): void {
        // Silent no-op contract: any non-`active` state collapses
        // (post-`complete()`, post-`cancel()`, or post-
        // `cleanupTransport(transportId)`). Documented in
        // `LocalSubscription.next` JSDoc.
        if (entry.state !== "active") {
          return;
        }
        // I-007-7 streaming analog: validate before send. `safeParse`
        // returns `{ success: false, error }` rather than throwing —
        // we structure the throw ourselves with the subscription
        // correlation key.
        const parsed = entry.valueSchema.safeParse(value);
        if (!parsed.success) {
          throw new StreamingValidationError(
            subscriptionId,
            `LocalSubscription.next: value validation failed for subscriptionId ${JSON.stringify(subscriptionId)} (programmer error — the producer returned a value that does not match the registered valueSchema; daemon refuses to emit malformed data on the wire)`,
            parsed.error.issues,
          );
        }
        // Construct the JSON-RPC 2.0 notification envelope. The
        // `params` shape matches `SubscriptionNotifyParams<T>` in the
        // contracts package; the validated `parsed.data` is the
        // schema-narrowed value.
        const params: SubscriptionNotifyParams<unknown> = {
          subscriptionId,
          value: parsed.data,
        };
        const frame: JsonRpcNotification<SubscriptionNotifyParams<unknown>> = {
          jsonrpc: JSONRPC_VERSION,
          method: SUBSCRIPTION_NOTIFY_METHOD,
          params,
        };
        // Route through the constructor-supplied send callback. The
        // orchestrator's lambda handles `encodeFrame` + `socket.write`;
        // a closed transport is the orchestrator's concern (silent
        // drop / observability log), not ours.
        send(entry.transportId, frame);
      },
      complete(): void {
        // Phase 2: state-only — no wire frame is emitted. Idempotent
        // via the `state !== "active"` guard. Subsequent `next()`
        // calls collapse to silent no-ops.
        //
        // Does NOT fire `onCancel` handlers: natural producer-driven
        // termination is already known to the producer; firing the
        // hook here would be self-callback noise. The contract-level
        // JSDoc on `LocalSubscription.onCancel` documents this.
        //
        // Future phases MAY introduce a `$/subscription/complete`
        // (server→client) notification; until then `complete()` and
        // `cancel()` are server-side state-only markers.
        if (entry.state !== "active") {
          return;
        }
        entry.state = "complete";
        removeFromTransport(subscriptionId);
        subscriptions.delete(subscriptionId);
      },
      cancel(): void {
        // Phase 2: state-only — server-initiated unilateral cancel.
        // Wire mechanics are identical to `complete()` (no Phase 2
        // wire frame); the semantic distinction is observable through
        // `onCancel` handler firing — `cancel()` fires handlers,
        // `complete()` does not.
        //
        // Order of operations (advisor refinement): remove-from-maps
        // BEFORE firing handlers. A handler that re-enters the
        // primitive (e.g., consults `cancelSubscription` for the same
        // id) MUST observe the post-cancel state — it would be
        // confusing for a handler firing on cancel to see its own
        // subscription still in the map.
        if (entry.state !== "active") {
          return;
        }
        entry.state = "canceled";
        removeFromTransport(subscriptionId);
        subscriptions.delete(subscriptionId);
        fireOnCancelHandlers();
      },
      onCancel(fn: () => void): void {
        // AbortSignal-style registration-after-cancel: registering on
        // an already-canceled subscription fires synchronously before
        // `onCancel` returns. Without this, an upstream resource
        // acquired AFTER cancel-fire would leak silently — the producer
        // expects the hook to clean it up regardless of timing.
        if (entry.state === "canceled") {
          try {
            fn();
          } catch {
            // Intentional swallow — same isolation as the bulk-fire
            // path; producers cannot block cancel teardown by throwing.
          }
          return;
        }
        // `complete` does NOT fire onCancel — natural producer-driven
        // termination is already known to the producer. Drop the
        // handler silently so call-site code that registers
        // unconditionally does not error.
        if (entry.state === "complete") {
          return;
        }
        entry.onCancelHandlers.push(fn);
      },
    };
    return subscription;
  }

  /**
   * Drop all subscriptions owned by a closed transport. MUST be called
   * by the bootstrap orchestrator from the gateway's `onDisconnect`
   * hook — without this, the per-subscription map leaks one entry per
   * closed transport's subscriptions.
   *
   * Idempotent: cleanup of a transport with no active subscriptions
   * (e.g. one that never opened any) is a no-op. Mirrors
   * `ProtocolNegotiator.cleanupTransport`'s contract.
   */
  cleanupTransport(transportId: number): void {
    const bucket = this.#subscriptionsByTransport.get(transportId);
    if (bucket === undefined) {
      return;
    }
    // Snapshot the bucket BEFORE iteration. An `onCancel` handler that
    // re-enters the primitive (e.g., calls `cancelSubscription` for a
    // sibling id, or constructs a fresh subscription on the same
    // transport) could mutate `bucket` mid-iteration. Snapshotting
    // decouples the iteration from concurrent mutation; the bucket
    // entry itself is dropped wholesale below.
    const subscriptionIds = [...bucket];
    this.#subscriptionsByTransport.delete(transportId);
    for (const subscriptionId of subscriptionIds) {
      // Per-subscription try/catch (advisor refinement): a single
      // subscription's catastrophic failure (or its handler chain's
      // failure escaping the per-handler isolation) MUST NOT break
      // sibling subscriptions in the bulk-cleanup loop. Defense-in-
      // depth on top of the per-handler isolation inside the closure's
      // `fireOnCancelHandlers`: the inner layer catches handler
      // throws, the outer layer catches anything else (e.g., a
      // hypothetically-throwing entry mutation).
      try {
        const entry = this.#subscriptions.get(subscriptionId);
        if (entry === undefined) {
          continue;
        }
        // Order of operations matches the closure-side `cancel()`:
        // mark canceled, remove from maps, then fire handlers. A
        // handler re-entering the primitive observes the post-cancel
        // state.
        entry.state = "canceled";
        this.#subscriptions.delete(subscriptionId);
        for (const handler of entry.onCancelHandlers) {
          try {
            handler();
          } catch {
            // Per-handler isolation — same posture as the closure's
            // bulk-fire helper. Swallow and continue to siblings.
          }
        }
        entry.onCancelHandlers.length = 0;
      } catch {
        // Per-subscription isolation — defensive, the inner code is
        // not expected to throw under the current contract. Silently
        // continue so disconnect cleanup remains best-effort across
        // the transport's full subscription set.
      }
    }
  }

  /**
   * Cancel a subscription by id WITHOUT a transport-ownership check.
   * Internal-trusted path used by the registered cancel handler AFTER
   * the handler has verified ownership. Returns `true` if the entry
   * existed and was removed, `false` if the id was unknown.
   *
   * Exposed at the class boundary (rather than inlined in the cancel
   * handler) so future callers — Phase 3 unit tests, future-phase
   * server-initiated bulk cleanup — have a single canonical seam.
   * The transport-ownership check belongs to the CALLER (load-bearing
   * security): bulk cleanup paths (`cleanupTransport`) bypass the auth
   * check by design (the transport is gone — there's no peer to
   * authorize against).
   */
  cancelSubscription(subscriptionId: SubscriptionId): boolean {
    const entry = this.#subscriptions.get(subscriptionId);
    if (entry === undefined) {
      return false;
    }
    // Order of operations matches the closure-side `cancel()`: mark
    // canceled, remove from maps, then fire handlers. A handler that
    // re-enters the primitive (e.g., consults `cancelSubscription` for
    // its own id) observes the post-cancel state.
    entry.state = "canceled";
    const bucket = this.#subscriptionsByTransport.get(entry.transportId);
    if (bucket !== undefined) {
      bucket.delete(subscriptionId);
      if (bucket.size === 0) {
        this.#subscriptionsByTransport.delete(entry.transportId);
      }
    }
    this.#subscriptions.delete(subscriptionId);
    // Per-handler error isolation — same posture as the closure's
    // bulk-fire helper. A handler that throws does NOT prevent
    // siblings from firing.
    for (const handler of entry.onCancelHandlers) {
      try {
        handler();
      } catch {
        // Intentional swallow — see closure-side `fireOnCancelHandlers`.
      }
    }
    entry.onCancelHandlers.length = 0;
    return true;
  }

  /**
   * Register the `$/subscription/cancel` handler on the supplied
   * registry. Called once during `StreamingPrimitive` construction.
   *
   * Why register as `mutating: false` (mirrors `daemon.hello`'s
   * rationale in `protocol-negotiation.ts` lines 539-561):
   *   Tearing down a wire-level subscription is PROTOCOL state, not
   *   DOMAIN state. The `RegisterOptions.mutating` flag's contract is
   *   "domain mutation requiring compatible negotiation"; subscription
   *   cancellation is the inverse — it's the wire-level resource
   *   reclamation that the version-mismatch gate SHOULD allow through
   *   so a client whose negotiation went incompatible can still clean
   *   up subscriptions opened during the previous compatible window.
   *   Classifying cancel as mutating would refuse cancellation in
   *   `done-incompatible` state, leaking subscriptions until transport
   *   close.
   *
   * Transport-scoped authorization:
   *   The handler verifies `ctx.transportId === entry.transportId`
   *   BEFORE removing the entry. A cancel from peer A targeting peer
   *   B's subscription returns `{ canceled: false }` — same observable
   *   result as "subscription does not exist", deliberately collapsed
   *   to avoid leaking the existence of subscriptions across
   *   transports (a side-channel the cancel handler MUST NOT expose).
   */
  #registerCancelHandler(registry: MethodRegistry): void {
    const handler: Handler<SubscriptionCancelParams, SubscriptionCancelResult> = async (
      params,
      ctx,
    ) => {
      // Look up the subscription. A missing entry maps to
      // `{ canceled: false }` (the wire client can interpret it as
      // "the cancel did not change daemon state — the subscription
      // either already ended naturally OR never existed under that
      // id").
      const entry = this.#subscriptions.get(params.subscriptionId);
      if (entry === undefined) {
        return { canceled: false };
      }
      // Transport-scoped authorization. Without this check, peer A
      // could enumerate / cancel peer B's subscriptions just by
      // guessing UUIDs — UUIDs are 122-bit random which makes guessing
      // statistically unlikely, but cancellation isn't predicate-
      // gated by ownership in a way that makes this safe in
      // adversarial environments. Defense-in-depth: the daemon
      // refuses cross-transport cancel by collapsing to the same
      // observable as "subscription does not exist". Load-bearing
      // security: without the check, a colluding-peer threat model
      // breaks subscription confinement.
      //
      // Note: `ctx.transportId === undefined` (e.g. unit-test direct
      // dispatch with no wire boundary) ALSO collapses to
      // `{ canceled: false }`. Test code that wants to exercise the
      // bulk-trusted teardown path uses `cancelSubscription(id)`
      // directly; the wire path requires a transport identity.
      if (ctx.transportId !== entry.transportId) {
        return { canceled: false };
      }
      const removed = this.cancelSubscription(params.subscriptionId);
      return { canceled: removed };
    };

    // Register with `mutating: false` per the rationale above. The
    // version-mismatch gate's `isMutating(SUBSCRIPTION_CANCEL_METHOD)
    // === true` evaluates to `false`, so cancel calls escape the gate
    // and remain available in `done-incompatible` state.
    registry.register(
      SUBSCRIPTION_CANCEL_METHOD,
      SubscriptionCancelParamsSchema,
      SubscriptionCancelResultSchema,
      handler,
      { mutating: false },
    );
  }
}

// --------------------------------------------------------------------------
// Zod runtime usage note
// --------------------------------------------------------------------------
//
// This module imports `ZodType` AS A TYPE ONLY, and routes the import
// through `@ai-sidekicks/contracts` (which re-exports `ZodType` for exactly
// this purpose — see `packages/contracts/src/jsonrpc-registry.ts` line 65).
// Under `verbatimModuleSyntax: true` the type-only import is erased at
// emit time, so there is no runtime dependency on `zod` from this file.
// The schemas (`SubscriptionCancelParamsSchema`,
// `SubscriptionCancelResultSchema`) live in `@ai-sidekicks/contracts` which
// DOES depend on `zod`. The runtime-daemon receives them as opaque
// `ZodType<SubscriptionCancelParams>` / `ZodType<SubscriptionCancelResult>`
// values, passes them to the registry's `register()`, and never invokes the
// Zod runtime API directly. This routing pattern mirrors `registry.ts`
// line 66 and `protocol-negotiation.ts` line 681 — the daemon never imports
// from `"zod"` itself.
