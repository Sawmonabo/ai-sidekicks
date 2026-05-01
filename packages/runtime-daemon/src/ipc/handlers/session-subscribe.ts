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
//   * Test coverage — owned by T-007p-3-4 (sibling task).
//
// Method-name format ratified: dotted-lowercase per
// docs/architecture/contracts/api-payload-contracts.md §JSON-RPC Method-Name
// Registry (Tier 1 Ratified, lines 291-331). The `register` call site below
// passes `"session.subscribe"`, which matches the canonical regex.

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
    // for every event matching the request; each routes to `sub.next(event)`
    // which:
    //   * validates against `SessionEventSchema` per I-007-7 streaming
    //     analog (validation failure throws StreamingValidationError);
    //   * emits a `$/subscription/notify` frame on this transport.
    //
    // Wire-ordering invariant — `{ subscriptionId }` MUST land on the wire
    // BEFORE any `$/subscription/notify` for that subscription. The SDK
    // (`packages/client-sdk/src/transport/jsonRpcClient.ts`) registers the
    // subscription in its inbound dispatcher map only AFTER the init
    // response settles; any pre-response notify hits the unknown-id
    // silent-drop branch. Plan-001 Phase 5's projector contract permits
    // `subscribeToSession` to perform cursor replay SYNCHRONOUSLY (replay-
    // then-live-tail), so `onEvent` MAY fire during the synchronous body
    // below. Direct routing to `sub.next(event)` would emit those notify
    // frames on the wire BEFORE the gateway's dispatch `.then` microtask
    // resolves the response — the bug.
    //
    // Fix — buffer events fired synchronously during the replay window;
    // flush after the response settles. Why `setImmediate` (not chained
    // `queueMicrotask`): the gateway's `#sendEnvelope` writes the response
    // synchronously inside the dispatch promise's `.then` microtask. Any
    // microtask we queue from the handler's synchronous body drains in the
    // SAME microtask checkpoint AHEAD of the dispatch resolution `.then`
    // (FIFO within a checkpoint), so additional `queueMicrotask` layers
    // cannot cross the response. `setImmediate` schedules into the check
    // phase, which runs AFTER all microtasks drain — the smallest primitive
    // that crosses into the next event-loop phase. `process.nextTick` is
    // wrong (higher priority than promise microtasks); `setTimeout(fn, 0)`
    // works but the timer-phase has minimum-1ms semantics and is a less-
    // precise primitive for "after microtasks drain". One `setImmediate`
    // boundary is sufficient.
    //
    // This fix's correctness depends on the dispatch path resolving the
    // response within microtasks (no `setImmediate` / `process.nextTick`
    // deferral between handler return and `#sendEnvelope`'s synchronous
    // `socket.write`). A future refactor that introduces such deferral
    // would silently re-introduce the bug — the regression test in
    // session-handlers.test.ts captures wire frame ordering under the
    // current dispatch path.
    //
    // Atomicity guard — `subscribeToSession` throws synchronously per its
    // JSDoc contract (session not found, invalid afterCursor, permission
    // denied); without `sub.cancel()` on throw, the streaming-primitive
    // entry would orphan in both maps until `cleanupTransport`.
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
    const replayBuffer: SessionEvent[] = [];
    let replayDrained = false;
    try {
      const unsubscribe = deps.subscribeToSession(params.sessionId, params.afterCursor, (event) => {
        if (replayDrained) {
          // Live-tail path — fires from whatever turn the upstream event-
          // source triggers (DB tick, event bus, etc.). The outer try/catch
          // above ONLY catches synchronous throws from
          // `subscribeToSession(...)` setup; this lambda runs on a later
          // turn outside that try/catch's reach. Without an inner guard,
          // a `StreamingValidationError` thrown by `sub.next(event)`
          // (per `streaming-primitive.ts:346` (throw site; class at :139)
          // — programmer-error path when the producer returned a value
          // not matching the registered `SessionEventSchema`) escapes as
          // an uncaught exception and can terminate the daemon process.
          //
          // Posture on catch: cancel the subscription cleanly via
          // `sub.cancel()` (drains both `#subscriptions` and
          // `#subscriptionsByTransport`), then surface the error via
          // `console.error` with a clear tripwire prefix. There is no
          // structured logger in the daemon today (verified via repo
          // grep); when one lands (BLOCKED-ON observability framework),
          // this site flips to it. Swallowing the error keeps the daemon
          // alive at the cost of dropping the rest of the live-tail —
          // which is the right trade: a corrupted producer is a daemon-
          // internal bug, but the wire-side client is innocent and other
          // subscriptions on this transport must continue to function.
          // TRIPWIRE: replace `console.error` once a structured logger
          // surfaces in the runtime-daemon.
          try {
            sub.next(event);
          } catch (err) {
            sub.cancel();
            console.error(
              `[session.subscribe] live-tail event validation/emission failed for subscriptionId=${sub.subscriptionId}; subscription canceled`,
              err,
            );
          }
        } else {
          replayBuffer.push(event);
        }
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
    setImmediate(() => {
      replayDrained = true;
      // Replay flush — `sub.next(event)` validates each event against the
      // per-subscription `SessionEventSchema` and throws
      // `StreamingValidationError` (`streaming-primitive.ts:346` (throw
      // site; class at :139)) on validation failure. Because this body
      // runs on a `setImmediate` boundary (the check phase, AFTER the
      // dispatch promise's `.then` microtask has already resolved the
      // response), an uncaught throw here ESCAPES the registry's
      // `dispatch()` error-mapping wrapper and surfaces as an uncaught
      // exception capable of terminating the daemon process.
      //
      // Posture on catch: cancel the subscription cleanly so both
      // `#subscriptions` and `#subscriptionsByTransport` are drained,
      // log a clear tripwire diagnostic, then return (we do NOT
      // continue draining `replayBuffer` after a failure — once the
      // subscription is canceled, subsequent `sub.next(...)` calls
      // become silent no-ops anyway, but stopping the loop reduces
      // duplicate log spam on a producer that's emitting many bad
      // events). The bad event does NOT propagate to subsequent
      // handlers — `sub.cancel()` removes the entry, and the silent-
      // no-op contract on a drained subscription guarantees nothing
      // routes downstream from this point.
      // TRIPWIRE: replace `console.error` once a structured logger
      // surfaces in the runtime-daemon.
      try {
        for (const event of replayBuffer) {
          sub.next(event);
        }
      } catch (err) {
        sub.cancel();
        console.error(
          `[session.subscribe] replay event validation/emission failed for subscriptionId=${sub.subscriptionId}; subscription canceled`,
          err,
        );
      }
      replayBuffer.length = 0;
    });

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
