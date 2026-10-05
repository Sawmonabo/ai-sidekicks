// One session's queue reading: the feed views read, its watchers, and the refresh scheduler.
// The list, tail and cancel are calls it is handed. The tail opens first and the snapshot is
// read behind it, since a list read with no stream up is stale on arrival. Rows change only
// when the daemon says so (a cancel only confirms the request); canceled rows stay in the feed.

import type { QueueItemSummary } from "@ai-sidekicks/contracts/run/queue";

import {
  NO_TRIGGERING_EVENT_KINDS,
  type ReadTriggerTarget,
} from "@renderer/store/reads/read-triggers.js";
import { ReadScope } from "@renderer/lib/reads/read-scope.js";
import {
  RefreshScheduler,
  type RefreshReason,
} from "@renderer/lib/reads/refresh/refresh-scheduler.js";
import {
  QueueCancellations,
  type QueueCancelCall,
  type QueueCancellationState,
} from "./queue-cancellation.js";
import { QueueOrder } from "./queue-order.js";
import { type Clock } from "@renderer/lib/clock.js";
import { coerceToRefusal } from "@renderer/lib/coerce-to-refusal.js";
import { type Refusal } from "@renderer/lib/refusal/refusal.js";
import {
  type WireReadPhase,
  type WireReadState,
} from "@renderer/services/wire-reads/read-lifecycle.js";

/**
 * Reads one session's whole queue at one moment, in the daemon's canonical order.
 */
export type QueueListCall = (sessionId: string) => Promise<readonly QueueItemSummary[]>;

/**
 * Opens one session's live queue stream, hands each row change to `onItem` already
 * parsed, and returns the function that closes it. Throws where the stream cannot open.
 */
export type QueueTailCall = (
  sessionId: string,
  onItem: (item: QueueItemSummary) => void,
) => () => void;

/** The three calls one queue reading makes. */
export interface QueueCalls {
  readonly list: QueueListCall;
  readonly tail: QueueTailCall;
  readonly cancel: QueueCancelCall;
}

/**
 * The queue as a view reads it. `phase` is `reading` until the first snapshot lands and
 * `refused` when the newest one failed, so an empty list is never mistaken for an empty queue.
 */
export interface QueueFeed extends QueueCancellationState, WireReadState {
  /** Canonical order: the snapshot's, with live-only rows appended in arrival order. */
  readonly items: readonly QueueItemSummary[];
}

/**
 * One session's live queue reading and everyone watching it. The first watcher opens the tail
 * and takes the snapshot once; a later one is handed the reading in hand.
 */
export class SessionQueueReading implements ReadTriggerTarget {
  /**
   * Empty: the tail carries every row change, so no session event makes this list stale. Only
   * the window returning or a repaired connection does.
   */
  public readonly triggeringEventKinds: ReadonlySet<string> = NO_TRIGGERING_EVENT_KINDS;
  readonly #sessionId: string;
  readonly #calls: QueueCalls;
  readonly #refresh: RefreshScheduler;
  readonly #cancellations: QueueCancellations;
  readonly #order = new QueueOrder();
  /** The line every snapshot read is on: a newer one supersedes the one it replaced. */
  readonly #readLine = new ReadScope();
  readonly #listeners = new Set<() => void>();
  readonly #onIdle: () => void;
  /**
   * Whether the registry has forgotten this reading. Terminal: watching a retired reading would
   * revive it outside the registry, and the next view would mint a second one for the session.
   */
  #isRetired = false;
  #closeTail: (() => void) | undefined = undefined;
  #phase: WireReadPhase = "reading";
  #readRefusal: Refusal | undefined = undefined;
  #items: readonly QueueItemSummary[] = EMPTY_ITEMS;
  #feed: QueueFeed;

  /** The reading as it stands. One object for every watcher, stable between changes. */
  public snapshot = (): QueueFeed => this.#feed;

  public constructor(clock: Clock, sessionId: string, calls: QueueCalls, onIdle: () => void) {
    this.#sessionId = sessionId;
    this.#calls = calls;
    this.#onIdle = onIdle;
    this.#cancellations = new QueueCancellations(calls.cancel, () => {
      this.#publish();
    });
    this.#refresh = new RefreshScheduler({
      clock,
      perform: () => this.#readSnapshot(),
    });
    this.#feed = this.#composeFeed();
  }

  /**
   * Ask for a fresh snapshot, coalesced by the scheduler so views that mount together on one
   * session cost one call. The tail keeps rows current while it is up; this covers the time it
   * was not.
   */
  public requestRead(reason: RefreshReason): void {
    if (reason === "subscribe" && this.#closeTail !== undefined) {
      // The open took the first read, so a view joining an open reading asks for nothing.
      return;
    }
    this.#refresh.request(reason);
  }

  /** Whether this reading has been retired. A retired one serves nobody again. */
  public get isRetired(): boolean {
    return this.#isRetired;
  }

  /** Watch the reading. The first watcher opens it; the last to leave closes it. */
  public watch(listener: () => void): () => void {
    if (this.#isRetired) {
      throw new Error("A retired queue reading was watched; ask the registry for a live one");
    }
    this.#openTail();
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) {
        // The last view left: close the stream and forget the reading, so a later view reads
        // afresh instead of being handed a list nobody kept current.
        this.#isRetired = true;
        this.#refresh.dispose();
        this.#readLine.abandon();
        this.#closeTail?.();
        this.#closeTail = undefined;
        this.#onIdle();
      }
    };
  }

  #openTail(): void {
    if (this.#closeTail !== undefined) {
      return;
    }
    this.#closeTail = this.#calls.tail(this.#sessionId, (item) => {
      this.#order.merge(item);
      this.#items = this.#order.items();
      this.#publish();
    });
    // Taken now rather than behind the scheduler's window: the tail is already up, and the
    // fold accounts for the rows it delivers before the snapshot lands.
    void this.#readSnapshot();
  }

  async #readSnapshot(): Promise<void> {
    if (this.#closeTail === undefined) {
      return;
    }
    const round = this.#readLine.openRound();
    let items: readonly QueueItemSummary[];
    try {
      items = await this.#calls.list(this.#sessionId);
    } catch (rejection) {
      // The rows already folded stay; only the read failed, and the view says so.
      round.settle(() => {
        this.#phase = "refused";
        this.#readRefusal = coerceToRefusal(rejection, QUEUE_LIST_ORIGIN);
        this.#publish();
      });
      return;
    }
    // A superseded round and an abandoned line each install nothing.
    round.settle(() => {
      this.#order.replaceWithSnapshot(items);
      this.#items = this.#order.items();
      this.#phase = "read";
      this.#readRefusal = undefined;
      this.#publish();
    });
  }

  #composeFeed(): QueueFeed {
    return {
      ...this.#cancellations.state,
      phase: this.#phase,
      readRefusal: this.#readRefusal,
      items: this.#items,
    };
  }

  #publish(): void {
    this.#feed = this.#composeFeed();
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

const EMPTY_ITEMS: readonly QueueItemSummary[] = Object.freeze([]);

/** Names the queue's snapshot read in a refusal, so a failure says which read failed. */
const QUEUE_LIST_ORIGIN = "queue-list";
