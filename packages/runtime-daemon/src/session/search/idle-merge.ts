// Merges the search index's segments while the daemon is idle. Each applied batch commits a new
// segment, and every search reads each one. Once no event has committed for a while, this asks the
// index for one merge at a time, each run on the index's own thread, until none remains; an event
// that commits ends the pass after the merge under way.

import type { ServiceLogWriter } from "../../daemon/service-log.js";

// How long the log stays quiet before the daemon counts as idle.
const DEFAULT_IDLE_AFTER_MS = 60_000;

/** What the idle merge needs from the daemon. */
export interface SearchIndexIdleMergeDeps {
  /** Runs one merge of the index's segments; resolves whether more merging remains. */
  readonly mergeWhileIdle: () => Promise<boolean>;
  /** Calls back on every committed event until the detach it returns runs. */
  readonly followAll: (onCommitted: () => void) => () => void;
  /** Where a failed merge is reported; the next idle pass tries again. */
  readonly writeServiceLog: ServiceLogWriter;
  /** How long without a committed event counts as idle. Defaults to one minute. */
  readonly idleAfterMs?: number;
}

/** Keeps the search index merged while the daemon is idle; see the file header. */
export class SearchIndexIdleMerge {
  readonly #deps: SearchIndexIdleMergeDeps;
  readonly #idleAfterMs: number;
  #detach: (() => void) | undefined;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  // Counts committed events, so a pass can tell whether one arrived while a merge ran.
  #activity = 0;
  #isMerging = false;
  // The pass under way, which a stop waits for.
  #pass: Promise<void> | undefined;

  constructor(deps: SearchIndexIdleMergeDeps) {
    this.#deps = deps;
    this.#idleAfterMs = deps.idleAfterMs ?? DEFAULT_IDLE_AFTER_MS;
  }

  /** Starts watching the log; the first pass runs once the daemon has been idle. */
  start(): void {
    this.#detach ??= this.#deps.followAll(() => {
      this.#activity += 1;
      this.#armIdleTimer();
    });
    this.#armIdleTimer();
  }

  /**
   * Stops watching and merging. A merge already under way finishes; the returned promise settles
   * once it has.
   */
  stop(): Promise<void> {
    this.#detach?.();
    this.#detach = undefined;
    clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
    return this.#pass ?? Promise.resolve();
  }

  #armIdleTimer(): void {
    clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = undefined;
      // A pass already under way goes on, and stays the one a stop waits for.
      if (!this.#isMerging) {
        this.#pass = this.#runPass();
      }
    }, this.#idleAfterMs);
    this.#idleTimer.unref();
  }

  async #runPass(): Promise<void> {
    this.#isMerging = true;
    try {
      const activityAtStart = this.#activity;
      let isMoreToMerge = true;
      while (isMoreToMerge && this.#detach !== undefined && this.#activity === activityAtStart) {
        isMoreToMerge = await this.#deps.mergeWhileIdle();
      }
    } catch (error) {
      this.#deps.writeServiceLog(
        `search_index_merge_failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.#isMerging = false;
    }
  }
}
