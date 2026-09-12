// `presence.subscribe` JSON-RPC handler — the daemon-to-client `PresenceUpdate`
// push slice of the `presence.*` namespace.
//
// Presence in this runtime is PER-DEVICE liveness of the one user's linked
// devices, never a list of people. The daemon-to-client push is realized as
// the notify side of a `presence.subscribe` subscription on the streaming
// primitive: a push is NOT a request/response RPC; it flows as
// `$/subscription/notify` frames keyed by a `subscriptionId` allocated through
// a prior `subscribe` call. `PresenceUpdate` — the serialized Yjs Awareness
// state — is the VALUE that travels over the subscription, and
// `PresenceUpdateSchema` is wired as that subscription's per-value
// `valueSchema` below. Cf. `session-subscribe.ts`, the streaming precedent
// whose pushed value is the generic `SessionEvent`.
//
// Why not a `presence.update` request/response method:
//   The method registry's dispatch path is client-initiated request/response
//   ONLY — the gateway's outbound surface is INTENTIONALLY MINIMAL, and a
//   server-unilateral notification method would widen the gateway contract.
//   Server-to-client push is the streaming primitive's job, exposed to clients
//   via a `subscribe` call.
//
// Invariants this module participates in:
//   * Load-before-bind: `registerPresenceSubscribe` is called by the bootstrap
//     orchestrator AFTER the registry is loaded and AFTER the streaming
//     primitive has been constructed (the primitive eagerly registers its
//     `$/subscription/cancel` handler at construction time).
//   * Duplicate-method registration is rejected at register-time.
//   * Schema-validates-before-dispatch. The registry's `safeParse` path runs
//     against `PresenceSubscribeRequestSchema` before the handler body
//     executes; the streaming-side analog (per-value validation before a
//     `$/subscription/notify` send) runs INSIDE the streaming primitive on
//     every `sub.next(value)` call against the `PresenceUpdateSchema` passed to
//     `createSubscription`.
//   * Sanitized error mapping. Errors thrown from the handler are caught by
//     the registry's `dispatch()` wrapper and mapped to the canonical JSON-RPC
//     error envelope.
//   * Subscribe-init response precedes the first notification frame. The init
//     `{subscriptionId}` response MUST land on the wire BEFORE any
//     `$/subscription/notify` for that subscription; the synchronous-replay
//     buffering plus `setImmediate` flush below (see the
//     `registerPresenceSubscribe` step 3 JSDoc) is the daemon-side half of
//     this invariant (the SDK-side synchronous dispatcher-entry registration
//     is the paired half).
//   * `LocalSubscriptionProducer<T>.onCancel` fires across every
//     externally-imposed cancel path: the upstream-detach callback returned by
//     `subscribeToPresence` is registered via `sub.onCancel` so wire-cancel,
//     transport-disconnect, and trusted-internal teardown all propagate
//     cleanup upstream. Without it, every subscribe/cancel cycle leaks one
//     upstream watcher.
//
// Presence is in-memory only:
//   The pushed `PresenceUpdate.awarenessState` is the serialized in-memory Yjs
//   Awareness CRDT (NEVER persisted). Only durable presence-state-CHANGE
//   EVENTS (`presence.online` etc.) land in `session_events` — and those are
//   emitted by the upstream substrate per the deps JSDoc below, NOT by this
//   handler. The handler routes ephemeral CRDT bytes to the wire and never
//   touches durable storage.
//
// What this file does NOT do (deferred to siblings):
//   * Yjs Awareness ingestion / fan-out — owned by
//     `presence-register-service.ts`. This file consumes the resulting stream
//     through the `PresenceSubscribeDeps.subscribeToPresence` callback.
//   * The runtime trigger that fires `presence.online` / `idle` /
//     `reconnecting` / `offline` emissions — owned by the daemon's heartbeat /
//     connection-liveness watcher. This file only DOCUMENTS the emission
//     contract on the deps interface.
//
// Method-name format: dotted-camelCase. The canonical regex
// `/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/` accepts
// `"presence.subscribe"`. The `subscribe` method string is derived from the
// streaming-push mechanics plus the renderer's presence-consumption surface
// over the generic `window.sidekicks` preload bridge, which maps 1:1 to the
// JSON-RPC method name per the `session.*` precedent.

import type {
  Handler,
  MethodRegistry,
  PresenceSubscribeRequest,
  PresenceSubscribeResponse,
  PresenceUpdate,
  SessionId,
} from "@ai-sidekicks/contracts";
import {
  PresenceSubscribeRequestSchema,
  PresenceSubscribeResponseSchema,
  PresenceUpdateSchema,
} from "@ai-sidekicks/contracts";

