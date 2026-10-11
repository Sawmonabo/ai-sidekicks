// One session's queue reading: the feed views read, its watchers, and the refresh scheduler.
// The list, tail, cancel and retry are calls it is handed. The tail opens first and the snapshot
// is read behind it, since a list read with no stream up is stale on arrival. Rows change only
// when the daemon says so (a cancel or retry only confirms the request); canceled and replaced
// rows stay in the feed.
// A frame marked dropped means the daemon left changes out, so the list is read again.

import type {
  QueueItemCreateRequest,
  QueueItemSummary,
  RunQueueStreamFrame,
} from "@ai-sidekicks/contracts/run/queue";

import {
  NO_TRIGGERING_EVENT_KINDS,
  type ReadTriggerTarget,
} from "#renderer/store/reads/triggers.js";
import { ReadScope } from "#renderer/lib/reads/scope.js";
import { RefreshScheduler, type RefreshReason } from "#renderer/lib/reads/refresh/scheduler.js";
import { PendingItemCalls, type QueueItemCall } from "./pending-calls.js";
import { QueueOrder } from "./order.js";
import { type Clock } from "#renderer/lib/clock.js";
import { coerceToRefusal } from "#renderer/lib/coerce-to-refusal.js";
import { readQueueItemCreateRequest } from "#renderer/services/daemon/wire/requests.js";
import { type ExtendedRefusal } from "#renderer/lib/refusal/extensions.js";
import { type WireReadPhase, type WireReadState } from "#renderer/lib/reads/wire-state.js";

/**
 * Reads one session's whole queue at one moment, in the daemon's canonical order.
 */
export type QueueListCall = (sessionId: string) => Promise<readonly QueueItemSummary[]>;

/**
 * Opens one session's live queue stream, hands each frame to `onFrame` already parsed, and
 * returns the function that closes it. Throws where the stream cannot open.
 */
export type QueueTailCall = (
  sessionId: string,
  onFrame: (frame: RunQueueStreamFrame) => void,
) => () => void;

/**
 * Sends a not-delivered message again through `run.queueCreate`, the request replacing it in its
 * own words. Rejects where the daemon refuses or cannot be reached.
 */
export type QueueRetryCall = (request: QueueItemCreateRequest) => Promise<void>;

/** The calls one queue reading makes. */
export interface QueueCalls {
  readonly list: QueueListCall;
  readonly tail: QueueTailCall;
  /** Cancels one waiting item before it is admitted. */
  readonly cancel: QueueItemCall;
  readonly retry: QueueRetryCall;
}

/**
 * The queue as a view reads it. `phase` is `reading` until the first snapshot lands and
 * `refused` when the newest one failed, so an empty list is never mistaken for an empty queue.
 */
export interface QueueFeed extends WireReadState {
  /** In queue order: each row's `position`, lowest first. */
  readonly items: readonly QueueItemSummary[];
  /** Items whose cancel is in flight, so the control disables rather than re-fires. */
  readonly pendingCancelIds: ReadonlySet<string>;
  /** Cancels one waiting item; a second ask while one is in flight does nothing. */
  readonly cancelItem: (queueItemId: string) => Promise<void>;
  /** Items whose retry is in flight. */
  readonly pendingRetryIds: ReadonlySet<string>;
  /** Sends one not-delivered item again; a second ask while one is in flight does nothing. */
  readonly retryItem: (queueItemId: string) => Promise<void>;
}

/**
 * One session's live queue reading and everyone watching it. The first watcher opens the tail
 * and takes the snapshot once; a later one is handed the reading in hand.
 */
export class SessionQueueReading implements ReadTriggerTarget {
  /**
   * Empty: the tail carries every row change, so no session event makes this list stale. Only
   * the window returning, a repaired connection or a dropped frame does.
   */
  public readonly triggeringEventKinds: ReadonlySet<string> = NO_TRIGGERING_EVENT_KINDS;
  readonly #sessionId: string;
  readonly #calls: QueueCalls;
  readonly #refresh: RefreshScheduler;
  readonly #cancels: PendingItemCalls;
  readonly #retries: PendingItemCalls;
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
  #readRefusal: ExtendedRefusal | undefined = undefined;
  #items: readonly QueueItemSummary[] = EMPTY_ITEMS;
  #feed: QueueFeed;

  /** The reading as it stands. One object for every watcher, stable between changes. */
  public snapshot = (): QueueFeed => this.#feed;

  public constructor(clock: Clock, sessionId: string, calls: QueueCalls, onIdle: () => void) {
    this.#sessionId = sessionId;
    this.#calls = calls;
    this.#onIdle = onIdle;
    const publish = (): void => {
      this.#publish();
    };
    this.#cancels = new PendingItemCalls(calls.cancel, publish);
    this.#retries = new PendingItemCalls((queueItemId) => this.#retry(queueItemId), publish);
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
    this.#closeTail = this.#calls.tail(this.#sessionId, (frame) => {
      if (frame.changes.length > 0) {
        for (const change of frame.changes) {
          this.#order.merge(change.item);
        }
        this.#items = this.#order.items();
        this.#publish();
      }
      if (frame.dropped === true) {
        // The changes that did not fit are gone from the stream; only a fresh list has them.
        this.#refresh.request("gap-repull");
      }
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

  // Replaces the row's item with its own words, keyed by its id, so a second press answers as the
  // first did.
  async #retry(queueItemId: string): Promise<void> {
    const item = this.#items.find((held) => held.id === queueItemId);
    const request =
      item === undefined
        ? undefined
        : readQueueItemCreateRequest({
            sessionId: this.#sessionId,
            clientIdempotencyKey: item.id,
            content: item.content,
            replacesQueueItemId: item.id,
          });
    if (request === undefined) {
      throw new Error(`Queue item ${queueItemId} could not be sent again from this queue`);
    }
    await this.#calls.retry(request);
  }

  #composeFeed(): QueueFeed {
    const cancels = this.#cancels.state;
    const retries = this.#retries.state;
    return {
      pendingCancelIds: cancels.pendingIds,
      cancelItem: cancels.ask,
      pendingRetryIds: retries.pendingIds,
      retryItem: retries.ask,
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
