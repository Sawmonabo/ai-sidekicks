// The ordering barrier every subscribe handler sends its frames through. It guarantees the
// subscribe-init response `{ subscriptionId }` reaches the wire before the first
// `$/subscription/notify` frame for that subscription.
//
// * Why a barrier: a source may send its catch-up history synchronously inside the handler body,
//   so its emit callback can fire before the handler returns. The gateway writes the init response
//   in the dispatch promise's `.then` microtask, so an emission sent straight to the producer
//   would reach the socket ahead of the response. The SDK registers a subscription only after the
//   init response settles, so it drops such frames silently as unknown ids. The buffering has to
//   live below the handler, which cannot see when its own response was written.
// * Why `setImmediate`: microtasks queued from the handler's body drain in the same checkpoint,
//   ahead of the dispatch `.then`, so no number of `queueMicrotask` layers crosses the response.
//   `setImmediate` runs in the check phase after microtasks drain. `process.nextTick` runs before
//   promise microtasks, and `setTimeout(fn, 0)` has a 1 ms minimum. One `setImmediate` suffices.
// * This relies on the dispatch path resolving the response within microtasks, with no
//   `setImmediate` or `process.nextTick` deferral between handler return and the gateway's
//   synchronous `socket.write`. The subscribe handlers' wire-ordering tests catch a change that
//   adds one.

import type { JsonRpcError } from "@ai-sidekicks/contracts/jsonrpc/message";

import { cancelAfterDetachedFailure } from "./streaming-primitive.js";

/**
 * The producer surface a barrier drives: `LocalSubscriptionProducer<EmissionType>` narrowed to
 * emitting, canceling and naming the subscription in diagnostics.
 */
export interface AckBarrierProducer<EmissionType> {
  readonly subscriptionId: string;
  next(value: EmissionType): void;
  cancel(error?: JsonRpcError): void;
}

/**
 * A one-way gate in front of a subscription producer. Values passed to
 * {@link SubscriptionAckBarrier.emit} are buffered until {@link SubscriptionAckBarrier.release},
 * then forwarded directly. The handler calls `release` as it returns the init response, and the
 * flush runs one event-loop phase later, after that response has been written.
 */
export interface SubscriptionAckBarrier<EmissionType> {
  /** Buffers or forwards one value, depending on which side of the ack it is. */
  emit(value: EmissionType): void;
  /**
   * Orders a non-value producer action, such as a stream completion, against the same gate.
   * Without it, a projection that finishes synchronously would write its terminal frame ahead of
   * the init response. Actions queue in emission order, so a completion never overtakes its rows.
   */
  deferUntilAck(action: () => void): void;
  /**
   * Opens the gate and schedules the buffered flush past the init response. Idempotent, so a
   * double release does not schedule two flushes. Call it only on the success path: a handler
   * that throws during setup cancels the producer instead, and an unreleased barrier flushes
   * nothing.
   */
  release(): void;
}

/**
 * Builds a barrier over `producer`. `methodName` (the wire method, such as `session.subscribe`)
 * prefixes the log line so the person can tell which surface produced a bad value.
 *
 * `producer.next` throws `StreamingValidationError` for a value that fails the subscription's
 * schema, which is a producer bug rather than a client fault. Both the live path and the flush
 * run outside any dispatch error mapping, and an uncaught throw there can terminate the daemon.
 * So on either path the barrier cancels the subscription, which drains the primitive's maps,
 * logs, and abandons the rest of the drain; this costs one subscription's tail while the
 * transport's other subscriptions keep working. The log uses `console.error` because the daemon
 * has no structured logger.
 */
export function createSubscriptionAckBarrier<EmissionType>(
  producer: AckBarrierProducer<EmissionType>,
  methodName: string,
): SubscriptionAckBarrier<EmissionType> {
  // One queue of thunks, because emissions and completions must drain in the order produced.
  const pendingActions: (() => void)[] = [];
  let released = false;
  let scheduled = false;

  const runOrQueue = (action: () => void, failureKind: "live-tail" | "catch-up"): void => {
    if (!released) {
      pendingActions.push(action);
      return;
    }
    try {
      action();
    } catch (err) {
      cancelAfterDetachedFailure(
        producer,
        `[${methodName}] ${failureKind} event validation/emission failed for subscriptionId=` +
          `${producer.subscriptionId}; subscription canceled`,
        err,
      );
    }
  };

  return {
    emit(value: EmissionType): void {
      runOrQueue(() => {
        producer.next(value);
      }, "live-tail");
    },

    deferUntilAck(action: () => void): void {
      runOrQueue(action, "live-tail");
    },

    release(): void {
      if (scheduled) {
        return;
      }
      scheduled = true;
      setImmediate(() => {
        released = true;
        try {
          for (const action of pendingActions) {
            action();
          }
        } catch (err) {
          cancelAfterDetachedFailure(
            producer,
            `[${methodName}] catch-up event validation/emission failed for subscriptionId=` +
              `${producer.subscriptionId}; subscription canceled`,
            err,
          );
        }
        pendingActions.length = 0;
      });
    },
  };
}
