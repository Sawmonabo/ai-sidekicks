// `driver.subscribeEvents`: one run's driver events, replay then tail, over the streaming
// primitive. The request/response driver verbs live in `driver-handlers.ts`; this one is
// separate because it allocates per-connection state and its teardown must survive wire cancel,
// transport disconnect and internal cancellation alike.
//
// The response is the shared `SubscribeAckResponse`, the opaque `subscriptionId` and nothing
// else; values follow as `$/subscription/notify` frames. The client SDK's
// `createDaemonProviderClient(...).subscribeEvents(...)` is the matching consumer.
//
// Invariants:
//   * The registry parses the request against `DriverSubscribeEventsParamsSchema`, and the
//     streaming primitive parses every emitted value against `SessionEventSchema` before it
//     reaches the wire.
//   * The subscribe-init response precedes the first notify frame: events reported while the
//     handler runs are buffered and sent on the next `setImmediate`, which runs after the
//     dispatch promise has written the response (a microtask would not).
//
// The registration is not `mutating`: it changes no domain row, so a version-mismatched
// connection keeps this method.

import type {
  DriverSubscribeEventsParams,
  Handler,
  MethodRegistry,
  RunId,
  SessionEvent,
  SubscribeAckResponse,
} from "@ai-sidekicks/contracts";
import {
  DRIVER_EVENT_TYPES,
  DriverSubscribeEventsParamsSchema,
  SessionEventSchema,
  SubscribeAckResponseSchema,
} from "@ai-sidekicks/contracts";

import type { StreamingPrimitive } from "../streaming-primitive.js";
import { translateDriverError } from "./driver-handlers.js";

/** Dependencies for `driver.subscribeEvents`. */
export interface DriverSubscribeEventsDeps {
  /**
   * The streaming primitive every streaming handler shares, so the per-transport index that
   * `cleanupTransport` walks stays one.
   */
  readonly streamingPrimitive: StreamingPrimitive;
  /**
   * The upstream driver event source for one run. Returns the detach the handler runs on
   * wire cancel, transport disconnect or internal teardown.
   *
   * Setup failures (unknown run, no live binding) must throw synchronously: the handler
   * cancels the subscription it allocated on a synchronous throw, and a later rejection would
   * orphan the streaming-primitive entry until transport cleanup.
   */
  readonly subscribeToDriverEvents: (
    runId: RunId,
    onEvent: (event: SessionEvent) => void,
  ) => () => void;
}

/**
 * Binds `driver.subscribeEvents` onto the registry. A dispatch without a transport id throws a
 * plain `Error` (an internal error on the wire), and a failing `subscribeToDriverEvents` is
 * mapped through `translateDriverError` after the subscription is canceled.
 *
 * The stream validates against `SessionEventSchema` and drops any event outside
 * `DRIVER_EVENT_TYPES`, so a session-wide source does not cancel the subscription over an
 * approval or audit row. The client SDK validates the narrower `DriverEventSchema`.
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
      // A missing transport identity is a daemon wiring fault, not a client error: a plain
      // `Error`, mapped to `-32603`.
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
        // Filtered before buffering so a non-driver event never enters the replay buffer.
        if (!DRIVER_EVENT_TYPES.has(event.type)) {
          return;
        }
        if (replayDrained) {
          // The live tail runs outside the setup try/catch: an unguarded
          // `StreamingValidationError` would escape as an uncaught exception and could stop the
          // daemon. Cancel this subscription and keep the others alive.
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
      // Otherwise the streaming-primitive entry would stay registered until the transport closed.
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
