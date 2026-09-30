// What the React binding asks the controller for beyond the reconcile. The reconcile effect
// keys on the row set and the two activity flags, so a window the cap refused while somebody
// read above the tail is re-asked only if a second effect calls for it. One group per
// dependency of that effect (reading mode, last prune outcome, pin), each checked by removal:
// dropping a dependency fails that group's first case with the window still over its cap.
// The layout engine is stubbed as in `TranscriptViewport.test.tsx`, since a viewport with no
// box is at its tail by construction; every module in the assertion path is the shipped one.

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TRANSCRIPT_WINDOW_ROW_CAP } from "../../frame/frame-caps.js";
import { ManualClock } from "@renderer/lib/clock.js";
import { TRANSCRIPT_TAIL_TOLERANCE_PX } from "../viewport-constants.js";
import { useTranscriptViewport, type TranscriptViewportBinding } from "./useTranscriptViewport.js";
import { ViewportController } from "../viewport-controller.js";
import type { ViewportRow } from "../viewport-snapshot.js";
import { type PruneDeferralReason } from "../window-cap.js";

const VIEWPORT_HEIGHT_PX = 400;
const CONTENT_HEIGHT_PX = 10_000;
const TAIL_OFFSET_PX = CONTENT_HEIGHT_PX - VIEWPORT_HEIGHT_PX;
/**
 * Inside the tail tolerance, so the reader counts as at the tail, yet far enough that a glide
 * to the exact tail moves the offset and publishes a sample subscribers are woken for.
 */
const NEAR_TAIL_OFFSET_PX = TAIL_OFFSET_PX - TRANSCRIPT_TAIL_TOLERANCE_PX / 2;
const SETTLED_ROW_COUNT = 20;
const OVER_CAP_ROW_COUNT = TRANSCRIPT_WINDOW_ROW_CAP + 40;
const CALM = { hasActiveTurn: false, isRevealDraining: false } as const;

function syntheticRows(count: number): readonly ViewportRow[] {
  return Array.from({ length: count }, (_unused, index) => ({
    key: `row-${String(index)}`,
    parentKey: undefined,
    rootCursor: `cursor-${String(index)}`,
  }));
}

function withLaidOutViewport(): void {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(VIEWPORT_HEIGHT_PX);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(CONTENT_HEIGHT_PX);
}

/**
 * A mounted binding over a scroll container a case can scroll, and the controller it minted.
 * The controller is recorded, not replaced: `vi.spyOn` keeps the real `attach` and remembers
 * only its receiver, needed because the hook mints the controller itself and one case must
 * reach its geometry subscription to reconcile while a write is in flight.
 */
function mountBinding(
  rows: readonly ViewportRow[],
  initialScrollTopPx = 0,
): {
  binding: ReturnType<typeof renderHook<TranscriptViewportBinding, readonly ViewportRow[]>>;
  scrollContainer: HTMLElement;
  controller: ViewportController;
} {
  const attachedControllers = vi.spyOn(ViewportController.prototype, "attach");
  const clock = new ManualClock();
  const binding = renderHook(
    (currentRows: readonly ViewportRow[]) =>
      useTranscriptViewport({ clock, rows: currentRows, ...CALM }),
    { initialProps: rows },
  );
  const scrollContainer = document.createElement("div");
  scrollContainer.scrollTop = initialScrollTopPx;
  act(() => {
    binding.result.current.attachScrollContainer(scrollContainer);
  });
  const [controller] = attachedControllers.mock.contexts;
  if (!(controller instanceof ViewportController)) {
    throw new Error("the binding attached no viewport controller");
  }
  return { binding, scrollContainer, controller };
}

