// `run.subscribeState`: the state of every run in a session, the lead and each child, followed
// from the cursor a returning screen names, replaying what the log holds past it, or else from the
// session's newest event. It carries each run state change and each rollback the log records, and
// Codex's safety hold on a turn, which the log never records and which goes out at the session's
// newest cursor. Its changes are batched like every session stream; a screen that
// stops reading is dropped for past the run streams' held changes, and once its connection has
// room again it gets one frame with the drop mark and the newest cursor, and repairs from the
// daemon's record by cursor. Every frame goes out after the acknowledgment.

import type { EventEnvelope } from "@ai-sidekicks/contracts/event/envelope";
import type { Handler, MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import type { SubscribeAckResponse } from "@ai-sidekicks/contracts/jsonrpc/streaming";
import {
  RUN_CONTROL_METHOD_DESCRIPTORS,
  type RunStateStreamChange,
  type RunStateStreamEvent,
  type RunStateStreamFrame,
  type RunStateSubscribeRequest,
} from "@ai-sidekicks/contracts/run/control";
import type { RunSafetyBufferingUpdatedPayload } from "@ai-sidekicks/contracts/session/controls/events";
import type { EventCursor } from "@ai-sidekicks/contracts/session/event-cursor";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { canonicalizeUuid } from "@ai-sidekicks/contracts/uuid-canonical";

import type { SessionEventListener } from "../../../events/session/followers.js";
import type { RunStatePublisher } from "../../../provider/port/run-state-publisher.js";
import { readStoredRunStateChange } from "../../../session/run/stored-state-change.js";
import { parseStoredRollback } from "../../../session/run/superseded.js";
import {
  createStreamFrameBatcher,
  RUN_STREAM_HELD_CHANGES_MAX,
} from "../../stream-frame-batcher.js";
import { cancelAfterDetachedFailure, type StreamingPrimitive } from "../../streaming-primitive.js";
import { createSubscriptionAckBarrier } from "../../subscription-ack-barrier.js";
import { registerDescribedSubscription } from "../register-described-method.js";
import type { OutboundQueue } from "../session/subscribe.js";

const ROLLED_BACK_TYPE = "run.rolled_back";

type RunStateChangeListener = (change: RunStateStreamChange) => void;

/**
 * The live intake of Codex's safety holds, handed to each session's run state streams at the
 * session's newest cursor; a hold with no stream open on its session goes nowhere.
 */
export class RunSafetyHolds implements RunStatePublisher {
  readonly #readNewestCursor: (sessionId: SessionId) => EventCursor;
  // Each session's open streams; a session with none holds no entry.
  readonly #listeners = new Map<SessionId, Set<RunStateChangeListener>>();

  /** `readNewestCursor` reads the session's newest cursor, which a hold goes out at. */
  constructor(readNewestCursor: (sessionId: SessionId) => EventCursor) {
    this.#readNewestCursor = readNewestCursor;
  }

  /** Hands `hold` to every run state stream open on its session. */
  publish(hold: RunSafetyBufferingUpdatedPayload): void {
    const listeners = this.#listeners.get(canonicalizeUuid(hold.sessionId));
    if (listeners === undefined) {
      return;
    }
    const change: RunStateStreamChange = {
      cursor: this.#readNewestCursor(hold.sessionId),
      event: hold,
    };
    for (const listener of listeners) {
      listener(change);
    }
  }

  /** Hands the session's holds to `listener` until the returned detach runs. */
  follow(sessionId: SessionId, listener: RunStateChangeListener): () => void {
    const key = canonicalizeUuid(sessionId);
    const listeners = this.#listeners.get(key) ?? new Set<RunStateChangeListener>();
    this.#listeners.set(key, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && this.#listeners.get(key) === listeners) {
        this.#listeners.delete(key);
      }
    };
  }
}

