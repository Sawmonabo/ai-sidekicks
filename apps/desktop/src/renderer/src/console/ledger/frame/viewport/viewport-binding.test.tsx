// What the React binding asks the controller for, beyond the reconcile.
//
// The controller's own cases drive it directly — `viewport-controller.test.ts` owns
// the prune, the reading floor, and the refusals. What only THIS file can say is
// that a mounted ledger ever re-asks: the reconcile effect keys on the row set and
// the two activity flags, so a window the cap refused while somebody was reading
// above the tail is re-asked only if something in the tree calls for it. Without the
// second effect every case here passes the first half and fails the second, which is
// the shape the defect had — a window over its cap for as long as the session stayed
// quiet.
//
// ONE GROUP PER DEPENDENCY THAT EFFECT KEYS ON, because a dependency no case spends
// is a dependency anybody may delete with the suite green. The reading mode is the
// first group's; the last prune outcome is the veto group's, where the reader never
// leaves the tail; the pin is the last group's, where the mode does not move either.
// Each was checked by removal: drop its dependency and that group's first case fails
// with the window still over its cap.
//
// The layout engine is stubbed the way `LedgerViewport.test.tsx` stubs it and for
// the same reason: `happy-dom` reports zero for `clientHeight` and `scrollHeight`,
// and a viewport with no box is at its tail by construction, so the reading state
// this file drives would never leave `following`. Every module in the assertion path
// — the binding, the controller, the chokepoint, the window cap, and the real
// virtualizer — is the shipped one.

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LEDGER_WINDOW_ROW_CAP, ManualClock } from "../../../core/index.js";
import { LEDGER_TAIL_TOLERANCE_PX } from "../frame-bounds.js";
import { useLedgerViewport, type LedgerViewportBinding } from "./viewport-binding.js";
import { LedgerViewportController } from "./viewport-controller.js";
import type { LedgerViewportRow } from "./viewport-snapshot.js";
import { type PruneDeferralReason } from "./window-cap.js";

const VIEWPORT_HEIGHT_PX = 400;
const CONTENT_HEIGHT_PX = 10_000;
const TAIL_OFFSET_PX = CONTENT_HEIGHT_PX - VIEWPORT_HEIGHT_PX;
/**
 * Inside the tail tolerance, so the reader counts as AT the tail, and far enough
 * from it that a glide to the exact tail moves the offset — which is what makes the
 * glide publish a sample its subscribers are woken for rather than one the
 * chokepoint suppresses as unchanged.
 */
const NEAR_TAIL_OFFSET_PX = TAIL_OFFSET_PX - LEDGER_TAIL_TOLERANCE_PX / 2;
const SETTLED_ROW_COUNT = 20;
const OVER_CAP_ROW_COUNT = LEDGER_WINDOW_ROW_CAP + 40;
const CALM = { hasActiveTurn: false, isRevealDraining: false } as const;

function syntheticRows(count: number): readonly LedgerViewportRow[] {
  return Array.from({ length: count }, (_unused, index) => ({
    key: `row-${String(index)}`,
    parentKey: undefined,
    rootCursor: `cursor-${String(index)}`,
  }));
}

/** A box taller than nothing, so the reader can be somewhere other than the tail. */
function withLaidOutViewport(): void {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(VIEWPORT_HEIGHT_PX);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(CONTENT_HEIGHT_PX);
}

/**
 * A mounted binding over a surface a case can scroll, and the controller it minted.
 *
 * THE CONTROLLER IS RECORDED, NOT REPLACED. `vi.spyOn` leaves the real `attach` in
 * place and remembers only its receiver, so every module in the assertion path is
 * still the shipped one. It has to be taken here because the hook mints the
 * controller itself and hands the tree a binding rather than the object — which is
 * deliberate, the virtualizer's two adapter-only options forcing the instance to be
 * born inside a hook — and one case below has to reach the scroll controller's own
 * geometry subscription to reconcile while a write is still in flight.
 */
function mountBinding(
  rows: readonly LedgerViewportRow[],
  initialScrollTopPx = 0,
): {
  binding: ReturnType<typeof renderHook<LedgerViewportBinding, readonly LedgerViewportRow[]>>;
  surface: HTMLElement;
  controller: LedgerViewportController;
} {
  const attachedControllers = vi.spyOn(LedgerViewportController.prototype, "attach");
  const clock = new ManualClock();
  const binding = renderHook(
    (currentRows: readonly LedgerViewportRow[]) =>
      useLedgerViewport({ clock, rows: currentRows, ...CALM }),
    { initialProps: rows },
  );
  const surface = document.createElement("div");
  surface.scrollTop = initialScrollTopPx;
  act(() => {
    binding.result.current.attachSurface(surface);
  });
  const [controller] = attachedControllers.mock.contexts;
  if (!(controller instanceof LedgerViewportController)) {
    throw new Error("the binding attached no viewport controller");
  }
  return { binding, surface, controller };
}

