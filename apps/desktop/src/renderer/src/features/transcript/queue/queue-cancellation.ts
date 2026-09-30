// Cancel before admission. A cancel is a request, not part of the row fold: a row changes when
// the daemon reports it. This module only tracks which items have a cancel in flight.

/**
 * Asks the daemon to cancel one queued item before it is admitted. Rejects where the
 * daemon refuses or cannot be reached.
 */
export type QueueCancelCall = (queueItemId: string) => Promise<void>;

/** What a view reads about cancels, and the control it asks one through. */
export interface QueueCancellationState {
  /** Items whose cancel is in flight, so the control disables rather than re-fires. */
  readonly pendingCancelIds: ReadonlySet<string>;
  /**
   * Ask for one item's cancel. A second ask while one is in flight does nothing; a
   * rejected call rejects this promise and frees the item to be asked again.
   */
  readonly cancelItem: (queueItemId: string) => Promise<void>;
}

/**
 * One reading's cancels: what is in flight, and how one is asked for. It publishes through a
 * callback because the watchers belong to the enclosing reading; a second publication path could
 * render a cancel's settlement before the rows had caught up.
 */
export class QueueCancellations {
  readonly #cancel: QueueCancelCall;
  readonly #onChanged: () => void;
  #pendingCancelIds: ReadonlySet<string> = EMPTY_IDS;

  #cancelItem = async (queueItemId: string): Promise<void> => {
    if (this.#pendingCancelIds.has(queueItemId)) {
      // Silent: a second press for a cancel already going is early, not a failure. Checked here
      // and not in the button because the disabled set publishes one render behind.
      return;
    }
    this.#pendingCancelIds = withId(this.#pendingCancelIds, queueItemId);
    this.#onChanged();
    try {
      await this.#cancel(queueItemId);
    } finally {
      this.#pendingCancelIds = withoutId(this.#pendingCancelIds, queueItemId);
      this.#onChanged();
    }
  };

  public constructor(cancel: QueueCancelCall, onChanged: () => void) {
    this.#cancel = cancel;
    this.#onChanged = onChanged;
  }

  /** The two members a feed carries, as they stand. */
  public get state(): QueueCancellationState {
    return { pendingCancelIds: this.#pendingCancelIds, cancelItem: this.#cancelItem };
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
