// The sent-message history: ArrowUp and ArrowDown at the line's edge offsets recall this
// window's sent messages without destroying an unsent draft.

import { COMPOSER_HISTORY_RECALL_CAP, COMPOSER_RETAINED_ADDRESS_CAP } from "../composer-bounds.js";

/**
 * This user's sent messages, walkable and draft-guarded: the text typed before a walk is
 * stashed on the first recall and restored past the newest entry. Bounded at
 * `COMPOSER_HISTORY_RECALL_CAP`, renderer-local and never persisted, like drafts.
 */
export class SentMessageHistory {
  /** Newest first, so index 0 is the message most recently sent. */
  readonly #sentNewestFirst: string[] = [];
  /** `-1` while not walking; otherwise the index into the list above. */
  #recallIndex = -1;
  #stashedDraft = "";

  /**
   * Record one sent message and end any walk, since the walk's stashed draft was just sent.
   * Stored verbatim: a trimmed copy would drop the indentation the router preserves.
   */
  public recordSent(text: string): void {
    if (text.trim().length === 0) {
      return;
    }
    this.#sentNewestFirst.unshift(text);
    if (this.#sentNewestFirst.length > COMPOSER_HISTORY_RECALL_CAP) {
      this.#sentNewestFirst.length = COMPOSER_HISTORY_RECALL_CAP;
    }
    this.reset();
  }

  /**
   * Walk one message older, or `undefined` when there is none. `currentText` is stashed on
   * the first step only, so walking back and forward returns the person's own text.
   */
  public recallOlder(currentText: string): string | undefined {
    if (this.#recallIndex + 1 >= this.#sentNewestFirst.length) {
      return undefined;
    }
    if (this.#recallIndex === -1) {
      this.#stashedDraft = currentText;
    }
    this.#recallIndex += 1;
    return this.#sentNewestFirst[this.#recallIndex];
  }

  /** Walk one message newer, or back to the stashed draft; `undefined` when no walk is on. */
  public recallNewer(): string | undefined {
    if (this.#recallIndex < 0) {
      return undefined;
    }
    this.#recallIndex -= 1;
    if (this.#recallIndex < 0) {
      const stashed = this.#stashedDraft;
      this.#stashedDraft = "";
      return stashed;
    }
    return this.#sentNewestFirst[this.#recallIndex];
  }

  /** End the walk without changing what is in the line. */
  public reset(): void {
    this.#recallIndex = -1;
    this.#stashedDraft = "";
  }
}

/**
 * One recall history per composer address, so a walk never crosses a rebinding (the composer
 * is rebound, not remounted, between agents and sessions). A map rather than a reset keeps an
 * address's history when the person returns; retained addresses are capped and the least
 * recently addressed is evicted. Becoming current resets the walk, not the history.
 */
export class SentMessageHistories {
  /** Insertion order is the recency order the eviction reads. */
  readonly #byAddress = new Map<string, SentMessageHistory>();
  #currentAddress: string | undefined = undefined;

  /** The history for this address, made current. Idempotent for the current address. */
  public forAddress(address: string): SentMessageHistory {
    const existing = this.#byAddress.get(address);
    const history = existing ?? new SentMessageHistory();
    if (existing !== undefined) {
      // Re-inserted so the map's iteration order is the recency order eviction reads.
      this.#byAddress.delete(address);
    }
    this.#byAddress.set(address, history);
    if (this.#currentAddress !== address) {
      this.#currentAddress = address;
      history.reset();
    }
    this.#evictBeyondCap();
    return history;
  }

  /** Drop the least recently addressed histories past the retained-address cap. */
  #evictBeyondCap(): void {
    while (this.#byAddress.size > COMPOSER_RETAINED_ADDRESS_CAP) {
      const leastRecent = this.#byAddress.keys().next();
      if (leastRecent.done === true) {
        return;
      }
      this.#byAddress.delete(leastRecent.value);
    }
  }
}
