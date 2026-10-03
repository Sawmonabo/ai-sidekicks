// Which value is live for which key, where the key is an object compared by identity: a window
// rebuilds its store or its bridge, and whatever was minted over the old one must not outlive it.
// The same key hands its value back; a different one disposes it and mints a successor. One
// holder per kind of value lives at module scope (window scope), so a revisit never mints a
// second owner of one record. `valueIfCurrent` mutates nothing and is what a render calls; only
// an effect or an event handler calls `acquire`, so a discarded render cannot dispose the
// committed tree's value.

/** What a holder needs of the value it owns: a way to end it once a different key supersedes it. */
export interface KeyBoundValue {
  /** Terminal. The value's key has been replaced and nothing more may reach it. */
  dispose(): void;
}

/**
 * Which value is live for which key, and the one disposal there is. A class with private fields,
 * because the rule above is an invariant over two fields moving together.
 */
export class KeyBoundHolder<TKey extends object, TValue extends KeyBoundValue> {
  readonly #mint: (key: TKey) => TValue;
  #key: TKey | undefined;
  #value: TValue | undefined;

  public constructor(mint: (key: TKey) => TValue) {
    this.#mint = mint;
  }

  /**
   * The live value for `key`, or `undefined` when this holder is on another key or has not been
   * asked yet. Pure, because a render body calls it and may run for a discarded pass.
   */
  public valueIfCurrent(key: TKey): TValue | undefined {
    return this.#key === key ? this.#value : undefined;
  }

  /**
   * The value for this key, minting one on the first ask and on a key change. Mutates, so only
   * effects and event handlers call it. Idempotent for one key, so strict mode's second effect
   * run does not supersede the first's value.
   */
  public acquire(key: TKey): TValue {
    const held = this.valueIfCurrent(key);
    if (held !== undefined) {
      return held;
    }
    // Only a different key supersedes: an unmounting component disposes nothing, so a remount
    // over the same key finds the value it left.
    this.#value?.dispose();
    const minted = this.#mint(key);
    this.#key = key;
    this.#value = minted;
    return minted;
  }
}
