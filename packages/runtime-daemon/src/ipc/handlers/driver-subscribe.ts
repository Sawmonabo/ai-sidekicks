// `driver.subscribeEvents` — the dedicated subscription surface, Plan-005
// Phase 4, T4.4.
//
// THIS MODULE IS THE ONE AND ONLY REGISTRATION OF THIS METHOD. T4.1 authored the
// six request/response verbs in `driver-handlers.ts` and carried the
// subscription leg alongside them; T4.4 is the task that gives that leg the
// dedicated module the plan names, and it does so by MOVING the implementation
// rather than adding a second one. `driver-handlers.ts` no longer registers
// `driver.subscribeEvents` and no longer derives the driver event set — a
// grep for `register("driver.subscribeEvents"` finds exactly this file. Two
// competing registrations would not have merely been untidy: I-007-6 makes the
// registry reject a duplicate name at register time, so a daemon binding both
// would have failed at bootstrap rather than at a test.
//
// WHY THE SPLIT IS WORTH A FILE. The six sibling verbs are stateless
// request/response dispatches into the in-daemon `ProviderRegistry`. This one
// allocates PER-CONNECTION state (a streaming-primitive entry keyed by transport
// id), owns a teardown path that has to survive wire-cancel, transport
// disconnect, and internal cancellation alike, and carries an ordering
// obligation (I-007-10) that none of the others do. Those concerns share nothing
// with the dispatch verbs beyond the namespace, which is exactly the seam the
// plan draws — and it mirrors the shape the session namespace already ships,
// where `session-subscribe.ts` sits beside `session-create.ts` / `-read.ts` /
// `-join.ts`.
//
// WHAT THE SDK SEES. Plan-007's CP-007-4 splits the streaming primitive across
// the wire: this side hands the handler a `LocalSubscriptionProducer` (via
// `StreamingPrimitive.createSubscription`), and the SDK's
// `createDaemonProviderClient(...).subscribeEvents(...)` hands its caller a
// `LocalSubscriptionConsumer`. The wire between them is the shared
// `SubscribeAckResponse` — the opaque `subscriptionId` and nothing else — with
// values following as `$/subscription/notify` frames.
//
// Invariants this module participates in (canonical text in
// `docs/plans/007-local-ipc-and-daemon-control.md §Invariants`):
//   * I-007-6 — duplicate registration is rejected at register time, which is
//     what makes the one-registration claim above enforced rather than merely
//     asserted.
//   * I-007-7 — schema-validates-before-dispatch. The registry `safeParse`s the
//     request against `DriverSubscribeEventsParamsSchema` before this handler
//     body runs, and the streaming primitive `safeParse`s every emitted value
//     against `SessionEventSchema` before it reaches the wire.
//   * I-007-9 — dotted-camelCase method name.
//   * I-007-10 — the subscribe-init response precedes the first notify frame.
//
// Mutating flag: `false`. Opening a subscription allocates per-connection IPC
// state but mutates no domain row, so a version-mismatched connection keeps this
// method for the same reason it keeps the three reads.
//
// Refs: Plan-005 §Phase 4 / T4.4 (+ ratified decision #4),
// `Spec-005 §Required Behavior` (drivers emit normalized runtime events),
// invariant I-005-1, CP-007-4 (the shared streaming primitive),
// `docs/architecture/contracts/error-contracts.md §Driver`.

import type {
  DriverSubscribeEventsParams,
  Handler,
  MethodRegistry,
  RunId,
  SessionEvent,
  SessionEventType,
  SubscribeAckResponse,
} from "@ai-sidekicks/contracts";
import {
  ARTIFACT_PUBLICATION_EVENT_TYPES,
  ASSISTANT_OUTPUT_EVENT_TYPES,
  DriverSubscribeEventsParamsSchema,
  INTERACTIVE_REQUEST_EVENT_TYPES,
  RUN_LIFECYCLE_EVENT_TYPES,
  RUNTIME_NODE_LIFECYCLE_EVENT_TYPES,
  SessionEventSchema,
  SubscribeAckResponseSchema,
  TOOL_ACTIVITY_EVENT_TYPES,
  USAGE_TELEMETRY_EVENT_TYPES,
} from "@ai-sidekicks/contracts";

import type { StreamingPrimitive } from "../streaming-primitive.js";
import { translateDriverError } from "./driver-handlers.js";

// --------------------------------------------------------------------------
// Dependency contract
// --------------------------------------------------------------------------

/** Dependencies for `driver.subscribeEvents`. */
export interface DriverSubscribeEventsDeps {
  /**
   * The Phase-2 streaming primitive the orchestrator constructed, shared with
   * every other streaming handler so the per-transport reverse-index that
   * `cleanupTransport` walks stays unified.
   */
  readonly streamingPrimitive: StreamingPrimitive;
  /**
   * The upstream driver event source for one run. Returns an unsubscribe handle,
   * which the handler registers via `sub.onCancel` so wire-cancel,
   * transport-disconnect, and internal teardown all detach it.
   *
   * Domain-side setup failures (unknown run, no live binding) MUST throw
   * SYNCHRONOUSLY — the handler's atomicity guard cancels the allocated
   * subscription on a synchronous throw, and a rejection delivered later would
   * orphan the streaming-primitive entry until transport cleanup.
   */
  readonly subscribeToDriverEvents: (
    runId: RunId,
    onEvent: (event: SessionEvent) => void,
  ) => () => void;
}

// --------------------------------------------------------------------------
// The driver event set
// --------------------------------------------------------------------------

