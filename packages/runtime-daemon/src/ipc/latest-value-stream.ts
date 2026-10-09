// A subscription whose every value is whole and replaces the one before: a list sent entire on
// each change, a card's whole state, a mark that a folder changed. Each value goes out behind the
// acknowledgment that names its subscription, and never past a full outbound queue: a value that
// finds the queue full waits, only the newest kept, and goes out once the queue drains. So what
// waits per subscription is one value, and the reader always ends on the newest.

import type { SubscribeAckResponse } from "@ai-sidekicks/contracts/jsonrpc/streaming";
import type { ZodType } from "zod";

import type { OutboundQueue } from "./handlers/session/subscribe.js";
import { cancelAfterDetachedFailure, type StreamingPrimitive } from "./streaming-primitive.js";
import { createSubscriptionAckBarrier } from "./subscription-ack-barrier.js";

/** What every latest-value stream is opened through. */
export interface LatestValueStreamDeps {
  /** The streaming primitive every streaming handler shares, so disconnect cleanup is one map. */
  readonly streamingPrimitive: StreamingPrimitive;
  /** The outbound queues of the daemon's connections, which pace each value. */
  readonly outboundQueue: OutboundQueue;
}

/** How a source hands the stream its values and its failure. */
interface LatestValueOutlet<Value> {
  /** Sends `value`, or holds it in place of the one held while the queue is full. */
  readonly send: (value: Value) => void;
  /** Ends the stream with `error`, for a source that can no longer follow. */
  readonly fail: (error: unknown) => void;
}

/** One stream to open: the method it answers, its values' schema and the source it follows. */
export interface LatestValueStreamRequest<Value> {
  /** The wire method, which names the stream in the service log. */
  readonly method: string;
  readonly emissionSchema: ZodType<Value>;
  /** The connection the call came in on; `undefined` is a daemon wiring fault. */
  readonly transportId: number | undefined;
  /**
   * Starts following the source, which may send at once, and answers the detach the stream runs
   * when it ends. A follow that throws or rejects opens nothing, and its failure is the call's.
   */
  readonly follow: (outlet: LatestValueOutlet<Value>) => (() => void) | Promise<() => void>;
}

/**
 * Opens a latest-value stream and answers its acknowledgment. Throws a plain `Error` for a call
 * with no transport, and what the source's follow threw, with nothing left open.
 */
export async function openLatestValueStream<Value>(
  deps: LatestValueStreamDeps,
  request: LatestValueStreamRequest<Value>,
): Promise<SubscribeAckResponse> {
  const { transportId } = request;
  if (transportId === undefined) {
    throw new Error(`${request.method}: a subscription needs the transport it streams to`);
  }
  const subscription = deps.streamingPrimitive.createSubscription<Value>(
    transportId,
    request.emissionSchema,
  );
  const barrier = createSubscriptionAckBarrier(subscription, request.method);
  let held: { readonly value: Value } | undefined;
  let detachDrained: (() => void) | undefined;
  let isStopped = false;

  const sendNow = (value: Value): void => {
    if (isStopped) return;
    if (detachDrained === undefined && !deps.outboundQueue.isFull(transportId)) {
      barrier.emit(value);
      return;
    }
    held = { value };
    detachDrained ??= deps.outboundQueue.onceDrained(transportId, () => {
      detachDrained = undefined;
      const next = held;
      held = undefined;
      if (next !== undefined) sendNow(next.value);
    });
  };
  subscription.onCancel(() => {
    isStopped = true;
    held = undefined;
    detachDrained?.();
    detachDrained = undefined;
  });

  const outlet: LatestValueOutlet<Value> = {
    // Ordered behind the acknowledgment, so the queue is read only once the id is on the wire.
    send: (value) => {
      barrier.deferUntilAck(() => {
        sendNow(value);
      });
    },
    fail: (error) => {
      barrier.deferUntilAck(() => {
        cancelAfterDetachedFailure(
          subscription,
          `[${request.method}] the source stopped for subscriptionId=` +
            `${subscription.subscriptionId}; subscription canceled`,
          error,
        );
      });
    },
  };
  let detach: () => void;
  try {
    detach = await request.follow(outlet);
  } catch (error) {
    // The client never received this id, so the subscription goes without an end frame.
    deps.streamingPrimitive.cancelSubscription(subscription.subscriptionId);
    throw error;
  }
  // Runs at once when the connection closed while the source was being followed.
  subscription.onCancel(detach);
  barrier.release();
  return { subscriptionId: subscription.subscriptionId };
}
