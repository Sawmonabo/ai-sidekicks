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
import {
  LedgerViewportController,
  type LedgerViewportConditions,
  type LedgerViewportSnapshot,
} from "./viewport-controller.js";

/** What the view gets back: a snapshot, the refs, and the acts it offers. */
export interface LedgerViewportBinding {
  readonly snapshot: LedgerViewportSnapshot;
  readonly virtualItems: readonly VirtualItem[];
  /** True when the log has outgrown the tallest box a browser will place. */
  readonly isPastElementCeiling: boolean;
  readonly attachSurface: (element: HTMLElement | null) => void;
  /** The size container the virtualizer writes the total height onto. */
  readonly attachSizer: (element: HTMLElement | null) => void;
  /** One row's element, handed to the library's own measurement observer. */
  readonly attachRow: (element: HTMLElement | null) => void;
  readonly jumpToTail: () => void;
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
    estimateSize: controller.estimateSize,
    getItemKey: controller.getItemKey,
    getScrollElement: controller.getScrollElement,
    scrollToFn: controller.scrollToFn,
    observeElementOffset: controller.observeElementOffset,
    observeElementRect: controller.observeElementRect,
    measureElement: controller.measureElement,
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
  };
}
