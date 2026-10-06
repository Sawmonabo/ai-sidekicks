// Drafts: user-authored text, held in this window's memory and nowhere else.
//
// This class is deliberately not built on `UiStateStore`, whose write chokepoint refuses prose,
// so no caller can reach a durable byte with a draft in hand. It imports nothing and must stay
// that way: acquiring an adapter here is the first move of persisting a draft. A durable copy
// would need encrypted storage the renderer does not have, and an IndexedDB copy would put a
// person's prose in an unencrypted origin-scoped database outside every erasure selector.
//
// The live ceiling drops the least-recently-typed draft, and its subscribers hear `undefined`.

/** One composer's unsent text, keyed by the view that owns the composer. */
export interface DraftEntry {
  readonly draftKey: string;
  readonly text: string;
  readonly updatedAt: number;
}

/** How a draft store reads time and how many drafts it holds. */
export interface DraftStoreOptions {
  /**
   * The reading the eviction order uses. A bare callback rather than the console's `Clock`
   * seam, because this module must import nothing; no timer is armed here, so a frozen clock
   * has nothing to count.
   */
  readonly now?: () => number;
  /**
   * Ceiling on live drafts. Oldest is evicted past it, so a long session is bounded.
   *
   * Required and supplied by the caller, whose home is `store/persistence/caps.ts`; a default
   * here would be a second home for one number. At least one, checked at construction: zero
   * would evict every write's own entry, so no draft would ever stick.
   */
  readonly maximumDraftCount: number;
}

/** This window's unsent composer text, held in memory and never written anywhere. */
export class DraftStore {
  readonly #draftsByKey = new Map<string, DraftEntry>();
  readonly #subscribersByKey = new Map<string, Set<(draft: DraftEntry | undefined) => void>>();
  readonly #now: () => number;
  readonly #maximumDraftCount: number;

  public constructor(options: DraftStoreOptions) {
    if (!Number.isInteger(options.maximumDraftCount) || options.maximumDraftCount < 1) {
      throw new RangeError(
        `DraftStore needs room for at least one draft, and ` +
          `was given ${String(options.maximumDraftCount)}.`,
      );
    }
    this.#now = options.now ?? (() => Date.now());
    this.#maximumDraftCount = options.maximumDraftCount;
  }

  public read(draftKey: string): DraftEntry | undefined {
    return this.#draftsByKey.get(draftKey);
  }

  /** Set or clear one composer's text. Empty text removes the entry entirely. */
  public write(draftKey: string, text: string): void {
    if (text.length === 0) {
      this.clear(draftKey);
      return;
    }
    this.#draftsByKey.set(draftKey, { draftKey, text, updatedAt: this.#now() });
    this.#evictOldestBeyondCeiling();
    this.#notify(draftKey);
  }

  public clear(draftKey: string): void {
    if (this.#draftsByKey.delete(draftKey)) {
      this.#notify(draftKey);
    }
  }

  /** Per-composer subscription, so typing in one composer re-renders only that one. */
  public subscribe(
    draftKey: string,
    listener: (draft: DraftEntry | undefined) => void,
  ): () => void {
    let listeners = this.#subscribersByKey.get(draftKey);
    if (listeners === undefined) {
      listeners = new Set();
      this.#subscribersByKey.set(draftKey, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.#subscribersByKey.delete(draftKey);
      }
    };
  }

  /** Drop everything. The window is closing; nothing here outlives it anyway. */
  public dispose(): void {
    this.#draftsByKey.clear();
    this.#subscribersByKey.clear();
  }

  #evictOldestBeyondCeiling(): void {
    while (this.#draftsByKey.size > this.#maximumDraftCount) {
      let oldestKey: string | undefined;
      let oldestUpdatedAt = Number.POSITIVE_INFINITY;
      for (const entry of this.#draftsByKey.values()) {
        if (entry.updatedAt < oldestUpdatedAt) {
          oldestUpdatedAt = entry.updatedAt;
          oldestKey = entry.draftKey;
        }
      }
      if (oldestKey === undefined) {
        return;
      }
      this.#draftsByKey.delete(oldestKey);
      this.#notify(oldestKey);
    }
  }

  #notify(draftKey: string): void {
    const listeners = this.#subscribersByKey.get(draftKey);
    if (listeners === undefined) {
      return;
    }
    const draft = this.#draftsByKey.get(draftKey);
    for (const listener of listeners) {
      listener(draft);
    }
  }
}
