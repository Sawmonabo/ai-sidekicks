// The idle merge's stop: it waits for the merge step already at the writer, even once an event has
// set the idle timer going again meanwhile, and no step follows it.

import { describe, expect, it, vi } from "vitest";

import type { StatementResult } from "../../../database/statement.js";
import { SearchIndexIdleMerge } from "../idle-merge.js";

// A step's three results: the change count before, the merge, and the count after it merged.
const MERGED_STEP: StatementResult[] = [
  { rowCount: 1, rows: [{ total: 0 }] },
  { rowCount: 0, rows: [] },
  { rowCount: 1, rows: [{ total: 2 }] },
];

describe("SearchIndexIdleMerge", () => {
  it("stops once the step at the writer has finished, and writes no step after it", async () => {
    const step = Promise.withResolvers<StatementResult[]>();
    const write = vi.fn(() => step.promise);
    let onCommitted = (): void => {};
    const merge = new SearchIndexIdleMerge({
      writer: { write },
      followAll: (callback) => {
        onCommitted = callback;
        return () => {};
      },
      writeServiceLog: (line) => {
        throw new Error(`unexpected service log line: ${line}`);
      },
      idleAfterMs: 1,
    });
    merge.start();
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    // An event commits while the step runs, and the idle timer it sets going runs out.
    onCommitted();
    await new Promise((resolve) => setTimeout(resolve, 20));

    let isStopped = false;
    const stopped = merge.stop().then(() => {
      isStopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(isStopped).toBe(false);

    step.resolve(MERGED_STEP);
    await stopped;
    expect(isStopped).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
  });
});
