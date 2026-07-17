// `presence.subscribe` JSON-RPC handler — the daemon→client `PresenceUpdate`
// push slice of the `presence.*` namespace — Plan-002 Phase 3 (T3.3).
//
// The daemon→client push is realized as the notify side of a
// `presence.subscribe` subscription on the Phase 2 streaming primitive: a
// push is NOT a request/response RPC; it flows as `$/subscription/notify`
// frames keyed by a `subscriptionId` allocated through a prior `subscribe`
// call. `PresenceUpdate` (`Spec-002 §Interfaces And Contracts` "daemon pushes serialized Yjs
// Awareness state to local clients") is the VALUE that travels over the
// subscription, and `PresenceUpdateSchema` is wired as that subscription's
// per-value `valueSchema` below. Cf. `session-subscribe.ts`, the streaming
// precedent whose pushed value is the generic `SessionEvent`.
//
// Why not a `presence.update` request/response method:
//   The method registry's dispatch path is client-initiated request/
//   response ONLY (`streaming-primitive.ts:43-66` — the gateway's outbound
//   surface is INTENTIONALLY MINIMAL; a server-unilateral notification
//   method would widen the gateway contract, which Phase 3 forbids and
//   which exceeds this task's target_paths). Server→client push is the
//   streaming primitive's job, exposed to clients via a `subscribe` call.
//   `Spec-002 §Interfaces And Contracts`'s "daemon pushes" is realized as the notify side of a
//   `presence.subscribe` subscription, not a registered push-method.
//
// Spec coverage:
//   * `Spec-002 §Interfaces And Contracts` — "`PresenceUpdate`
//     (JSON-RPC, local IPC) — daemon pushes serialized Yjs Awareness state
//     to local clients." Realized here as the `presence.subscribe` notify
//     stream carrying `PresenceUpdate` values (`{sessionId,
//     awarenessState: Uint8Array}`).
//   * `Spec-002 §State And Data Implications` (Pr4) — durable
//     presence state-change events (`presence.online`/`idle`/
//     `reconnecting`/`offline`) emitted to the session event log. This is
//     a DEPS-CONTRACT obligation documented on
//     `PresenceSubscribeDeps.subscribeToPresence` below (the runtime
//     trigger is downstream of T3.3); the Pr4 round-trip test proves the
//     emission artifact lands as real `session_events` rows.
//   * Plan-002 §Phase 3 (CP-002-2) — register the `presence.*` namespace
//     under the Plan-007-partial wire substrate; this file is the push
//     (`subscribe`) slice, `presence-read.ts` is the query (`read`) slice.
//
// Invariants this module participates in (canonical text in
// `docs/plans/007-local-ipc-and-daemon-control.md §Invariants`, I-007-6 through I-007-10):
//   * I-007-1 — load-before-bind: `registerPresenceSubscribe` is called by
//     the bootstrap orchestrator AFTER the registry is loaded and AFTER the
//     streaming primitive has been constructed (the primitive eagerly
//     registers its `$/subscription/cancel` handler at construction time
//     per `streaming-primitive.ts` lines 276-282).
//   * I-007-6 — duplicate-method registration is rejected at register-time.
//   * I-007-7 — schema-validates-before-dispatch. The registry's `safeParse`
//     path runs against `PresenceSubscribeRequestSchema` before the handler
//     body executes; the streaming-side analog (per-value validation before
//     `$/subscription/notify` send) runs INSIDE the streaming primitive on
//     every `sub.next(value)` call against the `PresenceUpdateSchema` passed
//     to `createSubscription`.
//   * I-007-8 — sanitized error mapping. Errors thrown from the handler are
//     caught by the registry's `dispatch()` wrapper and mapped to the
//     canonical JSON-RPC error envelope.
//   * I-007-10 — subscribe-init response precedes the first notification
//     frame. The init `{subscriptionId}` response MUST land on the wire
//     BEFORE any `$/subscription/notify` for that subscription; the
//     synchronous-replay buffering + `setImmediate` flush below (see the
//     `registerPresenceSubscribe` step 3 JSDoc) is the daemon-side half of
//     this invariant (the SDK-side synchronous dispatcher-entry registration
//     is the paired half).
//   * The `Plan-007 §I-007-11 — LocalSubscriptionProducer<T>.onCancel fires across all externally-imposed cancel paths`
//     streaming-leak invariant
//     (its why-load-bearing clause names Plan-002 `presence.*` explicitly) —
//     the upstream-detach callback
//     returned by `subscribeToPresence` is registered via `sub.onCancel`
//     so wire-cancel / transport-disconnect / trusted-internal teardown all
//     propagate cleanup upstream. Without it, every subscribe/cancel cycle
//     leaks one upstream watcher.
//
// I-002-3 — presence is in-memory only:
//   The pushed `PresenceUpdate.awarenessState` is the serialized in-memory
//   Yjs Awareness CRDT (NEVER persisted). Only durable presence-state-CHANGE
//   EVENTS (`presence.online` etc.) land in `session_events` — and those are
//   emitted by the upstream substrate per the deps JSDoc below, NOT by this
//   handler. The handler routes ephemeral CRDT bytes to the wire and never
//   touches durable storage.
//
// What this file does NOT do (deferred to siblings):
//   * Yjs Awareness ingestion / fan-out — owned by Plan-002 Phase 3's
//     `presence-register-service.ts` (CP-002-1) + Postgres LISTEN/NOTIFY
//     (T3.2). This file consumes the resulting stream through the
//     `PresenceSubscribeDeps.subscribeToPresence` callback.
//   * The runtime trigger that fires `presence.online`/`idle`/`reconnecting`/
//     `offline` emissions — owned by the daemon's heartbeat / WS-liveness
//     watcher (Plan-001 Phase 5 bootstrap). This file only DOCUMENTS the
//     emission contract on the deps interface (Pr4).
//
// Method-name format ratified: dotted-camelCase per
// `docs/architecture/contracts/api-payload-contracts.md §JSON-RPC Method-Name Registry (Tier 1 Ratified)`.
// The canonical regex
// `/^[a-z][a-z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/` accepts `"presence.subscribe"`.
// The method-name TABLE there enumerates only Plan-007 Phase 3's
// `session.*` surface; Plan-002 registers the `presence.*` namespace against
// the same ratified FORMAT (`Plan-002 §API And Transport Changes` / CP-002-2). The `subscribe`
// method string is derived from the streaming-push mechanics + the Phase 6
// renderer presence-consumption surface (`Plan-002 §Phase 6 — Renderer (Tier 2)`
// T6.2 — presence indicators over the generic `window.sidekicks` preload
// bridge), which maps 1:1 to the JSON-RPC method name per the `session.*` precedent.

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
 *   * `streamingPrimitive` — the Phase 2 primitive instance the bootstrap
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
 * The bootstrap orchestrator (Plan-001 Phase 5) supplies the concrete
 * implementation, sourcing updates from the in-memory Yjs Awareness CRDT
 * owned by Plan-002 Phase 3's `presence-register-service.ts` (CP-002-1).
 */
