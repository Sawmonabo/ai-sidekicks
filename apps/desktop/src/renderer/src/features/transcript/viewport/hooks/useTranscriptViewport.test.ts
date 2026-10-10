// What the binding and the controller do beyond the reconcile: rows measuring under a follower
// publish the estimates the rows above are laid out at, and under a reader never do. The binding
// is mounted as the real tree mounts it, over a box whose content is the virtualizer's own total;
// every module in the assertion path is the shipped one.

import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MOUNTED_ROW_COUNT,
  MOUNTED_ROW_ESTIMATE_PX,
  attachRow,
  mountViewport,
  type MountedViewport,
} from "./useTranscriptViewport.test-support.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

/**
 * Three rows report their heights in one observer pass, and the microtask queued behind it runs.
 * Answers how often the estimates were published and the library re-laid out meanwhile.
 */
async function measureThreeRows(
  subject: MountedViewport,
  firstIndex: number,
): Promise<{ publications: number; relayouts: number }> {
  const rowElements = [0, 1, 2].map((offset) => attachRow(subject, firstIndex + offset));
  const publications = vi.spyOn(subject.controller.measurements, "publishEstimates");
  const relayouts = vi.spyOn(subject.virtualizer, "measure");
  await act(async () => {
    for (const [offset, element] of rowElements.entries()) {
      subject.resizeObserver.deliverFor(element, 150 + offset * 40);
    }
    await Promise.resolve();
  });
  return { publications: publications.mock.calls.length, relayouts: relayouts.mock.calls.length };
}

describe("the transcript viewport — estimates published from rows measuring", () => {
  it("publishes once after a follower's rows measure, and re-lays the rows above out once", async () => {
    // Rows above the screen otherwise keep their kind's seed for as long as nothing is appended,
    // and grow by the difference as the reader scrolls up to them.
    const subject = mountViewport("tail");
    expect(subject.binding.result.current.snapshot.reading.mode).toBe("following");

    const { publications, relayouts } = await measureThreeRows(subject, MOUNTED_ROW_COUNT - 3);

    expect(publications).toBe(1);
    expect(relayouts).toBe(1);
    // An unmeasured row is laid out at the median of the three: 150, 190 and 230.
    expect(subject.virtualizer.measurementsCache[0]?.size).toBe(190);
  });

  it("never publishes from a reader's rows measuring", async () => {
    // A moved estimate would shift every unmeasured row above the one being read.
    const subject = mountViewport(0);
    expect(subject.binding.result.current.snapshot.reading.mode).toBe("reading");

    const { publications, relayouts } = await measureThreeRows(subject, 0);

    expect(publications).toBe(0);
    expect(relayouts).toBe(0);
    expect(subject.virtualizer.measurementsCache[MOUNTED_ROW_COUNT - 1]?.size).toBe(
      MOUNTED_ROW_ESTIMATE_PX,
    );
  });
});
