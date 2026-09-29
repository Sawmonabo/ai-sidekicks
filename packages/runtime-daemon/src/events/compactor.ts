// The background compactor: the idle-time maintenance pass over the event log.
//
// It is lossless. It never rewrites a committed column of `session_events`, so
// every row a transcript draws stays byte-for-byte what was signed, and every
// row stays on the ordinary chain-and-signature check. Removing a session's
// content is the whole-session purge's job (`session-purge.ts`), which runs only
// when a person deletes the session.
//
// Its one job today is retiring wrapped session content keys that no sealed
// body uses any more. A key is left behind when the purge's own disposal did not
// complete, or when an append minted a key and then failed before sealing
// anything. The pass asks the durable question, which keys exist with no live
// content row, so nothing it misses is lost: the next pass finds the same keys.
//
// When `tick()` runs is the idle scheduler's decision; this module only guards
// against running twice at once or inside an append-lock hold.

import type { SessionContentKeyDisposer } from "./session-content-key-store.js";
import { isWithinSessionAppendLockHold } from "./session-append-lock.js";

/** What one {@link Compactor.tick} did. */
export interface CompactionPassResult {
  /** Wrapped session content keys the pass retired. */
  readonly contentKeysReclaimed: number;
  /**
   * Candidates the pass passed over because their own disposal failed. Counted
   * apart from {@link contentKeySweepFailure}: that one is the sweep not
   * running, this one is the sweep running and not reclaiming, which a bare
   * reclaim count of zero cannot tell from an idle, healthy pass.
   */
  readonly contentKeysSkipped: number;
  /**
   * Present iff the sweep itself failed. Nothing is lost by a failure: the next
   * pass derives the same candidates again.
   */
  readonly contentKeySweepFailure?: string | undefined;
}

/** Construction dependencies. */
export interface CompactorDeps {
  /** The store that retires wrapped content keys no sealed body references. */
  readonly contentKeyDisposer: SessionContentKeyDisposer;
}

export class Compactor {
  readonly #contentKeyDisposer: SessionContentKeyDisposer;

  // Re-entry guard for `tick()`; see its docblock.
  #running = false;

  constructor(deps: CompactorDeps) {
    this.#contentKeyDisposer = deps.contentKeyDisposer;
  }

  /**
   * Run one maintenance pass.
   *
   * Two guards, covering different shapes:
   *
   *   * SINGLE-FLIGHT (`#running`). A `tick()` entered while one is in flight
   *     returns an empty result at once, so two passes never race each other's
   *     reads.
   *   * NOT INSIDE A HOLD. A `tick()` invoked from inside a live
   *     `withSessionAppendLock` hold returns an empty result. The single-flight
   *     flag cannot cover it, since the nested tick is the first one. The sweep
   *     takes one hold per session, and the lock is reentrant per owner, so a
   *     sweep inside a hold on session S would acquire nothing for S.
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
