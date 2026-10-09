// `session.subscribe`: a session's event stream, catch up, then follow, sent to the screen in
// batched frames. The request names the session and, in `afterCursor`, where to catch up from;
// the response carries only the `subscriptionId`. Each change then travels as the `value` of a
// `$/subscription/notify` frame keyed by that id; the client ends the stream with
// `$/subscription/cancel`.
//
// How changes reach the screen:
//   * Batched. The first change opens a window of `SESSION_STREAM_WINDOW_MS`; its changes go out
//     as one frame when it closes, or at once at `STREAM_FRAME_MAX_CHANGES`. It is a throttle,
//     not a debounce, so no change waits longer than one window. Every change carries its cursor.
//   * Never waiting for a screen once caught up. When the connection's outbound queue is full,
//     the live frame that would not fit is dropped and the next frame that fits carries the drop
//     mark, so the screen repairs from the daemon's record by cursor. If nothing new happens after
//     a drop, one frame with no changes, the drop mark and the newest cursor goes out as soon as
//     the queue has room, so a session that went quiet still tells the screen it is behind.
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
import { STREAM_FRAME_MAX_CHANGES } from "@ai-sidekicks/contracts/jsonrpc/streaming";

import type { SessionEventListener } from "../../../events/session/followers.js";
import { createSubscriptionAckBarrier } from "../../subscription-ack-barrier.js";
import { cancelAfterDetachedFailure, type StreamingPrimitive } from "../../streaming-primitive.js";

/** How long the first change of a batch waits for others before its frame goes out. */
export const SESSION_STREAM_WINDOW_MS = 16;

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
   * each event and its cursor, and `onFailure` once if the follow ends on an error. Returns the
   * detach the handler runs when the subscription ends. `onChange` may run synchronously during
   * this call, and the detach may run from inside `onChange`, so the source must tolerate being
   * detached mid-emit. A session that does not exist, or a cursor it cannot read, throws.
   */
  readonly subscribeToSession: (
    sessionId: SessionId,
    afterCursor: EventCursor | undefined,
    listener: SessionEventListener,
  ) => () => void;
}

/** Where a batcher sends frames and how it reads its connection's queue. */
interface FrameOutlet {
  emit(frame: SessionFrame): void;
  isFull(): boolean;
  onceDrained(listener: () => void): () => void;
}

interface FrameBatcher {
  add(change: SessionChange): void;
  /** Ends the catch-up: its last changes go out now, and a later frame that does not fit drops. */
  endCatchUp(): void;
  stop(): void;
}

function createFrameBatcher(outlet: FrameOutlet): FrameBatcher {
  let pending: SessionChange[] = [];
  let windowTimer: ReturnType<typeof setTimeout> | undefined;
  let newestDroppedCursor: EventCursor | undefined;
  let detachDrained: (() => void) | undefined;
  let isCatchingUp = true;
  let stopped = false;

  const flushWhenDrained = (): void => {
    detachDrained ??= outlet.onceDrained(() => {
      detachDrained = undefined;
      flush();
    });
  };

  const flush = (): void => {
    if (windowTimer !== undefined) {
      clearTimeout(windowTimer);
      windowTimer = undefined;
    }
    if (outlet.isFull()) {
      if (isCatchingUp) {
        // A stored change is never dropped: it waits for room, and the upstream hands over no
        // more until then.
        if (pending.length > 0) {
          flushWhenDrained();
        }
        return;
      }
      const newest = pending.at(-1);
      if (newest !== undefined) {
        newestDroppedCursor = newest.cursor;
        pending = [];
      }
      if (newestDroppedCursor !== undefined) {
        flushWhenDrained();
      }
      return;
    }
    const changes = pending;
    pending = [];
    let frame: SessionFrame;
    if (newestDroppedCursor === undefined) {
      if (changes.length === 0) {
        return;
      }
      frame = { changes };
    } else if (changes.length === 0) {
      frame = { changes, dropped: true, cursor: newestDroppedCursor };
    } else {
      frame = { changes, dropped: true };
    }
    newestDroppedCursor = undefined;
    detachDrained?.();
    detachDrained = undefined;
    outlet.emit(frame);
  };

  return {
    add(change: SessionChange): void {
      if (stopped) {
        return;
      }
      pending.push(change);
      if (pending.length >= STREAM_FRAME_MAX_CHANGES) {
        flush();
      } else if (windowTimer === undefined) {
        windowTimer = setTimeout(flush, SESSION_STREAM_WINDOW_MS);
      }
    },
    endCatchUp(): void {
      isCatchingUp = false;
      // The upstream ends its catch-up only while the queue has room, so the stored changes still
      // pending go out now rather than meet a full queue at the window's close.
      flush();
    },
    stop(): void {
      stopped = true;
      if (windowTimer !== undefined) {
        clearTimeout(windowTimer);
        windowTimer = undefined;
      }
      detachDrained?.();
      detachDrained = undefined;
      pending = [];
    },
  };
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
    const batcher = createFrameBatcher({
      emit: (frame) => {
        barrier.emit(frame);
      },
      isFull: () => deps.outboundQueue.isFull(transportId),
      onceDrained: (listener) => deps.outboundQueue.onceDrained(transportId, listener),
    });
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
