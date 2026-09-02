// `session.subscribe` JSON-RPC handler — Plan-007 Phase 3 (T-007p-3-1).
//
// Spec coverage:
//   * `Spec-007 §Required Behavior` + `Spec-007 §Interfaces And Contracts` —
//     `session.subscribe` opens a server-side streaming subscription on the
//     Phase 2 streaming primitive (T-007p-2-5). The wire request carries the
//     `sessionId` (and optional `afterCursor` for replay-from-cursor); the
//     wire response carries ONLY the opaque `subscriptionId`. Subsequent
//     per-event `SessionEvent` values flow as `$/subscription/notify`
//     frames keyed by that `subscriptionId`. Client-initiated teardown is
//     a `$/subscription/cancel` notification referencing the same id;
//     the streaming primitive's registered cancel handler (eager-
//     registered at primitive construction time) processes it.
//   * Plan-007 §Tier-1 Implementation Tasks (T-007p-3-1) — bind the four
//     `session.*` handlers; this file is the `subscribe` slice. Per
//     F-007p-2-14, Phase 2 ships the streaming primitive only and Phase 3
//     binds it into a domain-method handler — this file IS that binding.
//   * CP-007-1 — verifies the handler is registered against the canonical
//     method name with the correct mutating-flag.
//
// Invariants this module participates in (canonical text in
// `docs/plans/007-local-ipc-and-daemon-control.md §Invariants`, I-007-6 through I-007-9):
//   * I-007-1 — load-before-bind: `registerSessionSubscribe` is called by
//     the bootstrap orchestrator AFTER the registry is loaded and AFTER
//     the streaming primitive has been constructed (the primitive eagerly
//     registers its `$/subscription/cancel` handler at construction time
//     per `streaming-primitive.ts` lines 245-255, so the primitive MUST
//     exist before this handler binds, otherwise the per-subscription
//     teardown plumbing is incomplete).
//   * I-007-6 — duplicate-method registration is rejected at register-time.
//   * I-007-7 — schema-validates-before-dispatch. The registry's standard
//     `safeParse` path runs against `SessionSubscribeRequestSchema` before
//     this handler's body executes. The streaming-side analog (per-value
//     `valueSchema` validation before `$/subscription/notify` send) runs
//     INSIDE the streaming primitive on every `subscription.next(value)`
//     call against the `SessionEventSchema` passed to `createSubscription`.
//   * I-007-8 — sanitized error mapping. Errors thrown from the handler
//     are caught by the registry's `dispatch()` wrapper and mapped to the
//     canonical JSON-RPC error envelope.
//
// Why `mutating: false`: opening a subscription does not mutate domain
// state — it allocates per-subscription IPC state (a `LocalSubscriptionProducer`
// entry on the streaming primitive's per-transport map) but does not
// create / append / mutate any session-level row or event. The pre-
// handshake mutating-op gate's predicate is `isMutating(method) ===
// true`; flagging `subscribe` as `false` means a connection in `pre` or
// `done-incompatible` state can still subscribe, matching Spec-007
// §Fallback Behavior — read-only compatibility continues across version
// mismatch. (Mirrors the rationale documented for `$/subscription/cancel`
// in `jsonrpc-streaming.ts` lines 129-137.)
//
// What this file does NOT do (deferred to siblings / known limitations):
//   * Replay-from-cursor implementation (`afterCursor`) — owned by the
//     daemon's session service / projector. The `SessionSubscribeDeps.subscribeToSession`
//     callback receives the `afterCursor` and is responsible for replaying
//     historical events before transitioning to live-tail.
//   * Test coverage — owned by T-007p-3-4 (sibling task).
//
// Method-name format ratified: dotted-camelCase per
// `docs/architecture/contracts/api-payload-contracts.md §JSON-RPC Method-Name Registry (Tier 1 Ratified)`.
// The `register` call site below passes `"session.subscribe"`, which matches
// the canonical regex.

import type {
  Handler,
  MethodRegistry,
  SessionEvent,
  SessionId,
  SessionSubscribeRequest,
  SessionSubscribeResponse,
} from "@ai-sidekicks/contracts";
import {
  SessionEventSchema,
  SessionSubscribeRequestSchema,
  SessionSubscribeResponseSchema,
} from "@ai-sidekicks/contracts";
import type { EventCursor } from "@ai-sidekicks/contracts";

import { createSubscriptionAckBarrier } from "../subscription-ack-barrier.js";
import type { StreamingPrimitive } from "../streaming-primitive.js";

