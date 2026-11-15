// What a view over one session keeps for as long as the session's store lives, though the store
// cannot name it: a feature above the store mints the value the first time it asks, under a key of
// its own, and the store drops it with itself. So a view mounted again over the same store finds
// what it kept, and nothing of one store reaches another.

/** One kind of value a session's store holds for a view; one key per kind, minted once. */
export class HeldValueKey<TValue> {
  /** The value's type, carried only so a key of one kind is never read as another's. */
  declare public readonly valueType: TValue;
}

/** The values one session's store holds for the views over it, each under its own key. */
export class HeldValues {
  readonly #values = new Map<HeldValueKey<unknown>, unknown>();

  /** The value held under `key`, minted by `mint` on the first ask and kept from then on. */
  public valueOf<TValue>(key: HeldValueKey<TValue>, mint: () => TValue): TValue {
    if (!this.#values.has(key)) {
      this.#values.set(key, mint());
    }
    // Only `mint` of this key's own kind ever wrote under it.
    return this.#values.get(key) as TValue;
  }
}
