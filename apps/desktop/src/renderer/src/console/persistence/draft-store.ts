// Drafts: participant-authored text, held in this window's memory and nowhere else.
//
// `Spec-023 §Console Design (Meridian)` §Persistence on the renderer scheme:
// "Composer drafts are deliberately NOT persisted — they are participant-authored
// content, and the composer says so on first focus after a restart rather than
// silently losing them."
//
// This class is the whole implementation of that sentence, and it is deliberately
// NOT built on `UiStateStore`. It could not be: draft text is prose, so the write
// chokepoint's identifier-shaped rule refuses it by construction. That is the
// design working, not an obstacle to route around — the two classes are separate
// so that no future caller can reach a durable byte with a draft in hand.
//
// IT LIVES IN `persistence/` AND PERSISTS NOTHING, which is the point rather than a
// contradiction: this directory owns what the console does about durability, and
// what it does about drafts is refuse. A `Map` and a disclosure, no adapter, no
// import at all — the file imports nothing, and
// `test/console/architecture/draft-non-persistence.test.ts` asserts that it never
// starts, because acquiring an adapter here is the first move of persisting a
// draft. A durable copy would need the encrypted, PII-mapped storage `Spec-022`
// specifies for participant-authored content, which the renderer does not have; an
// IndexedDB copy would put a person's prose in an unencrypted origin-scoped
// database outside every erasure selector the corpus defines.
//
// The one durable thing a draft leaves behind is the DISCLOSURE. `restartNotice`
// is armed at construction and cleared the first time a composer is focused, so the
// participant is told once that unsent text does not survive a restart — which is
// what makes the non-persistence a stated property rather than a silent loss.

/** One composer's unsent text, keyed by the surface that owns the composer. */
export interface DraftEntry {
  readonly draftKey: string;
  readonly text: string;
  readonly updatedAt: number;
}

export interface DraftStoreOptions {
  /**
   * The reading the eviction order uses. A bare callback and NOT the console's
   * `ConsoleClock` seam, which every other class in this family now takes: taking
   * the seam would mean importing it, and this module is the one place in the
   * console that must import nothing at all — the drafts tripwire asserts exactly
   * that, because acquiring anything here is the first move of persisting a draft.
   * The cost is small (no timer is armed from this file, so there is nothing for
   * a frozen clock to count) and the guarantee it buys is the whole point.
   */
  readonly now?: () => number;
  /**
   * Whether the participant still needs telling that drafts do not survive a
   * restart. True for a real window; a test that does not care passes false.
   */
  readonly restartNoticePending?: boolean;
  /** Ceiling on live drafts. Oldest is evicted past it, so a long session is bounded. */
  readonly maximumDraftCount?: number;
}

/** The default ceiling: more composers than a person has open, and still bounded. */
export const MAXIMUM_LIVE_DRAFT_COUNT = 64;

export class DraftStore {
  readonly #draftsByKey = new Map<string, DraftEntry>();
  readonly #subscribersByKey = new Map<string, Set<(draft: DraftEntry | undefined) => void>>();
  readonly #now: () => number;
  readonly #maximumDraftCount: number;
  #restartNoticePending: boolean;

  public constructor(options: DraftStoreOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
    this.#restartNoticePending = options.restartNoticePending ?? true;
    this.#maximumDraftCount = options.maximumDraftCount ?? MAXIMUM_LIVE_DRAFT_COUNT;
  }

  /**
   * True until a composer has been focused once. The composer renders the notice
   * while this is true and calls `acknowledgeRestartNotice` when it shows it.
   */
  public get restartNoticePending(): boolean {
    return this.#restartNoticePending;
  }

  /** The sentence the composer shows. Fixed text; no participant content in it. */
  public get restartNoticeText(): string {
    return "Unsent text stays in this window and is not saved between restarts.";
  }

  public acknowledgeRestartNotice(): void {
    this.#restartNoticePending = false;
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

  public get liveDraftCount(): number {
    return this.#draftsByKey.size;
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
