// The background compactor: the idle-time maintenance pass over the event log.
//
// It is lossless: it never rewrites a committed column of `session_events`. Removing a
// session's content is the whole-session purge's job (`session-purge.ts`).
//
// Its one job is retiring wrapped session content keys that no sealed body uses. A key is
// left behind when a purge's own disposal did not complete, or when an append minted a key
// and then failed before sealing anything. The sweep asks which keys have no live content
// row, so a key it misses is found again by the next pass.
//
// The caller decides when `tick()` runs; this module only refuses to run twice at once or
// inside an append-lock hold.

import type { SessionContentKeyDisposer } from "./session-content-key-store.js";
import { isWithinSessionAppendLockHold } from "./session-append-lock.js";

/** What one {@link Compactor.tick} did. */
export interface CompactionPassResult {
  /** Wrapped session content keys the pass retired. */
  readonly contentKeysReclaimed: number;
  /**
   * Candidates whose own disposal failed. Counted apart from
   * {@link contentKeySweepFailure} so a zero reclaim count can be told from a healthy idle pass.
   */
  readonly contentKeysSkipped: number;
  /** Present iff the sweep itself failed; the next pass derives the same candidates again. */
  readonly contentKeySweepFailure?: string | undefined;
}

/** Construction dependencies. */
export interface CompactorDeps {
  /** The store that retires wrapped content keys no sealed body references. */
  readonly contentKeyDisposer: SessionContentKeyDisposer;
}

/** Runs the maintenance pass over the event log; see the module header. */
export class Compactor {
  readonly #contentKeyDisposer: SessionContentKeyDisposer;

  // Single-flight guard for `tick()`.
  #running = false;

  constructor(deps: CompactorDeps) {
    this.#contentKeyDisposer = deps.contentKeyDisposer;
  }

  /**
   * Runs one maintenance pass. Returns an empty result at once when another `tick()` is in
   * flight, or when called inside a `withSessionAppendLock` hold: the lock is reentrant per
   * owner, so a sweep inside a hold on session S would acquire nothing for S.
   */
  async tick(): Promise<CompactionPassResult> {
    if (this.#running || isWithinSessionAppendLockHold()) {
      return { contentKeysReclaimed: 0, contentKeysSkipped: 0 };
    }
    this.#running = true;
    try {
      return await this.#sweepUnreferencedContentKeys();
    } finally {
      this.#running = false;
    }
  }

  async #sweepUnreferencedContentKeys(): Promise<CompactionPassResult> {
    try {
      const sweep = await this.#contentKeyDisposer.sweepUnreferenced();
      return { contentKeysReclaimed: sweep.reclaimed, contentKeysSkipped: sweep.skipped };
    } catch (error) {
      return {
        contentKeysReclaimed: 0,
        contentKeysSkipped: 0,
        contentKeySweepFailure: `session content-key sweep failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }
}
