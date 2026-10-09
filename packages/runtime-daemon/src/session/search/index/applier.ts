// Applies the outbox to the search index on the search thread. A run starts when the daemon's
// writes commit and applies batch after batch until the outbox holds nothing past what it read, so
// a settled message waits for no timer and no fuller batch. A write that commits during a run
// starts no second run; the run under way reads again before it ends.

import type { SearchIndex } from "@ai-sidekicks/search-index";

import type { OutboxReader } from "./outbox.js";

/** Applies outbox batches to one index, one run at a time. */
export class SearchIndexApplier {
  readonly #index: Pick<SearchIndex, "apply">;
  readonly #outbox: OutboxReader;
  readonly #onApplied: (lastOutboxId: number) => void;
  #lastReadId: number;
  // Where the rowid floor log stood when the index last matched the database; 0, the strictest,
  // until a run has caught up.
  #floorPosition = 0;
  #run: Promise<void> | undefined;
  #isReadAgainDue = false;
  #isStopped = false;

  /**
   * An applier past the outbox id the index's newest commit records. `onApplied` hears each
   * batch's last outbox id once its commit is durable.
   */
  constructor(
    index: Pick<SearchIndex, "apply" | "lastAppliedOutboxId">,
    outbox: OutboxReader,
    onApplied: (lastOutboxId: number) => void,
  ) {
    this.#index = index;
    this.#outbox = outbox;
    this.#onApplied = onApplied;
    this.#lastReadId = index.lastAppliedOutboxId();
  }

  /**
   * Applies every outbox row waiting; resolves once the outbox held nothing past the last batch at
   * its read. A call during a run joins it. Rejects with what a read or an apply threw.
   */
  applyWaiting(): Promise<void> {
    if (this.#isStopped) {
      return Promise.resolve();
    }
    if (this.#run !== undefined) {
      this.#isReadAgainDue = true;
      return this.#run;
    }
    const run = this.#applyUntilCaughtUp().finally(() => {
      this.#run = undefined;
    });
    this.#run = run;
    return run;
  }

  /**
   * Starts no further batch, and resolves once the batch under way has settled; its failure has
   * already rejected the run's callers.
   */
  async stop(): Promise<void> {
    this.#isStopped = true;
    await Promise.allSettled([this.#run]);
  }

  /**
   * Where the rowid floor log stood when the index last matched the database, so a search opened
   * now checks every floor logged since.
   */
  floorPosition(): number {
    return this.#floorPosition;
  }

  async #applyUntilCaughtUp(): Promise<void> {
    while (!this.#isStopped) {
      this.#isReadAgainDue = false;
      const { batch, floorPosition } = this.#outbox.read(this.#lastReadId);
      if (batch !== undefined) {
        await this.#index.apply(batch);
        this.#lastReadId = batch.lastOutboxId;
      }
      if (floorPosition !== undefined) {
        this.#floorPosition = floorPosition;
      }
      if (batch !== undefined) {
        this.#onApplied(batch.lastOutboxId);
      }
      if (floorPosition !== undefined && !this.#isReadAgainDue) {
        return;
      }
    }
  }
}