// Plan-005 §Phase 4 decision #4 defines `DriverEvent` as the union of seven
// EXISTING event-category types. The union type itself is Plan-006-owned, so
// this module deliberately does not author the name — it derives the SET from
// the per-category arrays that plan already exports, and keeps it module-local
// and unexported. Moved here wholesale with the handler at T4.4: this filter has
// exactly one consumer and leaving it behind in `driver-handlers.ts` would have
// left that module exporting nothing that used it.
//
// Derivation rather than a literal list, for the reason every derived set in
// this codebase is derived: a category that grows a new event type joins this
// filter automatically, where a hand-written list would silently start dropping
// a driver event from the stream and look correct while doing it.
//
// The filter is what makes this a stream of DRIVER events rather than of
// whatever the injected source happens to emit. Without it a source wired to a
// session-wide event feed would push approvals, memberships, and audit rows onto
// a subscription a client opened for one run's driver activity — and because
// each of those parses cleanly against `SessionEventSchema`, nothing downstream
// would notice.
const DRIVER_EVENT_TYPES: ReadonlySet<SessionEventType> = new Set<SessionEventType>([
  ...RUN_LIFECYCLE_EVENT_TYPES,
  ...ASSISTANT_OUTPUT_EVENT_TYPES,
  ...TOOL_ACTIVITY_EVENT_TYPES,
  ...INTERACTIVE_REQUEST_EVENT_TYPES,
  ...ARTIFACT_PUBLICATION_EVENT_TYPES,
  ...USAGE_TELEMETRY_EVENT_TYPES,
  ...RUNTIME_NODE_LIFECYCLE_EVENT_TYPES,
]);

// --------------------------------------------------------------------------
// Handler binder
// --------------------------------------------------------------------------

/**
 * Bind `driver.subscribeEvents`.
 *
 * The wire response is the shared `SubscribeAckResponse` — the opaque
 * `subscriptionId` and nothing else — with events following as
 * `$/subscription/notify` frames. The ordering construction (buffer during the
 * synchronous replay window, flush on a `setImmediate` boundary) is inherited
 * from `session.subscribe` unchanged; that file carries the full derivation of
 * why a chained `queueMicrotask` cannot cross the dispatch response and
 * `setImmediate` can.
 *
 * The per-value schema is `SessionEventSchema` and the driver-category narrowing
 * is applied by this handler before `sub.next`, not by a narrower schema.
 * `DriverEvent` is Plan-006-owned and this module does not author it; filtering
 * at the boundary gets the same guarantee without minting a type this plan does
 * not own. The SDK consumer side pairs with that choice exactly — it validates
 * against the same full union rather than re-deriving the set a second time.
 */
export function registerDriverSubscribeEvents(
  registry: MethodRegistry,
  deps: DriverSubscribeEventsDeps,
): void {
  const handler: Handler<DriverSubscribeEventsParams, SubscribeAckResponse> = async (
    params,
    ctx,
  ) => {
    if (ctx.transportId === undefined) {
      // Per-connection streaming state needs a transport identity. A missing one
      // is a bootstrap or direct-test-call fault rather than a client protocol
      // violation, so a plain `Error` (mapped to `-32603`) is the honest
      // reporting — the same posture `session.subscribe` takes.
      throw new Error(
        "driver.subscribeEvents: handler requires ctx.transportId (per-connection streaming state requires a transport identity)",
      );
    }

    const sub = deps.streamingPrimitive.createSubscription<SessionEvent>(
      ctx.transportId,
      SessionEventSchema,
    );

    const replayBuffer: SessionEvent[] = [];
    let replayDrained = false;
    try {
      const unsubscribe = deps.subscribeToDriverEvents(params.runId, (event) => {
        // Filter BEFORE buffering, not at flush time: an event that must never
        // reach this stream should not occupy the replay buffer either, and
        // filtering in one place keeps the live-tail and replay paths from
        // drifting apart.
        if (!DRIVER_EVENT_TYPES.has(event.type)) {
          return;
        }
        if (replayDrained) {
          // Live-tail runs on a later turn, outside the reach of the try/catch
          // around setup. An unguarded `StreamingValidationError` here escapes
          // as an uncaught exception and can terminate the daemon; cancel this
          // subscription and keep every other one on the transport alive.
          // TRIPWIRE: replace `console.error` once a structured logger surfaces
          // in the runtime-daemon.
          try {
            sub.next(event);
          } catch (thrown) {
            sub.cancel();
            console.error(
              `[driver.subscribeEvents] live-tail event validation/emission failed for subscriptionId=${sub.subscriptionId}; subscription canceled`,
              thrown,
            );
          }
        } else {
          replayBuffer.push(event);
        }
      });
      sub.onCancel(unsubscribe);
    } catch (thrown) {
      // Atomicity guard: without this the streaming-primitive entry would orphan
      // in both of its maps until the transport closed.
      sub.cancel();
      translateDriverError(thrown);
    }

    setImmediate(() => {
      replayDrained = true;
      try {
        for (const event of replayBuffer) {
          sub.next(event);
        }
      } catch (thrown) {
        sub.cancel();
        console.error(
          `[driver.subscribeEvents] replay event validation/emission failed for subscriptionId=${sub.subscriptionId}; subscription canceled`,
          thrown,
        );
      }
      replayBuffer.length = 0;
    });

    return { subscriptionId: sub.subscriptionId };
  };

  registry.register(
    "driver.subscribeEvents",
    DriverSubscribeEventsParamsSchema,
    SubscribeAckResponseSchema,
    handler,
    { mutating: false },
  );
}
