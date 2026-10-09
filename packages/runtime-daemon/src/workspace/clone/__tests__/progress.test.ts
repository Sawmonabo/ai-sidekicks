// The clone card's update gate: however fast git reports, the card hears at most four updates a
// second, never two closer than a quarter second, and always the latest one last.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CLONE_UPDATE_INTERVAL_MS, GitProgressReader, LatestUpdateGate } from "../progress.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the clone card's update gate", () => {
  it("lets at most four updates a second through, the last one always arriving", () => {
    const sentAt: number[] = [];
    const sent: number[] = [];
    const gate = new LatestUpdateGate<number>(
      (update) => {
        sentAt.push(Date.now());
        sent.push(update);
      },
      () => Date.now(),
    );
    // Git's progress through a reader, a line every 5 ms for two seconds.
    const reader = new GitProgressReader((progress) => {
      gate.offer(progress.percent ?? -1);
    });
    for (let tick = 0; tick < 400; tick += 1) {
      reader.read(`Receiving objects: ${String(Math.floor(tick / 4))}% (${String(tick)}/400)\r`);
      vi.advanceTimersByTime(5);
    }
    vi.advanceTimersByTime(CLONE_UPDATE_INTERVAL_MS);

    for (let index = 1; index < sentAt.length; index += 1) {
      expect((sentAt[index] ?? 0) - (sentAt[index - 1] ?? 0)).toBeGreaterThanOrEqual(
        CLONE_UPDATE_INTERVAL_MS,
      );
    }
    for (const at of sentAt) {
      expect(sentAt.filter((other) => other >= at && other < at + 1000).length).toBeLessThan(5);
    }
    expect(sent.at(-1)).toBe(99);
  });
});