/**
 * Dependencies required by `session.subscribe`'s handler closure.
 *
 * Two slots:
 *   * `streamingPrimitive` — the Phase 2 primitive instance the bootstrap
 *     orchestrator constructed and shares across every streaming handler.
 *     The handler calls `createSubscription<SessionEvent>(transportId,
 *     SessionEventSchema)` synchronously at dispatch time and receives a
 *     `LocalSubscriptionProducer<SessionEvent>` producer handle.
 *   * `subscribeToSession` — the upstream event-source callback. The
 *     handler invokes it with the request's `sessionId` + optional
 *     `afterCursor` and an `onEvent` lambda that calls
 *     `sub.next(event)` on the streaming primitive's producer. The
 *     callback returns an `unsubscribe` handle for upstream-side
 *     teardown; the handler registers it via `sub.onCancel` so that
 *     wire-cancel, transport-disconnect, AND trusted-internal
 *     teardown paths all propagate cleanup back to the upstream
 *     event source.
 *
 * The bootstrap orchestrator (Plan-001 Phase 5) supplies the concrete
 * implementation. T-007p-3-4 (sibling test) injects test doubles for
 * deterministic streaming-primitive interaction tests.
 */
export interface SessionSubscribeDeps {
  /**
   * The Phase 2 streaming primitive instance the orchestrator
   * constructed. Shared across every streaming handler so the per-
   * transport reverse-index (used by `cleanupTransport`) is unified.
   */
  readonly streamingPrimitive: StreamingPrimitive;

  /**
   * Subscribe to a session's event stream, replaying historical events
   * after `afterCursor` (when provided) before transitioning to live-
   * tail. The implementation MUST call `onEvent(event)` for every
   * `SessionEvent` produced; the handler routes those calls to the
   * streaming primitive's producer.
   *
   * Returns an `unsubscribe` callback the handler registers via
   * `sub.onCancel` to propagate teardown upstream when the wire client
   * cancels, the transport disconnects, or `cancelSubscription` runs.
   *
   * **Re-entrant safety precondition.** The returned `unsubscribe`
   * callback MAY be invoked synchronously from inside the `onEvent`
   * call stack (the live-tail catch's `sub.next()` failure path
   * cancels the subscription, which fires registered `onCancel`
   * handlers — including this `unsubscribe` — while the upstream's
   * emit frame is still on the stack). Implementations MUST tolerate
   * being unsubscribed mid-emit (e.g. snapshot-during-emit or queued-
   * removal) without corrupting the listener iteration or double-
   * delivering the in-flight event.
   *
   * Domain-side errors during subscription setup (session not found,
   * invalid `afterCursor`, permission denied) MUST surface as thrown
   * `Error` instances — the registry's `dispatch()` wrapper catches
   * them and applies `mapJsonRpcError` per I-007-8.
   */
  readonly subscribeToSession: (
    sessionId: SessionId,
    afterCursor: EventCursor | undefined,
    onEvent: (event: SessionEvent) => void,
  ) => () => void;
}

/**
 * Bind the `session.subscribe` handler onto the supplied method registry.
 *
 * Mutating flag: `mutating: false`. Subscribing does not mutate domain
 * state; see the file header for the full rationale.
 *
 * Handler shape:
 *   1. Refuse `ctx.transportId === undefined` — per-connection state
 *      (the streaming primitive's per-transport reverse-index) requires
 *      a transport identity. A missing transport id means the call
 *      originated from direct test code (or a daemon-bootstrap bug) —
 *      neither is a client protocol violation, so we throw a plain Error
 *      which `mapJsonRpcError` collapses to `-32603 InternalError` per
 *      error-contracts.md §JSON-RPC Wire Mapping (the honest mapping for
 *      a substrate-internal invariant violation). Mirrors the same
 *      posture in `protocol-negotiation.ts`'s `daemon.hello` handler.
 *   2. Call `streamingPrimitive.createSubscription<SessionEvent>(
 *      transportId, SessionEventSchema)` to allocate the producer handle.
 *      The primitive generates a fresh `subscriptionId`, registers the
 *      entry on the per-transport reverse-index, and returns a
 *      `LocalSubscriptionProducer<SessionEvent>`.
 *   3. Wire the upstream event-source callback to the producer handle
 *      through the shared subscribe-init ordering barrier: every
 *      `onEvent(event)` invocation routes to `barrier.emit(event)`, which
 *      buffers the value until the init response has been written and
 *      thereafter forwards it to `sub.next(event)` — validating against
 *      `SessionEventSchema` (I-007-7 streaming analog) and emitting a
 *      `$/subscription/notify` frame on the transport. Releasing the
 *      barrier is step 3.5; it schedules the buffered flush past the
 *      response, which is what makes I-007-10 hold under a synchronous
 *      replay.
 *   4. Return `{ subscriptionId }` — the wire client receives only the
 *      opaque id, then routes inbound `$/subscription/notify` frames
 *      keyed by it. Per `streaming-primitive.ts` line 267: "The handler
 *      typically returns the `subscriptionId` to the wire client".
 *
 * Idempotency / re-registration: see `registerSessionCreate` JSDoc.
 * I-007-6 rejects duplicate registration at register-time.
 */
