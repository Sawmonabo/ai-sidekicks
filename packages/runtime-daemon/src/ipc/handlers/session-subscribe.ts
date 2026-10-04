// `session.subscribe`: a session's event stream, replay then tail, sent to the screen in
// batched frames. The request names the session and, in `afterCursor`, where to replay from;
// the response carries only the `subscriptionId`. Each change then travels as the `value` of a
// `$/subscription/notify` frame keyed by that id; the client ends the stream with
// `$/subscription/cancel`.
//
// How changes reach the screen:
//   * Batched. The first change opens a window of `SESSION_STREAM_WINDOW_MS`; its changes go out
//     as one frame when it closes, or at once at `STREAM_FRAME_MAX_CHANGES`. It is a throttle,
//     not a debounce, so no change waits longer than one window. Every change carries its cursor.
//   * Never waiting for a screen. When the connection's outbound queue is full, the frame that
//     would not fit is dropped and the next frame that fits carries the drop mark, so the
//     screen repairs from the daemon's record by cursor. If nothing new happens after a drop,
//     one frame with no changes, the drop mark and the newest cursor goes out as soon as the
//     queue has room, so a session that went quiet still tells the screen it is behind.
//   * Ordered after the ack. The upstream may replay synchronously inside this handler, so
//     every frame goes through the subscribe-init barrier, which holds it until the response
//     has been written.
//
// The registration is not `mutating`, so a connection with an incompatible protocol version
// can still read.

import type {
  EventCursor,
  SessionId,
  SessionStreamChange,
  SessionStreamFrame,
  SessionSubscribeRequest,
  SessionSubscribeResponse,
} from "@ai-sidekicks/contracts/session";
import type { Handler, MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc-registry";
import type { SessionEvent } from "@ai-sidekicks/contracts/event-variant-types";
import { SessionEventSchema } from "@ai-sidekicks/contracts/event";
import {
  SessionStreamFrameSchema,
  SessionSubscribeRequestSchema,
  SessionSubscribeResponseSchema,
} from "@ai-sidekicks/contracts/session";
import { STREAM_FRAME_MAX_CHANGES } from "@ai-sidekicks/contracts/jsonrpc-streaming";

import { createSubscriptionAckBarrier } from "../subscription-ack-barrier.js";
import type { StreamingPrimitive } from "../streaming-primitive.js";

/** How long the first change of a batch waits for others before its frame goes out. */
export const SESSION_STREAM_WINDOW_MS = 16;

const SESSION_STREAM_FRAME_SCHEMA = SessionStreamFrameSchema(SessionEventSchema);

type SessionChange = SessionStreamChange<SessionEvent>;
type SessionFrame = SessionStreamFrame<SessionEvent>;

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
   * Follows a session's events: replays those after `afterCursor` (all of them when absent),
   * then tails new ones, calling `onChange` with each event and its cursor. Returns the detach
   * the handler runs when the subscription ends. `onChange` may run synchronously during this
   * call, and the detach may run from inside `onChange`, so the source must tolerate being
   * detached mid-emit. A session that does not exist, or a cursor it cannot read, throws.
   */
  readonly subscribeToSession: (
    sessionId: SessionId,
    afterCursor: EventCursor | undefined,
    onChange: (change: SessionChange) => void,
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
  stop(): void;
}

function createFrameBatcher(outlet: FrameOutlet): FrameBatcher {
  let pending: SessionChange[] = [];
  let windowTimer: ReturnType<typeof setTimeout> | undefined;
  let newestDroppedCursor: EventCursor | undefined;
  let detachDrained: (() => void) | undefined;
  let stopped = false;

  const flush = (): void => {
    if (windowTimer !== undefined) {
      clearTimeout(windowTimer);
      windowTimer = undefined;
    }
    if (outlet.isFull()) {
      const newest = pending.at(-1);
      if (newest !== undefined) {
        newestDroppedCursor = newest.cursor;
        pending = [];
      }
      if (newestDroppedCursor !== undefined && detachDrained === undefined) {
        detachDrained = outlet.onceDrained(() => {
          detachDrained = undefined;
          flush();
        });
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
 * throws from `subscribeToSession`; the subscription is canceled so nothing is left behind.
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
        "session.subscribe: handler requires ctx.transportId (per-connection streaming state requires a transport identity)",
      );
    }
    const transportId = ctx.transportId;

    const sub = deps.streamingPrimitive.createSubscription<SessionFrame>(
      transportId,
      SESSION_STREAM_FRAME_SCHEMA,
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
      const unsubscribe = deps.subscribeToSession(
        params.sessionId,
        params.afterCursor,
        (change) => {
          batcher.add(change);
        },
      );
      sub.onCancel(unsubscribe);
    } catch (err) {
      sub.cancel();
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
