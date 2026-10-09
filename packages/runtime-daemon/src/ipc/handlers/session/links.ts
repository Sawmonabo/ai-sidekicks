// The person's session link verbs: `session.linkAdd` and `session.linkRemove` for a `related`
// link, and `session.relatedList`, a session's ranked related list, live.
//
// `session.relatedList` answers only the `subscriptionId`; the first `$/subscription/notify` value
// is the whole list, and each later one the whole list again after it was re-scored. The first
// list is read inside the handler, so it goes through the subscription ack barrier, which holds it
// until the `{subscriptionId}` response is written. The registration is not `mutating`, so a
// connection with an incompatible protocol version can still read.

import type { Handler, MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import type { SubscribeAckResponse } from "@ai-sidekicks/contracts/jsonrpc/streaming";
import {
  SESSION_LINK_METHOD_DESCRIPTORS,
  SessionRelatedListUpdateSchema,
  type SessionRelatedListRequest,
  type SessionRelatedListUpdate,
} from "@ai-sidekicks/contracts/session/links";

import type { SessionLinkService } from "../../../session/links/service.js";
import type { SessionRelatedRanking } from "../../../session/related/ranking.js";
import type { StreamingPrimitive } from "../../streaming-primitive.js";
import { createSubscriptionAckBarrier } from "../../subscription-ack-barrier.js";
import {
  registerDescribedMethod,
  registerDescribedSubscription,
} from "../register-described-method.js";

/** What the link verbs call. */
export interface SessionLinkMethodsDeps {
  readonly links: Pick<SessionLinkService, "add" | "remove">;
  readonly relatedRanking: Pick<SessionRelatedRanking, "follow">;
  /** The streaming primitive every streaming handler shares, so disconnect cleanup is one map. */
  readonly streamingPrimitive: StreamingPrimitive;
}

/**
 * Binds the two link verbs and `session.relatedList` onto the registry. A second binding on one
 * registry throws. A subscription for an unknown session is refused with `session.not_found`, and
 * one with no transport identity is a daemon wiring fault, thrown as a plain `Error`.
 */
export function registerSessionLinkMethods(
  registry: MethodRegistry,
  deps: SessionLinkMethodsDeps,
): void {
  registerDescribedMethod(
    registry,
    SESSION_LINK_METHOD_DESCRIPTORS["session.linkAdd"],
    async (request) => {
      await deps.links.add(request);
      return {};
    },
  );
  registerDescribedMethod(
    registry,
    SESSION_LINK_METHOD_DESCRIPTORS["session.linkRemove"],
    async (request) => {
      await deps.links.remove(request);
      return {};
    },
  );

  const followRelatedList: Handler<SessionRelatedListRequest, SubscribeAckResponse> = async (
    params,
    ctx,
  ) => {
    if (ctx.transportId === undefined) {
      throw new Error("session.relatedList: a subscription needs the connection's transport id");
    }
    const subscription = deps.streamingPrimitive.createSubscription<SessionRelatedListUpdate>(
      ctx.transportId,
      SessionRelatedListUpdateSchema,
    );
    const barrier = createSubscriptionAckBarrier(subscription, "session.relatedList");
    try {
      const unfollow = deps.relatedRanking.follow(params.sessionId, (update) => {
        barrier.emit(update);
      });
      subscription.onCancel(unfollow);
    } catch (error) {
      // The client never received this id, so the subscription goes without an end frame.
      deps.streamingPrimitive.cancelSubscription(subscription.subscriptionId);
      throw error;
    }
    barrier.release();
    return { subscriptionId: subscription.subscriptionId };
  };
  const descriptor = SESSION_LINK_METHOD_DESCRIPTORS["session.relatedList"];
  registerDescribedSubscription(registry, descriptor, followRelatedList);
}