import type { StreamingPrimitive } from "../streaming-primitive.js";

/**
 * Dependencies required by `presence.subscribe`'s handler closure.
 *
 * Two slots (mirrors `SessionSubscribeDeps`):
 *   * `streamingPrimitive` — the primitive instance the bootstrap
 *     orchestrator constructed and shares across every streaming handler.
 *     The handler calls `createSubscription<PresenceUpdate>(transportId,
 *     PresenceUpdateSchema)` synchronously at dispatch time and receives a
 *     `LocalSubscriptionProducer<PresenceUpdate>` producer handle.
 *   * `subscribeToPresence` — the upstream presence-source callback. The
 *     handler invokes it with the request's `sessionId` and an `onUpdate`
 *     lambda that routes each emitted `PresenceUpdate` to `sub.next(...)`
 *     on the streaming primitive's producer. The callback returns an
 *     `unsubscribe` handle the handler registers via `sub.onCancel` so that
 *     wire-cancel, transport-disconnect, AND trusted-internal teardown all
 *     propagate cleanup back to the upstream presence source.
 *
 * The bootstrap orchestrator supplies the concrete implementation, sourcing
 * updates from the in-memory Yjs Awareness CRDT owned by
 * `presence-register-service.ts`.
 */
export interface PresenceSubscribeDeps {
  /**
   * The streaming primitive instance the orchestrator constructed. Shared
   * across every streaming handler so the per-transport reverse-index (used by
   * `cleanupTransport`) is unified.
   */
  readonly streamingPrimitive: StreamingPrimitive;

  /**
   * Subscribe to a session's live presence stream. The implementation MUST
   * call `onUpdate(update)` for every `PresenceUpdate` (the serialized Yjs
   * Awareness state) produced for the session; the handler routes those
   * calls to the streaming primitive's producer (`sub.next`).
   *
   * Returns an `unsubscribe` callback the handler registers via
   * `sub.onCancel` to propagate teardown upstream when the wire client
   * cancels, the transport disconnects, or `cancelSubscription` runs.
   *
   * **Re-entrant safety precondition**: the returned `unsubscribe` callback
   * MAY be invoked synchronously from
   * inside the `onUpdate` call stack (a live-tail `sub.next()` failure
   * cancels the subscription, firing registered `onCancel` handlers —
   * including this `unsubscribe` — while the upstream's emit frame is still
   * on the stack). Implementations MUST tolerate being unsubscribed
   * mid-emit without corrupting listener iteration or double-delivering the
   * in-flight update.
   *
   * Domain-side errors during subscription setup MUST surface as thrown
   * `Error` instances — the registry's `dispatch()` wrapper catches them
   * and applies `mapJsonRpcError`.
   *
   * ---------------------------------------------------------------------
   * DURABLE PRESENCE-STATE-CHANGE EVENT EMISSION CONTRACT
   * ---------------------------------------------------------------------
   *
   * THIS IS A LOAD-BEARING OBLIGATION ON THE DEPS IMPLEMENTOR — NOT on this
   * handler. The handler routes ephemeral CRDT bytes; the durable audit trail
   * is emitted by the upstream substrate (the daemon's heartbeat /
   * connection-liveness watcher) as it observes presence TRANSITIONS for the
   * devices attached to the session this subscription targets.
   *
   * On EVERY presence state transition, the substrate MUST append one
   * `AppendableEvent` to the session's durable event log via the durable
   * append path — `SessionService.append` is guarded test-only, so the
   * event-log service is the production writer — with EXACTLY this shape:
   *
   *   * `type` — one of the 4 canonical strings:
   *       `"presence.online"`       — connected / actively present (this
   *                                   covers BOTH the initial connect AND
   *                                   recovery from reconnecting/offline
   *                                   back to online — `previousState`
   *                                   discriminates the two cases);
   *       `"presence.idle"`         — the device became idle;
   *       `"presence.reconnecting"` — lost connection, attempting reconnect;
   *       `"presence.offline"`      — the device disconnected.
   *     ALL FOUR states MUST be expressible. `online` / `idle` are
   *     heartbeat/activity-driven; `reconnecting` / `offline` are
   *     connection-liveness-driven (a dropped socket opens the reconnect grace
   *     window). This is a FULL lifecycle, not a degradation-only
   *     (online → reconnecting → offline) chain.
   *
   *   * `category` — READ IT, do not restate it. The contracts package owns
   *     the type-to-category assignment and publishes it as
   *     `SESSION_EVENT_CATEGORY_BY_TYPE`; the substrate MUST look the emitted
   *     `type` up there rather than hardcoding a literal, because a hardcoded
   *     category that drifts from the canonical assignment breaks the
   *     integrity hash chain rather than failing a parse.
   *
   *   * `payload` — the device the transition is about, plus the transition:
   *       `{ sessionId, deviceId, previousState?, newState }`
   *     where `newState` is REQUIRED and `previousState` is OPTIONAL (absent
   *     on the very first transition for a device), both drawn from
   *     `PresenceState` (`"online" | "idle" | "reconnecting" | "offline"`,
   *     exported from `@ai-sidekicks/contracts`). There is no per-person axis:
   *     every device on a session belongs to the one user, so `deviceId` is
   *     the whole of the subject.
   *
   * The presence ROWS themselves (the Yjs Awareness CRDT) are NEVER persisted
   * — only these state-change EVENTS are. The events are forward-compatible:
   * the projector forward-compat-skips unknown event types, so these rows land
   * in `session_events` and replay safely without a contracts change.
   */
  readonly subscribeToPresence: (
    sessionId: SessionId,
    onUpdate: (update: PresenceUpdate) => void,
  ) => () => void;
}

