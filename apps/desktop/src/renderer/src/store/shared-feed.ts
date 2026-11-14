// One state folded from a feed of the background service, shared by every reader while any reads:
// the feed opens with the first reader and closes with the last, after which a later reader opens
// it afresh and reads nothing from before. Each frame is folded into the held state, and readers
// wake only when the state moves. A reread closes the feed and opens it again while the state on
// screen stays until the fresh frames replace it, for a reader asking again after a failure or an
// act whose answer implies the state moved.

import type { Unsubscribe } from "#shared/preload-api.js";

/**
 * Open a feed, handing each frame on, until the handle releases it. The composition supplies it,
 * so `store/` stays below `services/`.
 */
export type Feed<Frame> = (onFrame: (frame: Frame) => void) => Unsubscribe;

/**
 * How a feed's frames move its state: where it starts, and the fold for one open of the feed,
 * built afresh at each open so it may keep what that open is still delivering.
 */
export interface FeedFold<Frame, State> {
  readonly initial: State;
  readonly open: () => (state: State, frame: Frame) => State;
}

/** One feed's folded state and its readers, with the feed open while any reader is. */
export class SharedFeed<Frame, State> {
  readonly #feed: Feed<Frame>;
  readonly #fold: FeedFold<Frame, State>;
  readonly #readers = new Set<() => void>();
  #state: State;
  #release: Unsubscribe | undefined;

  public constructor(feed: Feed<Frame>, fold: FeedFold<Frame, State>) {
    this.#feed = feed;
    this.#fold = fold;
    this.#state = fold.initial;
  }

  /** What readers see now: the fold's starting state until the feed moves it. */
  public get state(): State {
    return this.#state;
  }

  /** Read the feed until the handle releases it, waking `onChange` each time the state moves. */
  public watch(onChange: () => void): Unsubscribe {
    this.#readers.add(onChange);
    if (this.#readers.size === 1) {
      this.#open();
    }
    return () => {
      this.#readers.delete(onChange);
      if (this.#readers.size === 0) {
        this.#close();
        this.#state = this.#fold.initial;
      }
    };
  }

  /** Open the feed afresh while anyone reads it; the state stays until fresh frames move it. */
  public reread(): void {
    if (this.#release === undefined) {
      return;
    }
    this.#close();
    this.#open();
  }

  #open(): void {
    const fold = this.#fold.open();
    this.#release = this.#feed((frame) => {
      const next = fold(this.#state, frame);
      if (next === this.#state) {
        return;
      }
      this.#state = next;
      for (const onChange of [...this.#readers]) {
        onChange();
      }
    });
  }

  #close(): void {
    const release = this.#release;
    this.#release = undefined;
    release?.();
  }
}

/**
 * Every feed of one kind being read, each folded into one state its readers share. Keyed by the
 * feed, which the composition holds stable per window, so a superseded feed takes its state with
 * it.
 */
export class SharedFeeds<Frame, State> {
  readonly #fold: FeedFold<Frame, State>;
  readonly #heldByFeed = new WeakMap<Feed<Frame>, SharedFeed<Frame, State>>();

  public constructor(fold: FeedFold<Frame, State>) {
    this.#fold = fold;
  }

  /** Read `feed` until the handle releases it, waking `onChange` each time its state moves. */
  public watch(feed: Feed<Frame>, onChange: () => void): Unsubscribe {
    let held = this.#heldByFeed.get(feed);
    if (held === undefined) {
      held = new SharedFeed(feed, this.#fold);
      this.#heldByFeed.set(feed, held);
    }
    return held.watch(onChange);
  }

  /** What `feed`'s readers see now: the fold's starting state until it moves. */
  public stateOf(feed: Feed<Frame>): State {
    return this.#heldByFeed.get(feed)?.state ?? this.#fold.initial;
  }

  /** Open `feed` afresh while anyone reads it, so it delivers its state as it now stands. */
  public reread(feed: Feed<Frame>): void {
    this.#heldByFeed.get(feed)?.reread();
  }
}
