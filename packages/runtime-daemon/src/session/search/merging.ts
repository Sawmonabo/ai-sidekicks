// Keeps the search index's segments merged. Each applied batch commits a new segment, and every
// search reads each one, so whenever the merge policy proposes a merge one runs: after each commit
// to the index and after each merge ends, as Tantivy's own segment updater considers merges, one
// at a time on the index's own thread, never on the main thread. A failed merge is logged and
// tried again after the daemon's retry waits; commits meanwhile start none.

import type { ServiceLogWriter } from "../../daemon/service-log.js";
import { retryWaitMs } from "../../retry-waits.js";
import { describeRejection } from "../../rejection.js";

/** What the index's merging needs from the daemon. */
export interface SearchIndexMergingDeps {
  /** Runs one merge of the index's segments; resolves whether more merging remains. */
  readonly mergeSegments: () => Promise<boolean>;
  /** Calls back on each durable commit of a batch to the index until the detach it returns runs. */
  readonly followIndexCommits: (onCommitted: () => void) => () => void;
  /** Where a failed merge is reported. */
  readonly writeServiceLog: ServiceLogWriter;
}

/** Merges the search index's segments whenever its merge policy proposes one; see the header. */
export class SearchIndexMerging {
  readonly #deps: SearchIndexMergingDeps;
  #detach: (() => void) | undefined;
  // Set by a commit that lands while a merge runs, so the pass checks the policy again after it.
  #hasCommittedSinceMerge = false;
  #failedPassesInRow = 0;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  // The pass under way, which a stop waits for.
  #pass: Promise<void> | undefined;

  constructor(deps: SearchIndexMergingDeps) {
    this.#deps = deps;
  }

  /** Starts following the index's commits, and merges what the index already proposes. */
  start(): void {
    this.#detach ??= this.#deps.followIndexCommits(() => {
      this.#considerMerging();
    });
    this.#considerMerging();
  }

  /**
   * Stops following and merging. A merge already under way finishes; the returned promise settles
   * once it has.
   */
  stop(): Promise<void> {
    this.#detach?.();
    this.#detach = undefined;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    return this.#pass ?? Promise.resolve();
  }

  #considerMerging(): void {
    if (this.#pass !== undefined) {
      this.#hasCommittedSinceMerge = true;
      return;
    }
    if (this.#retryTimer !== undefined || this.#detach === undefined) {
      return;
    }
    this.#pass = this.#runPass().finally(() => {
      this.#pass = undefined;
    });
  }

  async #runPass(): Promise<void> {
    try {
      let isMoreToMerge = true;
      while (isMoreToMerge && this.#detach !== undefined) {
        this.#hasCommittedSinceMerge = false;
        isMoreToMerge = (await this.#deps.mergeSegments()) || this.#hasCommittedSinceMerge;
      }
      this.#failedPassesInRow = 0;
    } catch (error) {
      const waitMs = retryWaitMs(this.#failedPassesInRow);
      this.#failedPassesInRow += 1;
      this.#deps.writeServiceLog(
        `search_index_merge_failed, retrying in ${String(waitMs)} ms: ` + describeRejection(error),
      );
      // Unref'd, so a retry still waiting never keeps the process alive.
      this.#retryTimer = setTimeout(() => {
        this.#retryTimer = undefined;
        this.#considerMerging();
      }, waitMs);
      this.#retryTimer.unref();
    }
  }
}