/** What `run.subscribeState`'s handler needs. */
export interface RunStateSubscribeDeps {
  /** The streaming primitive every streaming handler shares, so disconnect cleanup is one map. */
  readonly streamingPrimitive: StreamingPrimitive;
  /** The outbound queues of the daemon's connections. */
  readonly outboundQueue: OutboundQueue;
  /** The session's newest cursor, which a stream named no cursor follows from. */
  readonly readNewestCursor: (sessionId: SessionId) => EventCursor;
  /**
   * Follows a session's events after `afterCursor` (`EventLogService.follow`), catching up at the
   * listener's pace and then live. Throws for a session the daemon does not hold.
   */
  readonly followSession: (
    sessionId: SessionId,
    afterCursor: EventCursor,
    listener: SessionEventListener,
  ) => () => void;
  readonly holds: Pick<RunSafetyHolds, "follow">;
}

/**
 * Registers `run.subscribeState` on `registry`. A call with no transport identity is a daemon
 * wiring fault and throws a plain `Error`; a session the log cannot follow is refused with nothing
 * left open, and a follow that fails later ends the subscription with its failure.
 */
export function registerRunStateSubscribe(
  registry: MethodRegistry,
  deps: RunStateSubscribeDeps,
): void {
  const descriptor = RUN_CONTROL_METHOD_DESCRIPTORS["run.subscribeState"];
  const handler: Handler<RunStateSubscribeRequest, SubscribeAckResponse> = async (
    request,
    context,
  ) => {
    if (context.transportId === undefined) {
      throw new Error(`${descriptor.method}: a subscription needs the transport it streams to`);
    }
    const transportId = context.transportId;
    const sessionId = canonicalizeUuid(request.sessionId);
    const subscription = deps.streamingPrimitive.createSubscription<RunStateStreamFrame>(
      transportId,
      descriptor.emissionSchema,
    );
    const barrier = createSubscriptionAckBarrier(subscription, descriptor.method);
    const isFull = (): boolean => deps.outboundQueue.isFull(transportId);
    const onceDrained = (listener: () => void): (() => void) =>
      deps.outboundQueue.onceDrained(transportId, listener);
    const batcher = createStreamFrameBatcher<RunStateStreamChange, EventCursor>(
      {
        emit: (frame) => {
          barrier.emit(frame);
        },
        isFull,
        onceDrained,
      },
      { isCatchingUp: true, heldChangesMax: RUN_STREAM_HELD_CHANGES_MAX },
    );
    subscription.onCancel(() => {
      batcher.stop();
    });
    try {
      const afterCursor = request.afterCursor ?? deps.readNewestCursor(sessionId);
      const detach = deps.followSession(sessionId, afterCursor, {
        onChange: ({ event, cursor }) => {
          const streamed = runStateStreamEventOf(event);
          if (streamed !== undefined) {
            batcher.add({ cursor, event: streamed });
          }
        },
        onCaughtUp: () => {
          batcher.endCatchUp();
        },
        onFailure: (error) => {
          // Ordered behind the acknowledgment, so the end frame never names an unknown id.
          barrier.deferUntilAck(() => {
            cancelAfterDetachedFailure(
              subscription,
              `[${descriptor.method}] the session's events stopped arriving for subscriptionId=` +
                `${subscription.subscriptionId}; subscription canceled`,
              error,
            );
          });
        },
        isFull,
        onceDrained,
      });
      subscription.onCancel(detach);
    } catch (error) {
      // The client never received this id, so the subscription goes without an end frame.
      deps.streamingPrimitive.cancelSubscription(subscription.subscriptionId);
      throw error;
    }
    subscription.onCancel(
      deps.holds.follow(sessionId, (change) => {
        batcher.add(change);
      }),
    );
    barrier.release();
    return { subscriptionId: subscription.subscriptionId };
  };
  registerDescribedSubscription(registry, descriptor, handler);
}

// What the stream carries for a stored event: a run's state change without its session, stamped
// with when it happened, or a rollback as stored; nothing for any other event.
function runStateStreamEventOf(event: EventEnvelope): RunStateStreamEvent | undefined {
  if (event.type === ROLLED_BACK_TYPE) {
    return parseStoredRollback(event.payload, event.sessionId, event.sequence);
  }
  const change = readStoredRunStateChange(event);
  if (change === undefined) {
    return undefined;
  }
  const { sessionId: _sessionId, ...transition } = change;
  return { ...transition, timestamp: event.occurredAt };
}