/** Move the reader, the way a finger does: the offset, then the event. */
function scrollTo(surface: HTMLElement, offsetPx: number): void {
  act(() => {
    surface.scrollTop = offsetPx;
    surface.dispatchEvent(new Event("scroll"));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the ledger viewport binding — a prune the window refused", () => {
  it("is re-asked when the reader returns to the tail, with no new rows", () => {
    withLaidOutViewport();
    const { binding, surface } = mountBinding(syntheticRows(SETTLED_ROW_COUNT));
    // Above the tail first, so the log that arrives next meets a reading floor.
    scrollTo(surface, 0);
    expect(binding.result.current.snapshot.reading.mode).toBe("reading");

    act(() => {
      binding.rerender(syntheticRows(OVER_CAP_ROW_COUNT));
    });
    expect(binding.result.current.snapshot.lastPrune?.deferredBecause).toBe("reading-floor");
    expect(binding.result.current.snapshot.rows).toHaveLength(OVER_CAP_ROW_COUNT);

    // THE RETURN, and nothing else. No row arrives, no turn starts, no reveal drains
    // — so the reconcile effect's own dependencies are all untouched.
    scrollTo(surface, TAIL_OFFSET_PX);

    expect(binding.result.current.snapshot.reading.mode).toBe("following");
    expect(binding.result.current.snapshot.rows).toHaveLength(LEDGER_WINDOW_ROW_CAP);
  });

  it("negative control: a re-render that changes nothing leaves the reader's window whole", () => {
    // Without this the second effect could be re-asking on every render, which would
    // take rows out from under somebody who is still reading them.
    withLaidOutViewport();
    const { binding, surface } = mountBinding(syntheticRows(SETTLED_ROW_COUNT));
    scrollTo(surface, 0);
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

describe("the ledger viewport binding — a prune the write itself refused", () => {
  it("takes the rows once the write that vetoed them has finished", () => {
    // THE DEPENDENCY THIS CASE SPENDS. The retry effect keys on the reading mode,
    // the pin, and the last prune outcome. Here the reader never leaves the tail and
    // nothing is pinned, so the outcome's identity is the ONLY dependency that
    // moves — and without it the window stays over its cap with no second reconcile
    // ever arriving, because the row set and both activity flags are untouched too.
    //
    // The veto is raised and dropped inside ONE synchronous glide, so the only way
    // to reconcile under it is from a subscriber the glide itself wakes, which is
    // how `viewport-controller.test.ts` reaches the same refusal. Nothing observes
    // the veto lifting; keying the retry on the refusal is what makes it reachable.
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
    expect(binding.result.current.snapshot.rows).toHaveLength(LEDGER_WINDOW_ROW_CAP);
  });

  it("negative control: a glide that refuses nothing re-asks for no prune", () => {
    // Without this the effect could be re-asking on every published outcome, which
    // would make the case above pass over a binding that pruned on any notification
    // at all rather than on a refusal it recorded.
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

    // The glide moved the offset and published a sample; no reconcile ran under it,
    // so the outcome the retry keys on is the same object it already held.
    expect(controller.scroll.writeCount("jump-to-tail")).toBe(1);
    expect(binding.result.current.snapshot.lastPrune).toBe(settledOutcome);
    expect(binding.result.current.snapshot.rows).toHaveLength(SETTLED_ROW_COUNT);
  });
});

describe("the ledger viewport binding — a prune a pin held back", () => {
  it("takes the rows when the pin lifts, with the reading mode unmoved", () => {
    // THE SECOND DEPENDENCY, spent the same way. Pinning history suppresses prune
    // and lifting it moves neither the row set, nor either activity flag, nor the
    // reading mode — the anchor leaves the mode where the pin put it — so the pin
    // itself is the only dependency the effect can be re-asked on.
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
    expect(binding.result.current.snapshot.rows).toHaveLength(LEDGER_WINDOW_ROW_CAP);
  });

  it("negative control: the window stays whole for as long as the pin is held", () => {
    // Without this the retry could be ignoring the pin outright, which is the one
    // promise pinned history makes.
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
