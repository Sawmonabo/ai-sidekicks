// Drafts: user-authored text, held in this window's memory and nowhere else.
//
// This class is deliberately not built on `UiStateStore`, whose write chokepoint refuses prose,
// so no caller can reach a durable byte with a draft in hand. It imports nothing and must stay
// that way: acquiring an adapter here is the first move of persisting a draft. A durable copy
// would need encrypted storage the renderer does not have, and an IndexedDB copy would put a
// person's prose in an unencrypted origin-scoped database outside every erasure selector.
//
// Eviction is disclosed. The live ceiling drops the least-recently-typed draft, so an eviction
// arms a notice keyed to the composer that lost the text, cleared when that composer is typed
// in again or acknowledges it. The armed keys carry the same ceiling as the drafts.

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
   * Required and supplied by the caller, whose home is `store/persistence-caps.ts`; a default
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
  /**
   * Composers whose text the ceiling dropped, in eviction order. A `Set`, because a key evicted
   * twice without being typed in between is one loss to disclose.
   */
  readonly #evictedKeys = new Set<string>();

  public constructor(options: DraftStoreOptions) {
    if (!Number.isInteger(options.maximumDraftCount) || options.maximumDraftCount < 1) {
      throw new RangeError(
        `DraftStore needs room for at least one draft, and was given ${String(options.maximumDraftCount)}.`,
      );
    }
    this.#now = options.now ?? (() => Date.now());
    this.#maximumDraftCount = options.maximumDraftCount;
  }

  /**
   * Whether this composer's unsent text was dropped to keep the window bounded. Cleared, sent
   * and evicted all notify subscribers with `undefined`, and only eviction is a loss the user
   * did not ask for, hence the separate notice.
   */
  public evictionNoticePendingFor(draftKey: string): boolean {
    return this.#evictedKeys.has(draftKey);
  }

  /** The sentence the composer shows. Fixed text; no user content in it. */
  public get evictionNoticeText(): string {
    return "Unsent text here was dropped to keep this window bounded, because other composers were used more recently.";
  }

  /** Stop showing the eviction notice for one composer. */
  public acknowledgeEvictionNotice(draftKey: string): void {
    this.#evictedKeys.delete(draftKey);
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
    // Typing here answers the notice: there is text again, so nothing is left to disclose.
    this.#evictedKeys.delete(draftKey);
    this.#draftsByKey.set(draftKey, { draftKey, text, updatedAt: this.#now() });
    this.#evictOldestBeyondCeiling();
    this.#notify(draftKey);
  }

  public clear(draftKey: string): void {
    // A clear is the user's own act (sending, or emptying the box), so it retires any notice on
    // this key.
    this.#evictedKeys.delete(draftKey);
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

  public get liveDraftCount(): number {
    return this.#draftsByKey.size;
  }

  /** Drop everything. The window is closing; nothing here outlives it anyway. */
  public dispose(): void {
    this.#draftsByKey.clear();
    this.#subscribersByKey.clear();
    this.#evictedKeys.clear();
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
      this.#armEvictionNotice(oldestKey);
      this.#notify(oldestKey);
    }
  }

  /**
   * Records one loss to disclose, under the same ceiling the drafts carry. Re-added rather than
   * left in place, so insertion order stays the eviction order and the oldest notice is the one
   * dropped when the bound bites.
   */
  #armEvictionNotice(draftKey: string): void {
    this.#evictedKeys.delete(draftKey);
    this.#evictedKeys.add(draftKey);
    while (this.#evictedKeys.size > this.#maximumDraftCount) {
      const oldestNotice = this.#evictedKeys.values().next();
      if (oldestNotice.done === true) {
        return;
      }
      this.#evictedKeys.delete(oldestNotice.value);
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
