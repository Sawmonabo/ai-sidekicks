// `presence.subscribe`: follows the devices connected to this machine as they
// come, go and change.
//
// Presence is the machine's, never a session's, so the request is empty. The
// response carries only the `subscriptionId`; after it, each change travels as the
// `value` of a `$/subscription/notify` frame keyed by that id: the whole list of
// devices connected to this machine, validated against `MachinePresenceSchema`
// before it is sent. The list is held in memory, one entry per device, and is
// never written to storage or to any session's log.
//
// Ordered after the ack: a change the source reports while this handler is still
// running is held and sent on the next `setImmediate`, after the `{subscriptionId}`
// response has been written, so no push reaches the client before the id it is
// keyed by.
//
// Why `mutating: false`: opening a subscription changes no state, so a connection
// whose protocol version is incompatible can still follow presence.

import type {
  Handler,
  MachinePresence,
  MethodRegistry,
  PresenceSubscribeRequest,
  PresenceSubscribeResponse,
} from "@ai-sidekicks/contracts";
import {
  MachinePresenceSchema,
  PresenceSubscribeRequestSchema,
  PresenceSubscribeResponseSchema,
} from "@ai-sidekicks/contracts";

import type { StreamingPrimitive } from "../streaming-primitive.js";

/** What `presence.subscribe`'s handler needs. */
export interface PresenceSubscribeDeps {
  /** The streaming primitive every streaming handler shares, so disconnect cleanup is one map. */
  readonly streamingPrimitive: StreamingPrimitive;

  /**
   * Follows the devices connected to this machine, calling `onUpdate` with the
   * whole list each time a device connects, disconnects or reports a change.
   * Returns the detach the handler runs when the subscription is canceled or its
   * connection closes.
   *
   * `onUpdate` may run synchronously during this call, and the detach may run
   * from inside `onUpdate` (a failed push cancels the subscription), so the
   * source must tolerate being detached mid-emit. A failure to start following
   * throws.
   */
  readonly subscribeToPresence: (onUpdate: (update: MachinePresence) => void) => () => void;
}

/**
 * Bind `presence.subscribe`. A second registration on the same registry throws.
 *
 * A dispatch without a transport id throws a plain `Error` (an internal error on
 * the wire): a subscription's state belongs to a connection, so a call with none
 * is a daemon bug, not a client's mistake.
 */
export function registerPresenceSubscribe(
  registry: MethodRegistry,
  deps: PresenceSubscribeDeps,
): void {
  const handler: Handler<PresenceSubscribeRequest, PresenceSubscribeResponse> = async (
    _params,
    ctx,
  ) => {
    if (ctx.transportId === undefined) {
      throw new Error(
        "presence.subscribe: handler requires ctx.transportId (per-connection streaming state requires a transport identity)",
      );
    }
    const sub = deps.streamingPrimitive.createSubscription<MachinePresence>(
      ctx.transportId,
      MachinePresenceSchema,
    );

    // A list reported while this handler runs is held until the `{subscriptionId}`
    // response is written; `setImmediate` runs after the dispatch promise has
    // resolved it.
    const replayBuffer: MachinePresence[] = [];
    let replayDrained = false;
    try {
      const unsubscribe = deps.subscribeToPresence((update) => {
        if (!replayDrained) {
          replayBuffer.push(update);
          return;
        }
        // This runs on the source's turn, outside the registry's error mapping, so
        // a list that fails its schema would otherwise escape as an uncaught
        // exception and could stop the daemon. The subscription is canceled and
        // the failure logged: the source is at fault, and the connection's other
        // subscriptions keep working.
        try {
          sub.next(update);
        } catch (err) {
          sub.cancel();
          console.error(
            `[presence.subscribe] live-tail update validation/emission failed for subscriptionId=${sub.subscriptionId}; subscription canceled`,
            err,
          );
        }
      });
      // Cancel from the wire, a closed connection and internal teardown all detach
      // the source through here, so no subscription leaves a watcher behind.
      sub.onCancel(unsubscribe);
    } catch (err) {
      // The source failed to start: drop the subscription's entry before the
      // error reaches the client.
      sub.cancel();
      throw err;
    }
    setImmediate(() => {
      replayDrained = true;
      // As on the live path, a list that fails its schema here would escape
      // `setImmediate` uncaught, so it cancels the subscription and is logged.
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
