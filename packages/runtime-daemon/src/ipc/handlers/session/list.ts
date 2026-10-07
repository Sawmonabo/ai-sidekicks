// `session.list`: the live sessions list. The acknowledgment carries every entry as it stands and
// the chats count; each change after it travels as the `value` of a `$/subscription/notify` frame
// keyed by the subscription id, and the client ends the stream with `$/subscription/cancel`.
//
// The snapshot is taken and the listener added in one synchronous step, so no change falls
// between them, and every change goes through the subscribe-init barrier, so none reaches the
// client ahead of the acknowledgment that names its subscription. The registration is not
// `mutating`, so a connection with an incompatible protocol version can still read.

import type { Handler, MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import {
  SESSION_DIRECTORY_METHOD_DESCRIPTORS,
  type SessionListAck,
  type SessionListChange,
  type SessionListRequest,
} from "@ai-sidekicks/contracts/session/directory";

import type { SessionListFeed, SessionListOpening } from "../../../session/directory/list-feed.js";
import { cancelAfterDetachedFailure, type StreamingPrimitive } from "../../streaming-primitive.js";
import { createSubscriptionAckBarrier } from "../../subscription-ack-barrier.js";

/** What `session.list`'s handler needs. */
export interface SessionListDeps {
  /** The streaming primitive every streaming handler shares, so disconnect cleanup is one map. */
  readonly streamingPrimitive: StreamingPrimitive;
  /** The daemon's one live sessions list. */
  readonly listFeed: Pick<SessionListFeed, "open">;
}

/**
 * Registers `session.list` on `registry`. A call with no transport identity is a daemon wiring
 * fault and throws a plain `Error`; a list that cannot be read rejects the call with nothing left
 * open. A feed that later fails to read a change ends the subscription with that failure.
 */
export function registerSessionList(registry: MethodRegistry, deps: SessionListDeps): void {
  const descriptor = SESSION_DIRECTORY_METHOD_DESCRIPTORS["session.list"];
  const handler: Handler<SessionListRequest, SessionListAck> = async (_request, context) => {
    if (context.transportId === undefined) {
      throw new Error("session.list: a subscription needs the transport it streams to");
    }
    const subscription = deps.streamingPrimitive.createSubscription<SessionListChange>(
      context.transportId,
      descriptor.emissionSchema,
    );
    const barrier = createSubscriptionAckBarrier(subscription, descriptor.method);
    let opening: SessionListOpening;
    try {
      opening = deps.listFeed.open({
        onChange: (change) => {
          barrier.emit(change);
        },
        onFailure: (error) => {
          // Ordered behind the acknowledgment, so the end frame never names an unknown id.
          barrier.deferUntilAck(() => {
            cancelAfterDetachedFailure(
              subscription,
              `[${descriptor.method}] the list stopped being current for subscriptionId=` +
                `${subscription.subscriptionId}; subscription canceled`,
              error,
            );
          });
        },
      });
      subscription.onCancel(opening.detach);
    } catch (error) {
      // The client never received this id, so the subscription goes without an end frame.
      deps.streamingPrimitive.cancelSubscription(subscription.subscriptionId);
      throw error;
    }
    barrier.release();
    return {
      subscriptionId: subscription.subscriptionId,
      sessions: opening.sessions,
      chatCount: opening.chatCount,
    };
  };
  registry.register(
    descriptor.method,
    descriptor.requestSchema,
    descriptor.responseSchema,
    handler as Handler<unknown, unknown>,
    { mutating: descriptor.mutating },
  );
}
