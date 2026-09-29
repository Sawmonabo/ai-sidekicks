// Cancel-before-admission: the queue's one removal path, and what a view reads while
// it is in flight.
//
// A cancel is a MUTATION, not part of the fold over the daemon's rows. This module holds
// no rows: the call answering confirms the REQUEST, and the row changes state when the
// daemon says it did, on the snapshot or on the tail. What it does hold is which items
// have a cancel in flight, so a control disables rather than re-fires.

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
 * One reading's cancels: what is in flight, and how one is asked for.
 *
 * It publishes through a callback rather than holding listeners of its own. The
 * watchers belong to the reading this is part of: two publication paths for one
 * view would let a cancel's settlement render a frame the rows had not reached.
 */
export class QueueCancellations {
  readonly #cancel: QueueCancelCall;
  readonly #onChanged: () => void;
  #pendingCancelIds: ReadonlySet<string> = EMPTY_IDS;

  #cancelItem = async (queueItemId: string): Promise<void> => {
    if (this.#pendingCancelIds.has(queueItemId)) {
      // Silent: the person pressed Cancel for the cancel already going, and a failure
      // card would report a failure where they were only early. This is the chokepoint
      // and not the button, because the set the button disables from is published one
      // render behind, so two presses inside one frame both see a live control.
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
