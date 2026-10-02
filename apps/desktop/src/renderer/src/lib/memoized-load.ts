// One asynchronous load shared by every caller, typically an `import()` of a lazily split chunk.
//
// The promise is memoized because `import()` of a module already loaded still returns a fresh
// promise that settles a turn later, and callers mounting together should share one fetch. A
// rejection is not memoized: a chunk fetch can fail transiently, and holding the rejection would
// hand every later caller a failure a second request would not reproduce. The memo is dropped
// before any caller sees the rejection, so a caller that retries on it reaches a live load.

/**
 * A load fetched once and shared until it fails. A class with private fields so a test or a
 * registry builds its own instance and no two share a memo.
 */
export class MemoizedLoad<TValue> {
  readonly #fetch: () => Promise<TValue>;
  readonly #onRelease: (() => void) | undefined;
  /** The one in-flight or fulfilled load; `undefined` until asked, and again after a rejection. */
  #pending: Promise<TValue> | undefined;

  /**
   * `fetch` starts one load. `onRelease`, when given, runs each time a rejected load drops the
   * memo, before any caller of that load sees the rejection.
   */
  public constructor(fetch: () => Promise<TValue>, onRelease?: () => void) {
    this.#fetch = fetch;
    this.#onRelease = onRelease;
  }

  /** True once a load has been asked for and has not rejected since. */
  public get isStarted(): boolean {
    return this.#pending !== undefined;
  }

  /** The value, fetched on the first ask; every later ask gets the same promise. */
  public load(): Promise<TValue> {
    this.#pending ??= this.#startLoad();
    return this.#pending;
  }

  /**
   * Starts one load and releases the memo if it rejects. The release is attached here, ahead of
   * every caller's own reaction, so it runs once and first; only the load that is still the memo
   * may clear it.
   */
  #startLoad(): Promise<TValue> {
    const pending = this.#fetch();
    void pending.catch(() => {
      if (this.#pending !== pending) {
        return;
      }
      this.#pending = undefined;
      this.#onRelease?.();
    });
    return pending;
  }
}
