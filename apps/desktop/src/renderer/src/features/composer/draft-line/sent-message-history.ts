// The sent-message history: ArrowUp and ArrowDown at the line's edge offsets recall this
// user's sent messages, guarded so that a walk never destroys an unsent draft.
//
// The recall is stateful, so it is a class with private fields.

import { COMPOSER_HISTORY_RECALL_CAP, COMPOSER_RETAINED_ADDRESS_CAP } from "../composer-bounds.js";

/**
 * This user's sent messages, walkable, draft-guarded.
 *
 * The guard is the whole design: the text a person had typed before they started
 * walking is STASHED on the first recall and restored when they walk back past the
 * newest entry. Without it, one ArrowUp on a half-written message destroys it and
 * there is nowhere to get it back from — the ledger holds what was sent, and this
 * was not sent.
 *
 * The list is bounded at `COMPOSER_HISTORY_RECALL_CAP` and holds only what this
 * window has seen this session. It is renderer-local and never persisted:
 * `store/draft-store.ts` states why user-authored text does not
 * reach durable storage, and a recall list is the same class of content.
 */
export class DirectiveHistory {
  /** Newest first, so index 0 is the message most recently sent. */
  readonly #sentNewestFirst: string[] = [];
  /** `-1` while not walking; otherwise the index into the list above. */
  #recallIndex = -1;
  #stashedDraft = "";

  /** True while a walk is in progress, so the surface can mark the line as recalled. */
  public get isRecalling(): boolean {
    return this.#recallIndex >= 0;
  }

  /** How many messages are walkable. Bounded by the cap; read by tests and the surface. */
  public get recallableCount(): number {
    return this.#sentNewestFirst.length;
  }

  /**
   * Record one sent message and end any walk in progress.
   *
   * Recording ends the walk because the walk's anchor — the stashed draft — has just
   * been sent. Keeping the index would leave a later ArrowDown restoring text that is
   * now in the ledger, which reads as the composer duplicating a message.
   *
   * What is recorded is the message VERBATIM. Trimming here would be a transform in
   * the one place it looks harmless: a recalled message is text a person sends
   * again, so a list that stored a trimmed copy would quietly reintroduce, one
   * ArrowUp later, exactly the loss of indentation the router refuses to perform.
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
   * Walk one message older, or `undefined` when there is nothing older to reach.
   *
   * `currentText` is stashed on the FIRST step only, so walking three messages back
   * and forward again returns the person's own unsent text rather than the message
   * they passed through on the way.
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

  /**
   * Walk one message newer, or back to the stashed draft.
   *
   * `undefined` means the walk was not in progress, so the arrow belongs to the
   * caret and not to this class.
   */
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
 * One recall history per composer address, so a walk never crosses a rebinding.
 *
 * The composer is rebound rather than remounted when a person moves between agents
 * and sessions, and a single history for the life of the mounted bar carried the
 * whole of one address's sent messages — and any walk in progress — into the next.
 * ArrowUp under the new target copied user-authored text written for the old
 * one into the line, and ArrowDown restored a draft stashed before the switch.
 *
 * A MAP RATHER THAN A RESET. Coming back to an address and finding its own history
 * intact is what a person expects; a reset on every rebinding would have destroyed
 * it to fix a leak between addresses. What a map costs is growth, so the retained
 * addresses are bounded and the least recently addressed is evicted — the histories
 * are per window and never persisted, and unbounded growth is a budget failure.
 *
 * THE CURSOR IS AT REST FOR AN ADDRESS THAT HAS JUST BECOME CURRENT. Walking is a
 * gesture within one line; a switch away and back cannot land mid-walk, so becoming
 * current resets the walk without touching what the address has sent.
 */
export class AddressedDirectiveHistories {
  /** Insertion order is the recency order the eviction reads. */
  readonly #byAddress = new Map<string, DirectiveHistory>();
  #currentAddress: string | undefined = undefined;

  /** How many addresses are retained. Bounded by the cap; read by tests. */
  public get retainedAddressCount(): number {
    return this.#byAddress.size;
  }

  /**
   * The history for this address, made current.
   *
   * Idempotent for an address that is already current, so a caller free to ask on
   * every render neither re-orders the map nor disturbs a walk in progress.
   */
  public forAddress(address: string): DirectiveHistory {
    const existing = this.#byAddress.get(address);
    const history = existing ?? new DirectiveHistory();
    if (existing !== undefined) {
      // Re-inserted so the map's own iteration order stays the recency order the
      // eviction below reads, rather than a separate list that could disagree.
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
