// `session.subscribe` JSON-RPC handler — Plan-007 Phase 3 (T-007p-3-1).
//
// Spec coverage:
//   * Spec-007 §Required Behavior + §Interfaces And Contracts (lines 71-78) —
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
// docs/plans/007-local-ipc-and-daemon-control.md §Invariants lines 95-117):
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
// state — it allocates per-subscription IPC state (a `LocalSubscription`
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
//   * `LocalSubscription<T>` cancel-side cleanup propagation: the
//     server-side `LocalSubscription<T>` interface does NOT expose an
//     `onCancel` hook today (per `jsonrpc-streaming.ts` lines 380-403). When
//     the wire client's `$/subscription/cancel` arrives or the transport
//     disconnects, the streaming primitive removes its entry but DOES NOT
//     notify upstream producers — which means the Plan-001 Phase 5 deps'
//     event-source subscription continues to call `sub.next(event)` on a
//     drained subscription. That call is a documented silent no-op (per
//     `LocalSubscription.next` JSDoc lines 333-337); however, the upstream
//     subscription continues to consume CPU / DB resources until the
//     event-source itself learns to detach. A future Phase 3 amendment to
//     `LocalSubscription<T>` (per the advisor-flagged naming/lifecycle note
//     in `jsonrpc-streaming.ts` lines 312-322) will introduce an `onCancel`
//     callback the deps can use to detach. Tracking: BLOCKED-ON-C7 (when
//     error-contracts.md §Plan-007 lands the canonical wire shape, the
//     companion lifecycle amendment can land alongside).
//   * Test coverage — owned by T-007p-3-4 (sibling task).
//
// BLOCKED-ON-C6 — `register` call site carries a marker for the canonical
// method-name format pending api-payload-contracts.md §Plan-007.

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

import { NegotiationError } from "../protocol-negotiation.js";
import type { StreamingPrimitive } from "../streaming-primitive.js";

/**
 * Dependencies required by `session.subscribe`'s handler closure.
 *
 * Two slots:
 *   * `streamingPrimitive` — the Phase 2 primitive instance the bootstrap
 *     orchestrator constructed and shares across every streaming handler.
 *     The handler calls `createSubscription<SessionEvent>(transportId,
 *     SessionEventSchema)` synchronously at dispatch time and receives a
 *     `LocalSubscription<SessionEvent>` producer handle.
 *   * `subscribeToSession` — the upstream event-source callback. The
 *     handler invokes it with the request's `sessionId` + optional
 *     `afterCursor` and an `onEvent` lambda that calls
 *     `sub.next(event)` on the streaming primitive's producer. The
 *     callback returns an `unsubscribe` handle for upstream-side
 *     teardown — though the SERVER-SIDE `LocalSubscription<T>`
 *     interface does NOT expose an `onCancel` hook today (see header
 *     comment §"What this file does NOT do"), so the unsubscribe
 *     handle is currently un-invoked from this file. It is captured
 *     for future-amendment forwards-compatibility — when
 *     `LocalSubscription<T>` gains `onCancel`, this file's binding
 *     wires the unsubscribe handle to the streaming primitive's
 *     teardown path without contract churn.
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
   * Returns an `unsubscribe` callback the caller invokes to stop
   * upstream event delivery. See header comment §"What this file does
   * NOT do" — the SERVER-SIDE `LocalSubscription<T>` interface does
   * not yet expose an `onCancel` hook, so the unsubscribe handle is
   * currently un-invoked at this layer. It is captured for forwards-
   * compatibility.
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
 *      a transport identity. Mirrors `protocol-negotiation.ts` lines
 *      570-575: a missing transport id means the call originated from
 *      direct test code; refuse explicitly so the misconfiguration
 *      surfaces clearly. The `NegotiationError` reuse keeps the daemon's
 *      error-class taxonomy uniform — Plan-007 Phase 2 already established
 *      `NegotiationError` as the "transport-required" error class for
 *      protocol-state operations, and per-connection streaming setup is
 *      structurally the same kind of operation. (Until C-7 lands the
 *      canonical mapping, this collapses to `-32603 InternalError` at
 *      `mapJsonRpcError` per the existing `NegotiationError` mapping.)
 *   2. Call `streamingPrimitive.createSubscription<SessionEvent>(
 *      transportId, SessionEventSchema)` to allocate the producer handle.
 *      The primitive generates a fresh `subscriptionId`, registers the
 *      entry on the per-transport reverse-index, and returns a
 *      `LocalSubscription<SessionEvent>`.
 *   3. Wire the upstream event-source callback to the producer handle:
 *      every `onEvent(event)` invocation routes to `sub.next(event)`,
 *      which validates against `SessionEventSchema` (I-007-7 streaming
 *      analog) and emits a `$/subscription/notify` frame on the
 *      transport.
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
      throw new NegotiationError(
        "pre_handshake_mutating_refused",
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

    // Wire upstream → producer. The deps' implementation calls `onEvent`
    // for every event matching the request; we route each to
    // `sub.next(event)` which:
    //   * validates against `SessionEventSchema` per I-007-7 streaming
    //     analog (validation failure throws StreamingValidationError);
    //   * emits a `$/subscription/notify` frame on this transport.
    //
    // The unsubscribe handle is captured for forwards-compatibility per
    // the header comment — `LocalSubscription<T>` does not yet expose an
    // `onCancel` hook, so we do not invoke `unsubscribe` from this layer
    // today. The `void` discard is explicit so a future amendment that
    // wires `unsubscribe` to a teardown hook is a single-site edit.
    //
    // Atomicity guard — `subscribeToSession` throws synchronously per its
    // JSDoc contract (session not found, invalid afterCursor, permission
    // denied); without `sub.cancel()` on throw, the streaming-primitive
    // entry would orphan in both maps until `cleanupTransport`.
    try {
      void deps.subscribeToSession(params.sessionId, params.afterCursor, (event) => {
        sub.next(event);
      });
    } catch (err) {
      sub.cancel();
      throw err;
    }

    return { subscriptionId: sub.subscriptionId };
  };

  // BLOCKED-ON-C6: method-name canonical format pending api-payload-contracts.md §Plan-007
  registry.register(
    "session.subscribe",
    SessionSubscribeRequestSchema,
    SessionSubscribeResponseSchema,
    handler,
    { mutating: false },
  );
}
