// `session.list`: the live sessions list. The acknowledgment carries the chats count and as many
// entries as fit one message; the rest of the list follows as `page` changes, each fitting one
// message, the last marked complete. Each change after that travels as the `value` of a
// `$/subscription/notify` frame keyed by the subscription id, and the client ends the stream with
// `$/subscription/cancel`.
//
// How the opening list goes out:
//   * One page per turn of the event loop, and only once the connection's outbound queue has room,
//     so a long list neither blocks the daemon nor piles up unsent.
//   * Ahead of every other change. The snapshot is taken and the listener added in one synchronous
//     step, so no change falls between them; a change that lands while pages remain waits, the
//     newest per session, and goes out after the last page.
//   * Never past a full queue. A change that finds the queue full, or others still waiting, waits
//     with them, the newest per session, so what waits is bounded by the list itself; they go out
//     oldest first as the queue drains. The list carries no drop mark, and an entry's newest state
//     is all a reader needs, so nothing is dropped.
//   * After the acknowledgment. Every frame goes through the subscribe-init barrier, which holds it
//     until the response naming its subscription has been written.
//
// The registration is not `mutating`, so a connection with an incompatible protocol version can
// still read.

import type { Handler, MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import {
  SESSION_DIRECTORY_METHOD_DESCRIPTORS,
  type SessionListAck,
  type SessionListChange,
  type SessionListEntry,
  type SessionListRequest,
} from "@ai-sidekicks/contracts/session/directory";
import { countEntriesFittingOneFrame } from "@ai-sidekicks/contracts/jsonrpc/page";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type {
  SessionListEntryChange,
  SessionListFeed,
  SessionListOpening,
} from "../../../session/directory/list-feed.js";
import { cancelAfterDetachedFailure, type StreamingPrimitive } from "../../streaming-primitive.js";
import { createSubscriptionAckBarrier } from "../../subscription-ack-barrier.js";
import type { OutboundQueue } from "./subscribe.js";

/** What `session.list`'s handler needs. */
export interface SessionListDeps {
  /** The streaming primitive every streaming handler shares, so disconnect cleanup is one map. */
  readonly streamingPrimitive: StreamingPrimitive;
  /** The outbound queues of the daemon's connections, which pace the opening list's pages. */
  readonly outboundQueue: OutboundQueue;
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
    const transportId = context.transportId;
    const pacer = new SessionListPacer({
      emit: (change) => {
        barrier.emit(change);
      },
      isFull: () => deps.outboundQueue.isFull(transportId),
      onceDrained: (listener) => deps.outboundQueue.onceDrained(transportId, listener),
    });
    subscription.onCancel(() => {
      pacer.stop();
    });
    let opening: SessionListOpening;
    try {
      opening = deps.listFeed.open({
        onChange: (change) => {
          pacer.route(change);
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
    const firstPage = pacer.takeOpeningList(opening.sessions, opening.chatCount);
    const isComplete = firstPage.length === opening.sessions.length;
    if (!isComplete) {
      barrier.deferUntilAck(() => {
        pacer.sendPages();
      });
    }
    barrier.release();
    return {
      subscriptionId: subscription.subscriptionId,
      sessions: firstPage,
      chatCount: opening.chatCount,
      isComplete,
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

/** Where a pacer sends changes and how it reads its connection's queue. */
interface ChangeOutlet {
  emit(change: SessionListChange): void;
  isFull(): boolean;
  onceDrained(listener: () => void): () => void;
}

/**
 * One subscription's list sent at its connection's pace: the opening list page by page, then each
 * change as the queue has room, with the changes that wait behind either.
 */
class SessionListPacer {
  readonly #outlet: ChangeOutlet;
  // Changes wait while the opening list's pages remain, the newest per session last.
  readonly #heldChanges = new Map<SessionId, SessionListEntryChange>();
  #isHolding = true;
  #sessions: readonly SessionListEntry[] = [];
  #chatCount = 0;
  #sentCount = 0;
  #pendingTurn: ReturnType<typeof setImmediate> | undefined;
  #detachDrained: (() => void) | undefined;
  #isStopped = false;

  constructor(outlet: ChangeOutlet) {
    this.#outlet = outlet;
  }

  /**
   * Sends `change`, or holds it while pages remain, other changes wait or the queue is full,
   * keeping only its session's newest.
   */
  route(change: SessionListEntryChange): void {
    if (!this.#isHolding && this.#heldChanges.size === 0 && !this.#outlet.isFull()) {
      this.#outlet.emit(change);
      return;
    }
    const sessionId = change.kind === "upsert" ? change.entry.sessionId : change.sessionId;
    this.#heldChanges.delete(sessionId);
    this.#heldChanges.set(sessionId, change);
    if (!this.#isHolding) {
      this.#waitForRoom();
    }
  }

  /** Takes the opening list and answers the entries the acknowledgment carries. */
  takeOpeningList(sessions: readonly SessionListEntry[], chatCount: number): SessionListEntry[] {
    this.#sessions = sessions;
    this.#chatCount = chatCount;
    this.#sentCount = countEntriesFittingOneFrame(sessions, sessions.length);
    this.#isHolding = this.#sentCount < sessions.length;
    return sessions.slice(0, this.#sentCount);
  }

  /** Sends the pages after the acknowledgment, then the changes that waited for them. */
  sendPages(): void {
    this.#pendingTurn = undefined;
    this.#detachDrained = undefined;
    if (this.#isStopped) return;
    const remaining = this.#sessions.slice(this.#sentCount);
    const count = countEntriesFittingOneFrame(remaining, remaining.length);
    const [firstEntry, ...laterEntries] = remaining.slice(0, count);
    // Pages go out only while entries remain, and a count over any entries is at least one.
    if (firstEntry === undefined) {
      throw new Error("A further page of the sessions list had no entries to send.");
    }
    this.#sentCount += count;
    const isComplete = this.#sentCount === this.#sessions.length;
    this.#outlet.emit({
      kind: "page",
      sessions: [firstEntry, ...laterEntries],
      chatCount: this.#chatCount,
      isComplete,
    });
    // A page the subscription's schema refused ends the subscription inside that emit.
    if (this.#isStopped) return;
    if (isComplete) {
      this.#isHolding = false;
      this.#sendHeld();
      return;
    }
    const sendNext = (): void => {
      this.sendPages();
    };
    if (this.#outlet.isFull()) {
      this.#detachDrained = this.#outlet.onceDrained(sendNext);
    } else {
      this.#pendingTurn = setImmediate(sendNext);
    }
  }

  // Sends the held changes, oldest first, while the queue has room; the rest wait for its drain.
  #sendHeld(): void {
    this.#detachDrained = undefined;
    for (const [sessionId, change] of this.#heldChanges) {
      if (this.#isStopped) return;
      if (this.#outlet.isFull()) {
        this.#waitForRoom();
        return;
      }
      this.#heldChanges.delete(sessionId);
      this.#outlet.emit(change);
    }
  }

  #waitForRoom(): void {
    this.#detachDrained ??= this.#outlet.onceDrained(() => {
      this.#sendHeld();
    });
  }

  /** Stops sending, for a subscription that ended. */
  stop(): void {
    this.#isStopped = true;
    this.#heldChanges.clear();
    if (this.#pendingTurn !== undefined) clearImmediate(this.#pendingTurn);
    this.#pendingTurn = undefined;
    this.#detachDrained?.();
    this.#detachDrained = undefined;
  }
}