/**
 * Bind the `presence.subscribe` handler onto the supplied method registry.
 *
 * Mutating flag: `mutating: false`. Opening a presence subscription does
 * not mutate domain state — it allocates per-subscription IPC state but
 * creates/appends no session-level row or event. The pre-handshake
 * mutating-op gate's predicate is `isMutating(method) === true`; flagging
 * `subscribe` as `false` means a connection in `pre` or `done-incompatible`
 * state can still subscribe, matching the read-only-continues posture
 * documented for `session.subscribe` (`session-subscribe.ts:41-50`).
 *
 * Handler shape (mirrors `session-subscribe.ts` — the streaming precedent):
 *   1. Refuse `ctx.transportId === undefined` — per-connection streaming
 *      state requires a transport identity. A missing transport id means
 *      direct test code or a bootstrap bug, not a client protocol
 *      violation, so we throw a plain Error which `mapJsonRpcError`
 *      collapses to `-32603 InternalError`.
 *   2. Allocate the producer handle via
 *      `streamingPrimitive.createSubscription<PresenceUpdate>(transportId,
 *      PresenceUpdateSchema)`. The primitive generates a fresh
 *      `subscriptionId` and registers the per-transport reverse-index entry.
 *      `PresenceUpdateSchema` is the per-value `valueSchema` — every pushed
 *      `PresenceUpdate` is validated against it before the
 *      `$/subscription/notify` frame is sent (the streaming analog of
 *      schema-validates-before-dispatch).
 *   3. Wire the upstream presence-source onto the producer. Per the
 *      wire-ordering invariant, events fired SYNCHRONOUSLY during the
 *      subscription-setup window are BUFFERED and flushed on a
 *      `setImmediate` boundary AFTER the init `{subscriptionId}` response
 *      settles on the wire — otherwise a `$/subscription/notify` could race
 *      ahead of the response and hit the SDK's unknown-id silent-drop
 *      branch. (Verbatim from `session-subscribe.ts`; see its lines 209-242
 *      for the full microtask-vs-check-phase rationale.)
 *   4. Register the upstream-detach `unsubscribe` via `sub.onCancel` so
 *      wire-cancel / transport-disconnect / trusted-internal teardown all
 *      propagate cleanup upstream (the streaming-leak invariant).
 *   5. Return `{ subscriptionId }` — the wire client routes inbound
 *      `$/subscription/notify` frames keyed by it.
 *
 * Idempotency / re-registration: see `registerSessionCreate` JSDoc.
 * Duplicate registration is rejected at register-time.
 */
