// Merges the full-text index into one tree while the daemon is idle. FTS5's automerge already
// merges a little inside each write, which keeps a write's cost bounded but leaves the index in
// several trees that every query reads. Once no event has committed for a while, this runs FTS5's
// `merge` command in bounded steps of a fixed page count, each its own write so any other write
// waits at most one step: the first step of a pass takes a negative count, which gathers every
// tree into one level as `optimize` does, and later steps a positive one, which finishes that
// merge even if a new tree lands meanwhile. An event that commits ends the pass at the next step.

import type { DatabaseWriter } from "../../database/writer.js";
import type { ServiceLogWriter } from "../../daemon/service-log.js";

// FTS5's own example size: roughly this many pages are written by one step.
const MERGE_PAGES_PER_STEP = 500;
// How long the log stays quiet before the daemon counts as idle.
const DEFAULT_IDLE_AFTER_MS = 60_000;

// A step reports whether it merged anything through the connection's total change count: a
// difference under two means the merge had nothing left to do.
const MERGE_STEP_SQL = `INSERT INTO session_search_index (session_search_index, rank)
  VALUES ('merge', @pages)`;
const TOTAL_CHANGES_SQL = "SELECT total_changes() AS total";

/** What the idle merge needs from the daemon. */
export interface SearchIndexIdleMergeDeps {
  readonly writer: Pick<DatabaseWriter, "write">;
  /** Calls back on every committed event until the detach it returns runs. */
  readonly followAll: (onCommitted: () => void) => () => void;
  /** Where a failed merge step is reported; the next idle pass tries again. */
  readonly writeServiceLog: ServiceLogWriter;
  /** How long without a committed event counts as idle. Defaults to one minute. */
  readonly idleAfterMs?: number;
}

/** Keeps the full-text index merged while the daemon is idle; see the file header. */
export class SearchIndexIdleMerge {
  readonly #deps: SearchIndexIdleMergeDeps;
  readonly #idleAfterMs: number;
  #detach: (() => void) | undefined;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  // Counts committed events, so a step can tell whether one arrived while it ran.
  #activity = 0;
  #isMergeStarted = false;
  #isStepRunning = false;

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

  /** Stops watching and merging; a step already at the writer finishes there. */
  stop(): void {
    this.#detach?.();
    this.#detach = undefined;
    clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
  }

  #armIdleTimer(): void {
    clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = undefined;
      void this.#runPass();
    }, this.#idleAfterMs);
    this.#idleTimer.unref();
  }

  async #runPass(): Promise<void> {
    if (this.#isStepRunning) {
      return;
    }
    this.#isStepRunning = true;
    try {
      const activityAtStart = this.#activity;
      while (this.#detach !== undefined && this.#activity === activityAtStart) {
        const pages = this.#isMergeStarted ? MERGE_PAGES_PER_STEP : -MERGE_PAGES_PER_STEP;
        this.#isMergeStarted = true;
        if (!(await this.#runStep(pages))) {
          this.#isMergeStarted = false;
          return;
        }
      }
    } catch (error) {
      this.#deps.writeServiceLog(
        `search_index_merge_failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.#isStepRunning = false;
    }
  }

  // Whether the step merged anything.
  async #runStep(pages: number): Promise<boolean> {
    const [before, , after] = await this.#deps.writer.write([
      { sql: TOTAL_CHANGES_SQL },
      { sql: MERGE_STEP_SQL, bindings: { pages } },
      { sql: TOTAL_CHANGES_SQL },
    ]);
    return readTotal(after) - readTotal(before) >= 2;
  }
}

function readTotal(result: { readonly rows: readonly unknown[] } | undefined): number {
  const row = result?.rows[0] as { readonly total: number } | undefined;
  if (row === undefined) {
    throw new Error("The total change count read back no row.");
  }
  return row.total;
}
