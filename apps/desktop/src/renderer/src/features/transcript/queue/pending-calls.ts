// A call on one queued item, such as a cancel or a retry, is a request, not part of the row fold: a
// row changes when the daemon reports it. This module only tracks which items have one in flight.

/**
 * Asks the daemon one thing of one queued item, a cancel or a retry. Rejects where the daemon
 * refuses or cannot be reached.
 */
export type QueueItemCall = (queueItemId: string) => Promise<void>;

/** What a view reads about one kind of call, and the control it asks one through. */
export interface PendingItemCallState {
  /** Items with this call in flight, so the control disables rather than re-fires. */
  readonly pendingIds: ReadonlySet<string>;
  /**
   * Ask for the call on one item. A second ask while one is in flight does nothing; a rejected
   * call rejects this promise and frees the item to be asked again.
   */
  readonly ask: (queueItemId: string) => Promise<void>;
}

/**
 * One reading's calls of one kind: what is in flight, and how one is asked for. It publishes
 * through a callback because the watchers belong to the enclosing reading; a second publication
 * path could render a call's settlement before the rows had caught up.
 */
export class PendingItemCalls {
  readonly #call: QueueItemCall;
  readonly #onChanged: () => void;
  #pendingIds: ReadonlySet<string> = EMPTY_IDS;

  #ask = async (queueItemId: string): Promise<void> => {
    if (this.#pendingIds.has(queueItemId)) {
      // Silent: a second press for a call already going is early, not a failure. Checked here and
      // not in the button because the disabled set publishes one render behind.
      return;
    }
    this.#pendingIds = withId(this.#pendingIds, queueItemId);
    this.#onChanged();
    try {
      await this.#call(queueItemId);
    } finally {
      this.#pendingIds = withoutId(this.#pendingIds, queueItemId);
      this.#onChanged();
    }
  };

  public constructor(call: QueueItemCall, onChanged: () => void) {
    this.#call = call;
    this.#onChanged = onChanged;
  }

  /** What is in flight and how one is asked for, as they stand. */
  public get state(): PendingItemCallState {
    return { pendingIds: this.#pendingIds, ask: this.#ask };
  }
}

const EMPTY_IDS: ReadonlySet<string> = new Set<string>();

function withId(held: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(held);
  next.add(id);
  return next;
}

function withoutId(held: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(held);
  next.delete(id);
  return next;
}