export function registerPresenceSubscribe(
  registry: MethodRegistry,
  deps: PresenceSubscribeDeps,
): void {
  const handler: Handler<PresenceSubscribeRequest, PresenceSubscribeResponse> = async (
    params,
    ctx,
  ) => {
    if (ctx.transportId === undefined) {
      throw new Error(
        "presence.subscribe: handler requires ctx.transportId (per-connection streaming state requires a transport identity)",
      );
    }
    const transportId = ctx.transportId;

    // Allocate the producer handle. Synchronous: no I/O. The primitive
    // generates a fresh `subscriptionId` via `crypto.randomUUID()` and
    // registers the per-transport reverse-index entry. `PresenceUpdateSchema`
    // is the per-value validation schema — the streaming analog of
    // schema-validates-before-dispatch.
    const sub = deps.streamingPrimitive.createSubscription<PresenceUpdate>(
      transportId,
      PresenceUpdateSchema,
    );

    // Wire upstream → producer with the synchronous-replay buffering pattern
    // from `session-subscribe.ts`. The subscribe-init response precedes the
    // first notification frame: the init `{subscriptionId}` response MUST
    // land on the wire BEFORE any `$/subscription/notify` for that
    // subscription; updates fired synchronously during setup are buffered and
    // flushed on the `setImmediate` boundary below (the check phase, AFTER
    // the dispatch promise's `.then` microtask resolves the response). See
    // `session-subscribe.ts` lines 209-242 for the full rationale on why
    // `setImmediate` (not `queueMicrotask` / `process.nextTick` /
    // `setTimeout`) is the correct primitive.
    const replayBuffer: PresenceUpdate[] = [];
    let replayDrained = false;
    try {
      const unsubscribe = deps.subscribeToPresence(params.sessionId, (update) => {
        if (replayDrained) {
          // Live-tail path — fires on whatever turn the upstream presence
          // source triggers. The outer try/catch only catches synchronous
          // throws from `subscribeToPresence(...)` setup; this lambda runs
          // on a later turn outside that reach. Without an inner guard, a
          // `StreamingValidationError` thrown by `sub.next(update)`
          // (programmer-error path — the producer emitted a value not
          // matching `PresenceUpdateSchema`) would escape as an uncaught
          // exception and could terminate the daemon process.
          //
          // Posture on catch: cancel cleanly via `sub.cancel()` (drains both
          // primitive maps), then surface via `console.error` with a
          // tripwire prefix. Swallowing keeps the daemon alive at the cost of
          // dropping the rest of this subscription's live-tail — the right
          // trade: a corrupted producer is a daemon-internal bug, but the
          // wire-side client is innocent and sibling subscriptions on this
          // transport must keep working. (Mirrors `session-subscribe.ts`.)
          // TRIPWIRE: replace `console.error` once a structured logger
          // surfaces in the runtime-daemon.
          try {
            sub.next(update);
          } catch (err) {
            sub.cancel();
            console.error(
              `[presence.subscribe] live-tail update validation/emission failed for subscriptionId=${sub.subscriptionId}; subscription canceled`,
              err,
            );
          }
        } else {
          replayBuffer.push(update);
        }
      });
      // Register the upstream-detach callback (the streaming-leak
      // invariant). If a wire-cancel or transport-disconnect lands after this
      // point, the streaming primitive fires `unsubscribe` so the upstream
      // presence source detaches. Registration here (after the synchronous
      // `subscribeToPresence` returns) is safe: no preemption between adjacent
      // statements, and the AbortSignal-style synchronous-fire on `onCancel`
      // covers any race where cancel arrives before registration completes.
      sub.onCancel(unsubscribe);
    } catch (err) {
      // Atomicity guard — `subscribeToPresence` may throw synchronously
      // during setup; without `sub.cancel()` the primitive entry would
      // orphan in both maps until `cleanupTransport`.
      sub.cancel();
      throw err;
    }
    setImmediate(() => {
      replayDrained = true;
      // Replay flush — each `sub.next(update)` validates against
      // `PresenceUpdateSchema` and throws `StreamingValidationError` on
      // failure. Because this runs on a `setImmediate` boundary (AFTER the
      // dispatch promise's `.then` microtask resolved the response), an
      // uncaught throw here ESCAPES the registry's `dispatch()` error-mapping
      // wrapper and could terminate the daemon. Posture on catch: cancel the
      // subscription cleanly, log a tripwire diagnostic, stop draining (a
      // canceled subscription's subsequent `next(...)` calls are silent
      // no-ops anyway; stopping reduces log spam). Mirrors
      // `session-subscribe.ts`'s replay-flush posture.
      // TRIPWIRE: replace `console.error` once a structured logger surfaces.
      try {
        for (const update of replayBuffer) {
          sub.next(update);
        }
      } catch (err) {
        sub.cancel();
        console.error(
          `[presence.subscribe] replay update validation/emission failed for subscriptionId=${sub.subscriptionId}; subscription canceled`,
          err,
        );
      }
      replayBuffer.length = 0;
    });

    return { subscriptionId: sub.subscriptionId };
  };

  registry.register(
    "presence.subscribe",
    PresenceSubscribeRequestSchema,
    PresenceSubscribeResponseSchema,
    handler,
    { mutating: false },
  );
}
