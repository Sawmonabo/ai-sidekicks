// What the binding and the controller do beyond the reconcile. The reconcile effect keys on the
// row set and the two activity flags, so a window the cap refused while somebody read above the
// tail is re-asked only if a second effect calls for it. One group per dependency of that effect
// (reading mode, last prune outcome, pin), each checked by removal: dropping a dependency fails
// that group's first case with the window still over its cap. Rows measuring under a follower
// publish the estimates the rows above are laid out at, and under a reader never do. The binding
// is mounted as the real tree mounts it, over a box whose content is the virtualizer's own total;
// every module in the assertion path is the shipped one.

import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TRANSCRIPT_WINDOW_ROW_CAP } from "../caps.js";
import { SCROLL_TAIL_TOLERANCE_PX } from "#renderer/lib/scroll/geometry/publisher.js";
import { CALM, syntheticRows } from "../controller.test-support.js";
import { type PruneDeferralReason } from "../window-cap.js";
import {
  MOUNTED_ROW_COUNT,
  MOUNTED_ROW_ESTIMATE_PX,
  MOUNTED_VIEWPORT_HEIGHT_PX,
  attachRow,
  mountViewport,
  type MountedViewport,
} from "./useTranscriptViewport.test-support.js";

/**
 * Inside the tail tolerance, so the reader counts as at the tail, yet far enough that a glide
 * to the exact tail moves the offset and publishes a sample subscribers are woken for.
 */
const NEAR_TAIL_OFFSET_PX =
  MOUNTED_ROW_COUNT * MOUNTED_ROW_ESTIMATE_PX -
  MOUNTED_VIEWPORT_HEIGHT_PX -
  SCROLL_TAIL_TOLERANCE_PX / 2;
const OVER_CAP_ROW_COUNT = TRANSCRIPT_WINDOW_ROW_CAP + 40;

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

describe("the transcript viewport binding — a prune the window refused", () => {
  it("is re-asked when the reader returns to the tail, with no new rows", () => {
    // Above the tail first, so the log that arrives next meets a reading floor.
    const subject = mountViewport(0);
    expect(subject.binding.result.current.snapshot.reading.mode).toBe("reading");

    act(() => {
      subject.binding.rerender(syntheticRows(OVER_CAP_ROW_COUNT));
    });
    expect(subject.binding.result.current.snapshot.lastPrune?.deferredBecause).toBe(
      "reading-floor",
    );
    expect(subject.binding.result.current.snapshot.rows).toHaveLength(OVER_CAP_ROW_COUNT);

    // The return alone: no row arrives, no turn starts, no reveal drains.
    act(() => {
      subject.scrollContainer.moveTo(subject.tailOffsetPx());
    });

    expect(subject.binding.result.current.snapshot.reading.mode).toBe("following");
    expect(subject.binding.result.current.snapshot.rows).toHaveLength(TRANSCRIPT_WINDOW_ROW_CAP);
  });

  it("a re-render that changes nothing leaves the reader's window whole", () => {
    // Without this the second effect could re-ask on every render and take rows from a reader.
    const subject = mountViewport(0);
    const overCapRows = syntheticRows(OVER_CAP_ROW_COUNT);
    act(() => {
      subject.binding.rerender(overCapRows);
    });

    act(() => {
      subject.binding.rerender(overCapRows);
    });

    expect(subject.binding.result.current.snapshot.reading.mode).not.toBe("following");
    expect(subject.binding.result.current.snapshot.lastPrune?.deferredBecause).toBe(
      "reading-floor",
    );
    expect(subject.binding.result.current.snapshot.rows).toHaveLength(OVER_CAP_ROW_COUNT);
  });
});

describe("the transcript viewport binding — a prune the write itself refused", () => {
  it("takes the rows once the write that vetoed them has finished", () => {
    // The reader never leaves the tail and nothing is pinned, so the prune outcome's identity is
    // the only dependency that moves. The veto is raised and dropped inside one synchronous glide,
    // so reconciling under it needs a subscriber the glide wakes, as in
    // `features/transcript/viewport/controller.test.ts`; keying the retry on the refusal makes it
    // reachable.
    const subject = mountViewport(NEAR_TAIL_OFFSET_PX);
    const { controller } = subject;
    expect(subject.binding.result.current.snapshot.reading.mode).toBe("following");

    const overCapRows = syntheticRows(OVER_CAP_ROW_COUNT);
    let refusedUnderTheVeto: PruneDeferralReason | undefined;
    controller.scroll.subscribeToGeometry(() => {
      if (refusedUnderTheVeto !== undefined || !controller.scroll.vetoesPrune()) {
        return;
      }
      controller.reconcile({ rows: overCapRows, ...CALM });
      refusedUnderTheVeto = controller.snapshot().lastPrune?.deferredBecause;
    });

    act(() => {
      subject.binding.result.current.jumpToTail();
    });

    expect(refusedUnderTheVeto).toBe("scroll-write");
    expect(subject.binding.result.current.snapshot.reading.mode).toBe("following");
    expect(subject.binding.result.current.snapshot.rows).toHaveLength(TRANSCRIPT_WINDOW_ROW_CAP);
  });
});

describe("the transcript viewport binding — a prune a pin held back", () => {
  it("takes the rows when the pin lifts, with the reading mode unmoved", () => {
    // Lifting a pin moves neither the row set, the activity flags, nor the reading mode, so
    // the pin is the only dependency the effect can be re-asked on.
    const subject = mountViewport(NEAR_TAIL_OFFSET_PX);
    const { controller } = subject;
    act(() => {
      controller.anchor.pin("cursor-3");
    });
    act(() => {
      subject.binding.rerender(syntheticRows(OVER_CAP_ROW_COUNT));
    });
    expect(subject.binding.result.current.snapshot.lastPrune?.deferredBecause).toBe(
      "pinned-history",
    );
    expect(subject.binding.result.current.snapshot.rows).toHaveLength(OVER_CAP_ROW_COUNT);
    const pinnedReadingMode = subject.binding.result.current.snapshot.reading.mode;

    act(() => {
      controller.anchor.unpin();
    });

    expect(subject.binding.result.current.snapshot.reading.mode).toBe(pinnedReadingMode);
    expect(subject.binding.result.current.snapshot.rows).toHaveLength(TRANSCRIPT_WINDOW_ROW_CAP);
  });
});

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
