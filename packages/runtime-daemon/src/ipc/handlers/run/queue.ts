// The run queue's calls: a send, the queue's list, the removal and reorder of a waiting message,
// and the queue's stream, the lead's or a child's.
//
// - The registry parses each request against its descriptor's schema before the handler runs, and
//   every send is made by the device the gateway stamps on the call.
// - `run.subscribeQueue` carries each message as it changes. A screen returning with a cursor is
//   first sent what changed past it, read from the record in the same turn the stream starts
//   following, so nothing falls between the two; one with none reads the queue with
//   `run.queueList`. The catch-up drops nothing: it ends once the connection has room. Its
//   changes are batched like every session stream; a screen that stops reading is dropped for
//   past the run streams' held changes, and once its connection has room again it gets one frame
//   with the drop mark and the newest cursor, and repairs by cursor or by reading the queue again.
//   Every frame goes out after the acknowledgment.

import type { Handler, MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import { RUN_CONTROL_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/run/control";
import type {
  RunQueueStreamChange,
  RunQueueStreamFrame,
  RunQueueSubscribeRequest,
} from "@ai-sidekicks/contracts/run/queue";
import type { EventCursor } from "@ai-sidekicks/contracts/session/event-cursor";
import type { SubscribeAckResponse } from "@ai-sidekicks/contracts/jsonrpc/streaming";
import { canonicalizeUuid } from "@ai-sidekicks/contracts/uuid-canonical";

import type { QueueRecorder } from "../../../queue/recorder.js";
import type { RunQueue } from "../../../queue/service.js";
import { callingDeviceOf } from "../../registry.js";
import {
  createStreamFrameBatcher,
  RUN_STREAM_HELD_CHANGES_MAX,
} from "../../stream-frame-batcher.js";
import type { StreamingPrimitive } from "../../streaming-primitive.js";
import { createSubscriptionAckBarrier } from "../../subscription-ack-barrier.js";
import { resolveDriverForSessionOrThrow, type SessionDriverDeps } from "../driver/resolution.js";
import {
  registerDescribedMethod,
  registerDescribedSubscription,
} from "../register-described-method.js";
import type { OutboundQueue } from "../session/subscribe.js";

/** What the run queue's handlers call. */
export interface RunQueueHandlerDeps {
  readonly queue: Pick<RunQueue, "create" | "list" | "cancel" | "reorder" | "readChangesAfter">;
  readonly recorder: Pick<QueueRecorder, "follow">;
  /** Refuses a stream of a session this daemon does not hold. */
  readonly sessions: SessionDriverDeps;
  /** The streaming primitive every streaming handler shares, so disconnect cleanup is one map. */
  readonly streamingPrimitive: StreamingPrimitive;
  /** The outbound queues of the daemon's connections. */
  readonly outboundQueue: OutboundQueue;
}

/**
 * Binds `run.queueCreate`, `run.queueList`, `run.queueCancel`, `run.queueReorder` and
 * `run.subscribeQueue` onto the registry; a second binding on one registry throws.
 */
export function registerRunQueueMethods(registry: MethodRegistry, deps: RunQueueHandlerDeps): void {
  registerDescribedMethod(
    registry,
    RUN_CONTROL_METHOD_DESCRIPTORS["run.queueCreate"],
    async (request, ctx) => deps.queue.create(request, callingDeviceOf(ctx, "run.queueCreate")),
  );
  registerDescribedMethod(registry, RUN_CONTROL_METHOD_DESCRIPTORS["run.queueList"], (request) =>
    Promise.resolve(deps.queue.list(request)),
  );
  registerDescribedMethod(
    registry,
    RUN_CONTROL_METHOD_DESCRIPTORS["run.queueCancel"],
    async (request) => deps.queue.cancel(request),
  );
  registerDescribedMethod(
    registry,
    RUN_CONTROL_METHOD_DESCRIPTORS["run.queueReorder"],
    async (request) => deps.queue.reorder(request),
  );
  registerRunQueueSubscribe(registry, deps);
}

function registerRunQueueSubscribe(registry: MethodRegistry, deps: RunQueueHandlerDeps): void {
  const descriptor = RUN_CONTROL_METHOD_DESCRIPTORS["run.subscribeQueue"];
  const handler: Handler<RunQueueSubscribeRequest, SubscribeAckResponse> = async (
    request,
    context,
  ) => {
    if (context.transportId === undefined) {
      throw new Error(`${descriptor.method}: a subscription needs the transport it streams to`);
    }
    const transportId = context.transportId;
    const sessionId = canonicalizeUuid(request.sessionId);
    resolveDriverForSessionOrThrow(deps.sessions, sessionId);
    const subscription = deps.streamingPrimitive.createSubscription<RunQueueStreamFrame>(
      transportId,
      descriptor.emissionSchema,
    );
    const barrier = createSubscriptionAckBarrier(subscription, descriptor.method);
    const batcher = createStreamFrameBatcher<RunQueueStreamChange, EventCursor>(
      {
        emit: (frame) => {
          barrier.emit(frame);
        },
        isFull: () => deps.outboundQueue.isFull(transportId),
        onceDrained: (listener) => deps.outboundQueue.onceDrained(transportId, listener),
      },
      {
        isCatchingUp: request.afterCursor !== undefined,
        heldChangesMax: RUN_STREAM_HELD_CHANGES_MAX,
      },
    );
    subscription.onCancel(() => {
      batcher.stop();
    });
    if (request.afterCursor !== undefined) {
      for (const change of deps.queue.readChangesAfter(
        sessionId,
        request.childHandle,
        request.afterCursor,
      )) {
        batcher.add(change);
      }
      // The catch-up ends only once the connection has room, so none of its changes is dropped.
      let detachDrained: (() => void) | undefined;
      const endCatchUpWithRoom = (): void => {
        detachDrained = undefined;
        if (deps.outboundQueue.isFull(transportId)) {
          detachDrained = deps.outboundQueue.onceDrained(transportId, endCatchUpWithRoom);
          return;
        }
        batcher.endCatchUp();
      };
      endCatchUpWithRoom();
      subscription.onCancel(() => {
        detachDrained?.();
      });
    }
    subscription.onCancel(
      deps.recorder.follow(sessionId, request.childHandle, (change) => {
        batcher.add(change);
      }),
    );
    barrier.release();
    return { subscriptionId: subscription.subscriptionId };
  };
  registerDescribedSubscription(registry, descriptor, handler);
}
