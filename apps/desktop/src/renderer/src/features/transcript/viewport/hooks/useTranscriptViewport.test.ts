// What the binding and the controller do beyond the reconcile: rows measuring under a follower
// publish the estimates the rows above are laid out at, and under a reader never do; the window
// reading keeps one reader for the controller's life. The binding is mounted as the real tree
// mounts it, over a box whose content is the virtualizer's own total; every module in the
// assertion path is the shipped one.

import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SCROLL_TAIL_TOLERANCE_PX } from "#renderer/lib/scroll/geometry/publisher.js";
import { syntheticRows } from "../controller.test-support.js";
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

  it("keeps a follower on the tail when the published estimates grow the rows above", async () => {
    // Re-laying the rows out clears the library's cache without its end anchor, so the content
    // grows under a still offset and nothing in the library brings the follower back.
    const subject = mountViewport("tail");

    await measureThreeRows(subject, MOUNTED_ROW_COUNT - 3);
    act(() => {
      vi.advanceTimersToNextFrame();
    });

    const distanceFromTailPx = subject.tailOffsetPx() - subject.scrollContainer.scrollTop;
    expect(distanceFromTailPx).toBeLessThanOrEqual(SCROLL_TAIL_TOLERANCE_PX);
    expect(subject.binding.result.current.snapshot.reading.mode).toBe("following");
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

describe("the transcript viewport — the window reading", () => {
  it("keeps one reader across new snapshots, and the reader reads the newest rows", () => {
    // The feed registers the reader once and holds it in its own render scope; a reader minted per
    // snapshot would hold that render's scope, so every window the feed derived stayed reachable.
    const subject = mountViewport("tail");
    const reader = subject.binding.result.current.readWindowDiagnostics;
    const firstSnapshot = subject.binding.result.current.snapshot;

    act(() => {
      subject.binding.rerender(syntheticRows(MOUNTED_ROW_COUNT + 5));
    });

    const newestSnapshot = subject.binding.result.current.snapshot;
    expect(newestSnapshot.rows.length).not.toBe(firstSnapshot.rows.length);
    expect(subject.binding.result.current.readWindowDiagnostics).toBe(reader);
    expect(reader().indexableRowCount).toBe(newestSnapshot.rows.length);
  });
});

describe("the transcript viewport — rows the window replaces", () => {
  it("lays each row out under its own key when the head goes and the tail grows by as many", () => {
    // The library rebuilds its layout only when the row count or the key function moves. Under
    // its old keys, its direct writes would place each drawn row at another row's start.
    const subject = mountViewport(0);
    expect(subject.binding.result.current.snapshot.reading.mode).toBe("reading");

    act(() => {
      subject.binding.rerender(syntheticRows(MOUNTED_ROW_COUNT + 3).slice(3));
    });

    const keys = subject.binding.result.current.snapshot.keyProjection.virtualKeys;
    expect(keys).toHaveLength(MOUNTED_ROW_COUNT);
    const laidOut = subject.virtualizer.measurementsCache;
    expect(laidOut.map((item) => item.key)).toEqual(keys);
    // The adapter places a row by looking its element up under the key the layout holds.
    const rowElements = [0, 1, 2].map((index) => attachRow(subject, index));
    for (const [index, element] of rowElements.entries()) {
      expect(subject.virtualizer.elementsCache.get(laidOut[index]?.key ?? "")).toBe(element);
    }
  });
});
