// The sent-message history: ArrowUp and ArrowDown at the line's edge offsets recall this
// window's sent messages without destroying an unsent draft.

import { COMPOSER_HISTORY_RECALL_CAP } from "../bounds.js";

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