export function registerSessionSubscribe(
  registry: MethodRegistry,
  deps: SessionSubscribeDeps,
): void {
  const handler: Handler<SessionSubscribeRequest, SessionSubscribeResponse> = async (
    params,
    ctx,
  ) => {
    if (ctx.transportId === undefined) {
      throw new Error(
        "session.subscribe: handler requires ctx.transportId (per-connection streaming state requires a transport identity)",
      );
    }
    const transportId = ctx.transportId;

    // Allocate the producer handle. Synchronous: no I/O. The primitive
    // generates a fresh `subscriptionId` via `crypto.randomUUID()` and
    // registers the per-transport reverse-index entry.
    const sub = deps.streamingPrimitive.createSubscription<SessionEvent>(
      transportId,
      SessionEventSchema,
    );

    // Wire upstream → producer through the shared subscribe-init ordering
    // barrier (`../subscription-ack-barrier.ts`). The deps' implementation
    // calls `onEvent` for every event matching the request; each routes to
    // `barrier.emit(event)`, which either buffers the value (before the init
    // response has been written) or forwards it to `sub.next(event)` — which
    // validates against `SessionEventSchema` per the I-007-7 streaming analog
    // and emits a `$/subscription/notify` frame on this transport.
    //
    // The barrier is what upholds I-007-10 (subscribe-init response precedes
    // the first notification frame): `subscribeToSession` may replay
    // SYNCHRONOUSLY per the Plan-001 Phase 5 projector contract, so `onEvent`
    // can fire during the body below, before the gateway's dispatch `.then`
    // microtask writes the response. The barrier's module header carries the
    // full rationale — why buffering rather than a convention, why
    // `setImmediate` and not a microtask, and the failure posture on both
    // sides of the gate. It was extracted from this handler when
    // `timeline.subscribe` became its second consumer; the diagnostics it logs
    // carry this method's name and are byte-identical to the ones this file
    // emitted inline.
    //
    // Atomicity guard — `subscribeToSession` throws synchronously per its
    // JSDoc contract (session not found, invalid afterCursor, permission
    // denied); without `sub.cancel()` on throw, the streaming-primitive
    // entry would orphan in both maps until `cleanupTransport`. An unreleased
    // barrier schedules nothing, so the throw path leaves no timer behind.
    //
    // Cancel-side cleanup propagation — the unsubscribe handle returned
    // from `subscribeToSession` is registered via `sub.onCancel`. When
    // the wire client cancels (`$/subscription/cancel`), the producer's
    // local `cancel()` fires, OR transport-disconnect cleanup runs
    // (`cleanupTransport`), the streaming primitive fires the registered
    // unsubscribe so the Plan-001 Phase 5 event-source detaches its
    // upstream watcher. Without this wire-up the upstream watcher
    // outlives the canceled subscription, leaking one watcher per
    // subscribe/cancel cycle. (The watcher's per-event lambda would
    // continue to fire `sub.next(event)` — a documented silent no-op —
    // but consume CPU / DB resources until transport close.)
    const barrier = createSubscriptionAckBarrier(sub, "session.subscribe");
    try {
      const unsubscribe = deps.subscribeToSession(params.sessionId, params.afterCursor, (event) => {
        barrier.emit(event);
      });
      // Register the upstream-detach callback. If a wire-cancel or
      // transport-disconnect lands AFTER this point, the streaming
      // primitive fires `unsubscribe` so the Plan-001 Phase 5 event-
      // source detaches. Registration here (after the synchronous
      // `subscribeToSession` returns) is safe: there's no preemption
      // between adjacent statements, and the AbortSignal-style
      // synchronous-fire on `onCancel` covers any race where cancel
      // arrives before registration completes.
      sub.onCancel(unsubscribe);
    } catch (err) {
      sub.cancel();
      throw err;
    }
    barrier.release();

    return { subscriptionId: sub.subscriptionId };
  };

  registry.register(
    "session.subscribe",
    SessionSubscribeRequestSchema,
    SessionSubscribeResponseSchema,
    handler,
    { mutating: false },
  );
}