function scrollTo(scrollContainer: HTMLElement, offsetPx: number): void {
  act(() => {
    scrollContainer.scrollTop = offsetPx;
    scrollContainer.dispatchEvent(new Event("scroll"));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the transcript viewport binding — a prune the window refused", () => {
  it("is re-asked when the reader returns to the tail, with no new rows", () => {
    withLaidOutViewport();
    const { binding, scrollContainer } = mountBinding(syntheticRows(SETTLED_ROW_COUNT));
    // Above the tail first, so the log that arrives next meets a reading floor.
    scrollTo(scrollContainer, 0);
    expect(binding.result.current.snapshot.reading.mode).toBe("reading");

    act(() => {
      binding.rerender(syntheticRows(OVER_CAP_ROW_COUNT));
    });
    expect(binding.result.current.snapshot.lastPrune?.deferredBecause).toBe("reading-floor");
    expect(binding.result.current.snapshot.rows).toHaveLength(OVER_CAP_ROW_COUNT);

    // The return alone: no row arrives, no turn starts, no reveal drains.
    scrollTo(scrollContainer, TAIL_OFFSET_PX);

    expect(binding.result.current.snapshot.reading.mode).toBe("following");
    expect(binding.result.current.snapshot.rows).toHaveLength(TRANSCRIPT_WINDOW_ROW_CAP);
  });

  it("negative control: a re-render that changes nothing leaves the reader's window whole", () => {
    // Without this the second effect could re-ask on every render and take rows from a reader.
    withLaidOutViewport();
    const { binding, scrollContainer } = mountBinding(syntheticRows(SETTLED_ROW_COUNT));
    scrollTo(scrollContainer, 0);
    const overCapRows = syntheticRows(OVER_CAP_ROW_COUNT);
    act(() => {
      binding.rerender(overCapRows);
    });

    act(() => {
      binding.rerender(overCapRows);
    });

    expect(binding.result.current.snapshot.reading.mode).not.toBe("following");
    expect(binding.result.current.snapshot.lastPrune?.deferredBecause).toBe("reading-floor");
    expect(binding.result.current.snapshot.rows).toHaveLength(OVER_CAP_ROW_COUNT);
  });
});

describe("the transcript viewport binding — a prune the write itself refused", () => {
  it("takes the rows once the write that vetoed them has finished", () => {
    // The reader never leaves the tail and nothing is pinned, so the prune outcome's identity
    // is the only dependency that moves. The veto is raised and dropped inside one synchronous
    // glide, so reconciling under it needs a subscriber the glide wakes, as in
    // `viewport-controller.test.ts`; keying the retry on the refusal makes it reachable.
    withLaidOutViewport();
    const { binding, controller } = mountBinding(
      syntheticRows(SETTLED_ROW_COUNT),
      NEAR_TAIL_OFFSET_PX,
    );
    expect(binding.result.current.snapshot.reading.mode).toBe("following");

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
      binding.result.current.jumpToTail();
    });

    expect(refusedUnderTheVeto).toBe("scroll-write");
    expect(binding.result.current.snapshot.reading.mode).toBe("following");
    expect(binding.result.current.snapshot.rows).toHaveLength(TRANSCRIPT_WINDOW_ROW_CAP);
  });

  it("negative control: a glide that refuses nothing re-asks for no prune", () => {
    // Without this the case above would pass for a binding that pruned on any notification.
    withLaidOutViewport();
    const { binding, controller } = mountBinding(
      syntheticRows(SETTLED_ROW_COUNT),
      NEAR_TAIL_OFFSET_PX,
    );
    const settledOutcome = binding.result.current.snapshot.lastPrune;
    expect(settledOutcome?.deferredBecause).toBe("under-cap");

    act(() => {
      binding.result.current.jumpToTail();
    });

    // The glide published a sample but no reconcile ran, so the outcome is the same object.
    expect(controller.scroll.writeCount("jump-to-tail")).toBe(1);
    expect(binding.result.current.snapshot.lastPrune).toBe(settledOutcome);
    expect(binding.result.current.snapshot.rows).toHaveLength(SETTLED_ROW_COUNT);
  });
});

describe("the transcript viewport binding — a prune a pin held back", () => {
  it("takes the rows when the pin lifts, with the reading mode unmoved", () => {
    // Lifting a pin moves neither the row set, the activity flags, nor the reading mode, so
    // the pin is the only dependency the effect can be re-asked on.
    withLaidOutViewport();
    const { binding, controller } = mountBinding(
      syntheticRows(SETTLED_ROW_COUNT),
      NEAR_TAIL_OFFSET_PX,
    );
    act(() => {
      controller.anchor.pin("cursor-3");
    });
    act(() => {
      binding.rerender(syntheticRows(OVER_CAP_ROW_COUNT));
    });
    expect(binding.result.current.snapshot.lastPrune?.deferredBecause).toBe("pinned-history");
    expect(binding.result.current.snapshot.rows).toHaveLength(OVER_CAP_ROW_COUNT);
    const pinnedReadingMode = binding.result.current.snapshot.reading.mode;

    act(() => {
      controller.anchor.unpin();
    });

    expect(binding.result.current.snapshot.reading.mode).toBe(pinnedReadingMode);
    expect(binding.result.current.snapshot.rows).toHaveLength(TRANSCRIPT_WINDOW_ROW_CAP);
  });

  it("negative control: the window stays whole for as long as the pin is held", () => {
    // Without this the retry could be ignoring the pin outright.
    withLaidOutViewport();
    const { binding, controller } = mountBinding(
      syntheticRows(SETTLED_ROW_COUNT),
      NEAR_TAIL_OFFSET_PX,
    );
    act(() => {
      controller.anchor.pin("cursor-3");
    });

    act(() => {
      binding.rerender(syntheticRows(OVER_CAP_ROW_COUNT));
    });

    expect(binding.result.current.snapshot.reading.pinnedRootCursor).toBe("cursor-3");
    expect(binding.result.current.snapshot.rows).toHaveLength(OVER_CAP_ROW_COUNT);
  });
});
