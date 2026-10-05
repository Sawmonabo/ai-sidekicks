// `presence.subscribe`: follows the devices connected to this machine as they come, go and
// change. Presence belongs to the machine, not a session, so the request is empty. The response
// carries only the `subscriptionId`; each change then travels as the `value` of a
// `$/subscription/notify` frame keyed by that id: the whole list of connected devices,
// validated against `MachinePresenceSchema`. The list lives in memory only.
//
// A change reported while the handler is still running is held by the subscription ack barrier
// until the `{subscriptionId}` response is written, so no push reaches the client before the id
// it is keyed by. The registration is not `mutating`, so a connection with an incompatible
// protocol version can still follow presence.

import type { Handler, MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import type {
  MachinePresence,
  PresenceSubscribeRequest,
  PresenceSubscribeResponse,
} from "@ai-sidekicks/contracts/presence";
import {
  MachinePresenceSchema,
  PresenceSubscribeRequestSchema,
  PresenceSubscribeResponseSchema,
} from "@ai-sidekicks/contracts/presence";

import type { StreamingPrimitive } from "../../streaming-primitive.js";
import { createSubscriptionAckBarrier } from "../../subscription-ack-barrier.js";

/** What `presence.subscribe`'s handler needs. */
export interface PresenceSubscribeDeps {
  /** The streaming primitive every streaming handler shares, so disconnect cleanup is one map. */
  readonly streamingPrimitive: StreamingPrimitive;

  /**
   * Follows the devices connected to this machine, calling `onUpdate` with the whole list each
   * time a device connects, disconnects or reports a change. Returns the detach the handler runs
   * when the subscription is canceled or its connection closes.
   *
   * `onUpdate` may run synchronously during this call, and the detach may run from inside
   * `onUpdate` (a failed push cancels the subscription), so the source must tolerate being
   * detached mid-emit. A failure to start following throws.
   */
  readonly subscribeToPresence: (onUpdate: (update: MachinePresence) => void) => () => void;
}

/**
 * Binds `presence.subscribe` onto the registry. A second binding on one registry throws. A
 * dispatch without a transport id throws a plain `Error` (an internal error on the wire): a
 * subscription belongs to a connection, so a call with none is a daemon bug.
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
        "presence.subscribe: handler requires ctx.transportId (per-connection streaming " +
          "state requires a transport identity)",
      );
    }
    const sub = deps.streamingPrimitive.createSubscription<MachinePresence>(
      ctx.transportId,
      MachinePresenceSchema,
    );

    const barrier = createSubscriptionAckBarrier(sub, "presence.subscribe");
    try {
      const unsubscribe = deps.subscribeToPresence((update) => {
        barrier.emit(update);
      });
      // Every way a subscription ends detaches the source here, so no watcher is left behind.
      sub.onCancel(unsubscribe);
    } catch (err) {
      // The source failed to start: drop the subscription before the error reaches the client.
      sub.cancel();
      throw err;
    }
    barrier.release();

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
