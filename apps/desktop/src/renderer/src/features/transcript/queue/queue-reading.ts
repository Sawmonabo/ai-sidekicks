// One session's queue reading: the feed every surface on it reads, the watchers it
// publishes to, and the scheduler that decides when to ask again.
//
// `queue-feed.ts` is the window's registry of these readings and the React door onto
// one. This module never opens a stream or names a method: the list and the tail are
// calls it is handed.
//
// The rows are a fold over what the daemon sends, kept by `QueueOrder`: this file has no
// sort of its own and keeps the order the daemon gave, and a canceled row stays in the
// feed. A surface that shows only the waiting rows filters at the point it renders.
//
// THE SNAPSHOT IS TAKEN BEHIND THE TAIL AND ONLY BEHIND IT. A list read with no stream
// up stops being true the moment it lands, so the tail is opened first and the open
// takes its own read.
//
// CLIENT MEMORY IS NEVER THE QUEUE OF RECORD. A cancel confirms the request; the row
// changes when the daemon says it did, on the snapshot or the tail. The cancel state is
// composed onto the feed, and both halves publish through `#publish`, so a watcher is
// never woken for one half of a frame the other has not reached.

import type { QueueItemSummary } from "@ai-sidekicks/contracts";

import {
  NO_TRIGGERING_EVENT_KINDS,
  type ReadTriggerTarget,
} from "@renderer/store/reads/read-triggers.js";
import { ReadScope } from "@renderer/lib/reads/read-scope.js";
import { RefreshScheduler, type RefreshReason } from "@renderer/lib/reads/refresh-scheduler.js";
import {
  QueueCancellations,
  type QueueCancelCall,
  type QueueCancellationState,
} from "./queue-cancellation.js";
import { QueueOrder } from "./queue-order.js";
import { consoleClockFor } from "@renderer/services/platform/hooks/useClock.js";
import { type ConsoleBridge } from "@renderer/services/platform/platform-bridge.js";

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
 * What the pane reads off the queue: what the daemon said, and what this client asked.
 *
 * `phase` is `reading` until the first snapshot lands, so an empty list before it is
 * never mistaken for an empty queue.
 */
export interface QueueFeed extends QueueCancellationState {
  readonly phase: "reading" | "read";
  /** Canonical order: the snapshot's, with live-only rows appended in arrival order. */
  readonly items: readonly QueueItemSummary[];
}

/**
 * One session's live queue reading, and everyone watching it.
 *
 * A class with private fields rather than a hook's state, because every surface in
 * the window asks the same question of the same session: the first watcher opens the
 * tail and takes the snapshot once, and a later one is handed the reading in hand.
 */
export class SessionQueueReading implements ReadTriggerTarget {
  /**
   * Nothing in the timeline says this list changed that its own tail did not.
   *
   * The tail carries every row change, so the empty set is a claim: this reading goes
   * stale when the window has been away or the connection was repaired, not because a
   * session event that describes a run was appended.
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
   * Whether this reading has been forgotten by the registry that held it.
   *
   * Terminal. A surface that captured the reading during a render and subscribed after
   * the last watcher left would otherwise revive it outside the registry, with a tail
   * of its own, and the next surface would mint a second reading for the same session.
   */
  #isRetired = false;
  #closeTail: (() => void) | undefined = undefined;
  #phase: QueueFeed["phase"] = "reading";
  #items: readonly QueueItemSummary[] = EMPTY_ITEMS;
  #feed: QueueFeed;

  /** The reading as it stands. One object for every watcher, stable between changes. */
  public snapshot = (): QueueFeed => this.#feed;

  public constructor(
    bridge: ConsoleBridge,
    sessionId: string,
    calls: QueueCalls,
    onIdle: () => void,
  ) {
    this.#sessionId = sessionId;
    this.#calls = calls;
    this.#onIdle = onIdle;
    this.#cancellations = new QueueCancellations(calls.cancel, () => {
      this.#publish();
    });
    this.#refresh = new RefreshScheduler({
      // The bridge's clock, resolved once per reading.
      clock: consoleClockFor(bridge),
      perform: () => this.#readSnapshot(),
    });
    this.#feed = this.#composeFeed();
  }

  /**
   * Ask for a fresh snapshot.
   *
   * The tail keeps rows current while it is up; this is what answers for the time it
   * was not. Coalesced by the scheduler, so the surfaces that mount together on one
   * session still cost one call.
   */
  public requestRead(reason: RefreshReason): void {
    if (reason === "subscribe" && this.#closeTail !== undefined) {
      // The open took the first read and the tail has kept the rows current since, so a
      // surface joining an open reading asks for nothing.
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
        // The last surface left. The stream closes and the reading is forgotten, so a
        // surface that mounts later reads afresh rather than being handed a list that
        // stopped being updated when nobody was watching it.
        this.#isRetired = true;
        this.#refresh.dispose();
        this.#readLine.abandon();
        this.#closeTail?.();
        this.#closeTail = undefined;
        this.#onIdle();
      }
    };
  }

  /** Open the tail once, then take the snapshot that goes behind it. */
  #openTail(): void {
    if (this.#closeTail !== undefined) {
      return;
    }
    this.#closeTail = this.#calls.tail(this.#sessionId, (item) => {
      this.#order.merge(item);
      this.#items = this.#order.items();
      this.#publish();
    });
    // Taken now rather than behind the scheduler's window: the tail is already up, and
    // the fold accounts for the rows it delivers before the snapshot lands.
    void this.#readSnapshot();
  }

  async #readSnapshot(): Promise<void> {
    if (this.#closeTail === undefined) {
      return;
    }
    const round = this.#readLine.openRound();
    const items = await this.#calls.list(this.#sessionId);
    // A superseded round and an abandoned line each seat nothing.
    round.settle(() => {
      this.#order.seat(items);
      this.#items = this.#order.items();
      this.#phase = "read";
      this.#publish();
    });
  }

  #composeFeed(): QueueFeed {
    return { ...this.#cancellations.state, phase: this.#phase, items: this.#items };
  }

  #publish(): void {
    this.#feed = this.#composeFeed();
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

const EMPTY_ITEMS: readonly QueueItemSummary[] = Object.freeze([]);
