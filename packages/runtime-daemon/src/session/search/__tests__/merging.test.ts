// The index's merging: one merge at a time while the policy proposes one, the policy asked again
// after a commit that lands during a merge, and a failed merge tried again only after the
// daemon's retry wait, however many commits land meanwhile.

import { afterEach, describe, expect, it, vi } from "vitest";

import { retryWaitMs } from "../../../retry-waits.js";
import { SearchIndexMerging } from "../merging.js";

// An index whose merges each wait to be ended by the test, counting how many run at once.
class ScriptedIndex {
  readonly logLines: string[] = [];
  mergeCalls = 0;
  mostAtOnce = 0;
  #running = 0;
  #onCommitted: (() => void) | undefined;
  #endMerge: ((outcome: boolean | Error) => void) | undefined;

  readonly merging = new SearchIndexMerging({
    mergeSegments: () => {
      this.mergeCalls += 1;
      this.#running += 1;
      this.mostAtOnce = Math.max(this.mostAtOnce, this.#running);
      return new Promise<boolean>((resolve, reject) => {
        this.#endMerge = (outcome) => {
          this.#running -= 1;
          if (outcome instanceof Error) {
            reject(outcome);
          } else {
            resolve(outcome);
          }
        };
      });
    },
    followIndexCommits: (onCommitted) => {
      this.#onCommitted = onCommitted;
      return () => {
        this.#onCommitted = undefined;
      };
    },
    writeServiceLog: (line) => this.logLines.push(line),
  });

  commit(): void {
    this.#onCommitted?.();
  }

  async endMerge(outcome: boolean | Error): Promise<void> {
    this.#endMerge?.(outcome);
    // Lets the pass take the outcome and ask for its next merge.
    await vi.advanceTimersByTimeAsync(0);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SearchIndexMerging", () => {
  it("runs one merge at a time, asking again after a commit that lands during one", async () => {
    vi.useFakeTimers();
    const index = new ScriptedIndex();
    index.merging.start();
    index.commit();
    index.commit();
    await index.endMerge(true);
    index.commit();
    await index.endMerge(false);
    await index.endMerge(false);

    expect(index.mergeCalls).toBe(3);
    expect(index.mostAtOnce).toBe(1);
    await index.merging.stop();
  });

  it("tries a failed merge again after the retry wait, and no sooner for a commit", async () => {
    vi.useFakeTimers();
    const index = new ScriptedIndex();
    index.merging.start();
    await index.endMerge(new Error("disk full"));
    index.commit();
    await vi.advanceTimersByTimeAsync(retryWaitMs(0) - 1);
    expect(index.mergeCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(index.mergeCalls).toBe(2);
    expect(index.logLines).toEqual([expect.stringContaining("search_index_merge_failed")]);
    await index.endMerge(false);
    await index.merging.stop();
  });
});