export interface PresenceSubscribeDeps {
  /**
   * The Phase 2 streaming primitive instance the orchestrator constructed.
   * Shared across every streaming handler so the per-transport reverse-
   * index (used by `cleanupTransport`) is unified.
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
   * **Re-entrant safety precondition** (`Plan-007 §I-007-11 — LocalSubscriptionProducer<T>.onCancel fires across all externally-imposed cancel paths`): the
   * returned `unsubscribe` callback MAY be invoked synchronously from
   * inside the `onUpdate` call stack (a live-tail `sub.next()` failure
   * cancels the subscription, firing registered `onCancel` handlers —
   * including this `unsubscribe` — while the upstream's emit frame is still
   * on the stack). Implementations MUST tolerate being unsubscribed
   * mid-emit without corrupting listener iteration or double-delivering the
   * in-flight update.
   *
   * Domain-side errors during subscription setup MUST surface as thrown
   * `Error` instances — the registry's `dispatch()` wrapper catches them
   * and applies `mapJsonRpcError` per I-007-8.
   *
   * ---------------------------------------------------------------------
   * DURABLE PRESENCE-STATE-CHANGE EVENT EMISSION CONTRACT (Pr4 — Spec-002
   * §State And Data Implications; canonical taxonomy in Spec-006
   * §Presence).
   * ---------------------------------------------------------------------
   *
   * THIS IS A LOAD-BEARING OBLIGATION ON THE DEPS IMPLEMENTOR — NOT on this
   * handler. The handler routes ephemeral CRDT bytes; the durable audit
   * trail is emitted by the upstream substrate (the daemon's heartbeat /
   * WebSocket-liveness watcher, Plan-001 Phase 5 bootstrap) as it observes
   * presence TRANSITIONS for the session this subscription targets.
   *
   * On EVERY presence state transition, the substrate MUST append one
   * `AppendableEvent` to the session's durable event log via
   * `SessionService.append` with EXACTLY this shape:
   *
   *   * `category: "membership_change"`
   *       NOT "presence". `Spec-002 §State And Data Implications` prose says "under the `presence`
   *       category" — that is a documentation slip. The canonical
   *       `EventCategory` enum (`packages/contracts/src/event.ts:74-90`)
   *       has NO `presence` member; Spec-006 §Presence is headed
   *       "### Presence (`membership_change`)" and the Spec-006 taxonomy
   *       summary table lists all 4 presence types under `membership_change`.
   *       Emitting `category: "presence"` would break the integrity hash
   *       chain when Plan-006 Tier 4 lands the typed taxonomy.
   *
   *   * `type` — one of the 4 canonical strings (Spec-006 §Presence):
   *       `"presence.online"`       — connected / actively present (this
   *                                   covers BOTH the initial connect AND
   *                                   recovery from reconnecting/offline
   *                                   back to online — `previousState`
   *                                   discriminates the two cases);
   *       `"presence.idle"`         — device became idle;
   *       `"presence.reconnecting"` — lost connection, attempting reconnect;
   *       `"presence.offline"`      — device disconnected.
   *     ALL FOUR states MUST be expressible. `online`/`idle` are
   *     heartbeat/activity-driven; `reconnecting`/`offline` are WS-liveness-
   *     driven (`Spec-002 §Heartbeat Transport` — a dropped WebSocket triggers the reconnect
   *     grace window). This is a FULL lifecycle, not a degradation-only
   *     (online→reconnecting→offline) chain.
   *
   *   * `payload` — exactly (Spec-006 §Presence payload shape):
   *       `{ sessionId, participantId, deviceId, previousState?, newState }`
   *     where `newState` is REQUIRED and `previousState` is OPTIONAL (absent
   *     on the very first transition for a device), both drawn from
   *     `PresenceState` (`"online" | "idle" | "reconnecting" | "offline"`,
   *     exported from `@ai-sidekicks/contracts`).
   *
   * The presence ROWS themselves (the Yjs Awareness CRDT) are NEVER
   * persisted (I-002-3) — only these state-change EVENTS are. The events
   * are forward-compatible: the projector forward-compat-skips unknown
   * event types (`session-projector.ts:122-128`), so these rows land in
   * `session_events` and replay safely WITHOUT a contracts change today.
   * Plan-006 Tier 4 adds the integrity-typed `presence.*` variants to
   * `contracts/src/event.ts` (deferred per CP-002-6, same as the invite/
   * membership lifecycle types); this emission MUST use the exact
   * category/type/payload above so it remains valid when that lands.
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
 *      `$/subscription/notify` frame is sent (I-007-7 streaming analog).
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
 *      propagate cleanup upstream (the Plan-007 §I-007-11 leak invariant).
 *   5. Return `{ subscriptionId }` — the wire client routes inbound
 *      `$/subscription/notify` frames keyed by it.
 *
 * Idempotency / re-registration: see `registerSessionCreate` JSDoc.
 * I-007-6 rejects duplicate registration at register-time.
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
    // is the per-value validation schema — the streaming I-007-7 analog.
    const sub = deps.streamingPrimitive.createSubscription<PresenceUpdate>(
      transportId,
      PresenceUpdateSchema,
    );

    // Wire upstream → producer with the synchronous-replay buffering pattern
    // from `session-subscribe.ts`. I-007-10 (subscribe-init response precedes
    // the first notification frame): the init `{subscriptionId}` response MUST
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
      // Register the upstream-detach callback (the Plan-007 §I-007-11 leak
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
