// `session.subscribe`: a session's event stream, catch up, then follow, sent to the screen in
// batched frames. The request names the session and, in `afterCursor`, where to catch up from;
// the response carries only the `subscriptionId`. Each change then travels as the `value` of a
// `$/subscription/notify` frame keyed by that id; the client ends the stream with
// `$/subscription/cancel`.
//
// How changes reach the screen:
//   * Batched by the stream batcher every stream shares, every change carrying its cursor. Once
//     caught up, a live frame that meets a full outbound queue is dropped, holding nothing, and the
//     next frame that fits carries the drop mark, so the screen repairs from the daemon's record
//     by cursor; a session that went quiet after a drop still gets one frame with no changes, the
//     drop mark and the newest cursor, once the queue has room.
//   * Catching up at the connection's pace, dropping nothing. The upstream reads the log a page at
//     a time and hands over a stored change only while the outbound queue has room, so a client
//     that reads nothing never makes the daemon read the whole log for it. A catch-up frame that
//     finds the queue full waits for room instead of being dropped; it holds at most one frame,
//     since the upstream hands over nothing more until the queue drains. The upstream says when
//     the catch-up is over, and its last changes go out then rather than at the window's close.
//   * Ordered after the ack. The upstream may catch up synchronously inside this handler, so
//     every frame goes through the subscribe-init barrier, which holds it until the response
//     has been written. An upstream that fails after that ends the subscription with its error.
//
// The registration is not `mutating`, so a connection with an incompatible protocol version
// can still read.

import type {
  SessionStreamChange,
  SessionStreamFrame,
  SessionSubscribeRequest,
  SessionSubscribeResponse,
} from "@ai-sidekicks/contracts/session/methods";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { EventCursor } from "@ai-sidekicks/contracts/session/event-cursor";
import type { Handler, MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import type { EventEnvelope } from "@ai-sidekicks/contracts/event/envelope";
import { SESSION_DIRECTORY_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/session/directory";
import {
  SessionSubscribeRequestSchema,
  SessionSubscribeResponseSchema,
} from "@ai-sidekicks/contracts/session/methods";

import type { SessionEventListener } from "../../../events/session/followers.js";
import { createStreamFrameBatcher } from "../../stream-frame-batcher.js";
import { createSubscriptionAckBarrier } from "../../subscription-ack-barrier.js";
import { cancelAfterDetachedFailure, type StreamingPrimitive } from "../../streaming-primitive.js";

type SessionChange = SessionStreamChange<EventEnvelope>;
type SessionFrame = SessionStreamFrame<EventEnvelope>;

/**
 * A connection's outbound queue, as the stream needs to see it: whether a frame sent now would
 * fit, and a signal for when it has room again.
 */
export interface OutboundQueue {
  /** Whether the connection's outbound queue is full, so a frame sent now would not fit. */
  isFull(transportId: number): boolean;
  /** Calls `listener` once the connection's outbound queue has room again. Returns a detach. */
  onceDrained(transportId: number, listener: () => void): () => void;
}

/** What `session.subscribe`'s handler needs. */
export interface SessionSubscribeDeps {
  /** The streaming primitive every streaming handler shares, so disconnect cleanup is one map. */
  readonly streamingPrimitive: StreamingPrimitive;
  /** The outbound queues of the daemon's connections. */
  readonly outboundQueue: OutboundQueue;
  /**
   * Follows a session's stored events (`EventLogService.follow`): catches up with those after
   * `afterCursor` (all of them when absent), handing each over only while the listener has room,
   * calls `onCaughtUp` once they are all delivered, then follows new ones, calling `onChange` with
   * each event, its cursor and, for an event of a run, its run stamp, and `onFailure` once if the
   * follow ends on an error. Returns the detach the handler runs when the subscription ends.
   * `onChange` may run synchronously during this call, and the detach may run from inside
   * `onChange`, so the source must tolerate being detached mid-emit. A session that does not
   * exist, or a cursor it cannot read, throws.
   */
  readonly subscribeToSession: (
    sessionId: SessionId,
    afterCursor: EventCursor | undefined,
    listener: SessionEventListener,
  ) => () => void;
}

/**
 * Registers `session.subscribe` on `registry`.
 *
 * A call with no transport identity is a daemon wiring fault, not a client error, so it throws
 * a plain `Error` the registry maps to an internal error. A session the upstream cannot follow
 * throws from `subscribeToSession`; the subscription is canceled so nothing is left behind. An
 * upstream that fails later ends the subscription with that failure.
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
      throw new Error(
        "session.subscribe: handler requires ctx.transportId (per-connection streaming state " +
          "requires a transport identity)",
      );
    }
    const transportId = ctx.transportId;

    const sub = deps.streamingPrimitive.createSubscription<SessionFrame>(
      transportId,
      SESSION_DIRECTORY_METHOD_DESCRIPTORS["session.subscribe"].emissionSchema,
    );
    const barrier = createSubscriptionAckBarrier(sub, "session.subscribe");
    const batcher = createStreamFrameBatcher<SessionChange, EventCursor>(
      {
        emit: (frame) => {
          barrier.emit(frame);
        },
        isFull: () => deps.outboundQueue.isFull(transportId),
        onceDrained: (listener) => deps.outboundQueue.onceDrained(transportId, listener),
      },
      { isCatchingUp: true, heldChangesMax: 0 },
    );
    sub.onCancel(() => {
      batcher.stop();
    });

    try {
      const unsubscribe = deps.subscribeToSession(params.sessionId, params.afterCursor, {
        onChange: (change) => {
          batcher.add(change);
        },
        onCaughtUp: () => {
          batcher.endCatchUp();
        },
        onFailure: (error) => {
          // Ordered behind the acknowledgment, so the end frame never names an unknown id.
          barrier.deferUntilAck(() => {
            cancelAfterDetachedFailure(
              sub,
              `[session.subscribe] the session's events stopped arriving for subscriptionId=` +
                `${sub.subscriptionId}; subscription canceled`,
              error,
            );
          });
        },
        isFull: () => deps.outboundQueue.isFull(transportId),
        onceDrained: (listener) => deps.outboundQueue.onceDrained(transportId, listener),
      });
      sub.onCancel(unsubscribe);
    } catch (err) {
      // The client never received this id, so the subscription goes without an end frame.
      deps.streamingPrimitive.cancelSubscription(sub.subscriptionId);
      throw err;
    }
    barrier.release();

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
