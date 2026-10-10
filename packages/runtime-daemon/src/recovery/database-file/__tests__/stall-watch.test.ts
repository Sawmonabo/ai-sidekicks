// The recovery's stall watch: it ends both shells once a window passes with no byte between them
// and no processor time used, never a shell that keeps using the processor, and a reading that
// fails is logged and read again after the next window, never counted as a stall.

import type { ChildProcess } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RecoveryStallWatch } from "../stall-watch.js";

const WINDOW_MS = 1_000;

// A shell whose kill is only recorded.
function standInShell(): ChildProcess {
  return { kill: vi.fn() } as unknown as ChildProcess;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the recovery's stall watch", () => {
  it("ends both shells once a window after a reading passes with no byte and no processor time", async () => {
    const shells = [standInShell(), standInShell()];
    const watch = new RecoveryStallWatch(shells, {
      windowMs: WINDOW_MS,
      readProcessorMs: () =>
        Promise.resolve(
          new Map([
            [1, 120],
            [2, 40],
          ]),
        ),
      writeServiceLog: () => {},
    });

    await vi.advanceTimersByTimeAsync(WINDOW_MS);
    expect(watch.isStalled).toBe(false);
    await vi.advanceTimersByTimeAsync(WINDOW_MS);

    expect(watch.isStalled).toBe(true);
    for (const shell of shells) {
      expect(shell.kill).toHaveBeenCalledWith("SIGKILL");
    }
  });

  it("keeps a shell that uses the processor while it passes no byte", async () => {
    const shells = [standInShell(), standInShell()];
    let processorMs = 0;
    const watch = new RecoveryStallWatch(shells, {
      windowMs: WINDOW_MS,
      readProcessorMs: () => {
        processorMs += 5;
        return Promise.resolve(
          new Map([
            [1, processorMs],
            [2, 40],
          ]),
        );
      },
      writeServiceLog: () => {},
    });

    await vi.advanceTimersByTimeAsync(WINDOW_MS * 10);

    expect(watch.isStalled).toBe(false);
    expect(shells[0]?.kill).not.toHaveBeenCalled();
    watch.end();
  });

  it("logs a failed reading and reads again after the next window", async () => {
    const shells = [standInShell(), standInShell()];
    const serviceLog: string[] = [];
    let readingCount = 0;
    const watch = new RecoveryStallWatch(shells, {
      windowMs: WINDOW_MS,
      readProcessorMs: () => {
        readingCount += 1;
        return readingCount === 1
          ? Promise.reject(new Error("The process table could not be read"))
          : Promise.resolve(new Map([[1, 120]]));
      },
      writeServiceLog: (line) => {
        serviceLog.push(line);
      },
    });

    await vi.advanceTimersByTimeAsync(WINDOW_MS * 2);
    expect(serviceLog).toStrictEqual([
      "The recovery's processor time could not be read, so its progress is read again after " +
        "the next window: The process table could not be read",
    ]);
    // The failed reading is no reading: the stall needs two that match.
    expect(watch.isStalled).toBe(false);
    await vi.advanceTimersByTimeAsync(WINDOW_MS);

    expect(watch.isStalled).toBe(true);
  });
});
