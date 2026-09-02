// The React binding for the ledger frame: the virtualizer, and what a view reads.
//
// `viewport-controller.ts` holds the policy; this module holds the React side of it.
// The split is not cosmetic — the two options `Spec-023 §Console Libraries` requires
// of this adoption, `useFlushSync: false` and `directDomUpdates`, exist only on
// `@tanstack/react-virtual`'s hook and nowhere on the core `Virtualizer`, so the
// instance HAS to be minted inside a hook. Everything it is minted WITH is the
// controller's, which is why the option list below is almost entirely method
// references rather than closures written here.

import { useVirtualizer } from "@tanstack/react-virtual";
import type { VirtualItem } from "@tanstack/react-virtual";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { type ConsoleClock } from "../../core/index.js";
import { LEDGER_OVERSCAN_ROWS } from "./frame-bounds.js";
import { LedgerViewportController } from "./viewport-controller.js";
import { type LedgerViewportConditions, type LedgerViewportSnapshot } from "./viewport-snapshot.js";

/**
 * The half-open row range the viewport box actually intersects, inclusive at both
 * ends, or `undefined` before anything has been measured.
 *
 * NOT the mounted range: `virtualItems` is this range widened by
 * `LEDGER_OVERSCAN_ROWS` at both edges, which is what makes a scroll meet measured
 * rows instead of a blank band. Anything reporting where the reader IS — the rail's
 * thumb is the one caller today — needs the un-widened one, because an overscanned
 * thumb is several times too tall and starts a screenful early.
 */
export interface LedgerVisibleRowRange {
  readonly startIndex: number;
  readonly endIndex: number;
}

/** What the view gets back: a snapshot, the refs, and the acts it offers. */
export interface LedgerViewportBinding {
  readonly snapshot: LedgerViewportSnapshot;
  readonly virtualItems: readonly VirtualItem[];
  /**
   * The range the box intersects, straight off the virtualizer's own computation
   * over the measurements, the outer size, and the scroll offset.
   *
   * Read from the library rather than re-derived by subtracting the overscan, which
   * is exact nowhere near either end of the list, and taken here rather than
   * published on the viewport snapshot, which deliberately carries no scroll
   * geometry — putting it there would notify React on every scrolled pixel.
   */
  readonly visibleRange: LedgerVisibleRowRange | undefined;
  /** True when the log has outgrown the tallest box a browser will place. */
  readonly isPastElementCeiling: boolean;
  readonly attachSurface: (element: HTMLElement | null) => void;
  /** The size container the virtualizer writes the total height onto. */
  readonly attachSizer: (element: HTMLElement | null) => void;
  /** One row's element, handed to the library's own measurement observer. */
  readonly attachRow: (element: HTMLElement | null) => void;
  readonly jumpToTail: () => void;
  /**
   * Bring one row into view by its key, if this window still holds it.
   *
   * Keyed rather than indexed because every caller — the rail's tick, find's walk,
   * a chapter's header — names a ROW, and an index is a fact about the current
   * window that a prune invalidates between the caller reading it and acting on it.
   * The lookup is over the reconciled snapshot, so a key the cap has already
   * dropped scrolls nothing rather than landing on whichever row now holds that
   * index.
   *
   * Routed through the virtualizer's own `scrollToIndex`, which the controller
   * binds to the ledger's scroll chokepoint — so this adds a caller, not a second
   * scroll writer.
   */
  readonly jumpToRow: (rowKey: string) => void;
}

export interface UseLedgerViewportOptions extends LedgerViewportConditions {
  /**
   * The clock every timer in this frame is minted through. Fixed for the mount:
   * a viewport that swapped clocks mid-life would have work armed on one and
   * cancelled on another.
   */
  readonly clock: ConsoleClock;
}

/**
 * Bind a viewport controller and a virtualizer to a React tree.
 *
 * `rows` is expected to be MEMOIZED by the caller. The reconcile effect keys on its
 * identity, and so does the measurement ledger's key projection, so a caller that
 * rebuilds the array every render reconciles every render — a cost the caller
 * controls and this hook documents, rather than a deep compare performed on its
 * behalf.
 *
 * The re-mint arm is `frame/session-lifecycle.ts`' idiom, for its reason: a remount
 * of the same component instance — React's StrictMode double-mount is the one that
 * does it today — has already run the cleanup, and a disposed controller attaches
 * nothing, so the second mount takes a fresh one rather than a corpse.
 */
export function useLedgerViewport(options: UseLedgerViewportOptions): LedgerViewportBinding {
  const { clock, rows, hasActiveTurn, isRevealDraining } = options;
  const [controller, setController] = useState<LedgerViewportController>(
    () => new LedgerViewportController({ clock }),
  );

  useEffect(() => {
    if (controller.isDisposed) {
      setController(new LedgerViewportController({ clock }));
      return;
    }
    return () => {
      controller.dispose();
    };
  }, [controller, clock]);

  const snapshot = useSyncExternalStore(
    useCallback((onChange: () => void) => controller.subscribe(onChange), [controller]),
    useCallback(() => controller.snapshot(), [controller]),
  );

  const virtualizer = useVirtualizer<HTMLElement, HTMLElement>({
    count: snapshot.keyProjection.virtualKeys.length,
    overscan: LEDGER_OVERSCAN_ROWS,
    estimateSize: controller.seams.estimateSize,
    getItemKey: controller.seams.getItemKey,
    getScrollElement: controller.seams.getScrollElement,
    scrollToFn: controller.seams.scrollToFn,
    observeElementOffset: controller.seams.observeElementOffset,
    observeElementRect: controller.seams.observeElementRect,
    measureElement: controller.seams.measureElement,
    // React 19 logs "flushSync was called from inside a lifecycle method" when the
    // adapter flushes its own re-render, and the render this would force is one this
    // frame does not need: the offsets are written to the DOM directly.
    useFlushSync: false,
    // Scroll ticks skip React entirely — the adapter writes each row's transform and
    // the container's height itself, and re-renders only when the index range moves.
    directDomUpdates: true,
  });

  useEffect(() => {
    if (controller.isDisposed) {
      return;
    }
    controller.bindVirtualizer(virtualizer);
  }, [controller, virtualizer]);

  useEffect(() => {
    if (controller.isDisposed) {
      return;
    }
    controller.reconcile({ rows, hasActiveTurn, isRevealDraining });
  }, [controller, rows, hasActiveTurn, isRevealDraining]);

  const virtualItems = virtualizer.getVirtualItems();
  const isPastElementCeiling = controller.measurements.isPastElementCeiling(
    virtualizer.getTotalSize(),
  );

  return {
    snapshot,
    virtualItems,
    // Read AFTER `getVirtualItems()`, which is what drives the range computation:
    // the field is `null` until that pass has run over a box with a non-zero outer
    // size, and `null` is the honest "nothing measured yet" answer rather than a
    // range starting at zero.
    visibleRange: virtualizer.range ?? undefined,
    isPastElementCeiling,
    attachSurface: useCallback(
      (element: HTMLElement | null) => {
        if (element === null) {
          controller.detach();
          return;
        }
        controller.attach(element);
      },
      [controller],
    ),
    attachSizer: virtualizer.containerRef,
    attachRow: virtualizer.measureElement,
    jumpToTail: useCallback(() => {
      controller.jumpToTail();
    }, [controller]),
    jumpToRow: useCallback(
      (rowKey: string) => {
        const index = snapshot.rows.findIndex((candidate) => candidate.key === rowKey);
        if (index < 0) {
          return;
        }
        virtualizer.scrollToIndex(index, { align: "center" });
      },
      [snapshot, virtualizer],
    ),
  };
}
