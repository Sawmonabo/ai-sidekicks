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
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { type ConsoleClock, type LedgerWindowReading } from "../../../../core/index.js";
import { WINDOWED_ROW_INDEX_ATTRIBUTE } from "../../../../primitives/index.js";
import { LEDGER_OVERSCAN_ROWS } from "../../frame-bounds.js";
import { LedgerViewportController } from "../cycle/viewport-controller.js";
import { type LedgerRowLease } from "../../row-lease-table.js";
import { type LedgerViewportConditions, type LedgerViewportSnapshot } from "./viewport-snapshot.js";

/** What the view gets back: a snapshot, the refs, and the acts it offers. */
export interface LedgerViewportBinding {
  readonly snapshot: LedgerViewportSnapshot;
  readonly virtualItems: readonly VirtualItem[];
  /** Rows this window holds and cannot draw, because it ran out of height. */
  readonly rowsPastElementCeiling: number;
  readonly attachSurface: (element: HTMLElement | null) => void;
  /** The size container the virtualizer writes the total height onto. */
  readonly attachSizer: (element: HTMLElement | null) => void;
  /** One row's element, handed to the library's own measurement observer. */
  readonly attachRow: (element: HTMLElement | null) => void;
  readonly jumpToTail: () => void;
  /**
   * Bring one row into view by its key, if this window still holds it.
   *
   * Keyed rather than indexed because every caller — find's walk, a chapter's
   * header, a jump by event id — names a ROW, and an index is a fact about the current
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
  /**
   * Put keyboard focus back on the log itself.
   *
   * For a caller that took focus and is giving it back — the find field's close is
   * the one today. Without it focus falls to `body`, which is nowhere: the next Tab
   * restarts from the top of the document and the reading position a person was
   * keeping is unreachable from the keyboard.
   *
   * The binding holds the surface element its own attach callback already receives,
   * so no component reaches into the DOM and the view that mounts the surface is
   * untouched.
   */
  readonly focusSurface: () => void;
  /**
   * The state a row body parked on this window, live or re-parked after a prune.
   *
   * The window has held this table since it was written and nothing production-side
   * ever read it: the one row that kept an expansion kept it in its own `useState`,
   * which the virtualizer discards the moment the row leaves the mounted range. The
   * lease survives both an unmount and a prune, under the parked-lease cap.
   */
  readonly rowLease: (rowKey: string) => LedgerRowLease | undefined;
  /** Park one row body's state on the window. */
  readonly setRowLease: (rowKey: string, lease: LedgerRowLease) => void;
  /**
   * What this window is showing, read at the instant it is asked.
   *
   * A FUNCTION and not a snapshot member, because most of what it reports is layout
   * or a computation over it, and this binding deliberately keeps that off the React
   * snapshot — publishing it there would notify the tree on every scrolled pixel.
   * Nothing in the console renders from it: the endurance tier reads it through the
   * fixture handle, where the several ways a ledger can show nothing are different
   * findings that one row count answers identically. Stable across renders, so a
   * registration keyed on it registers once.
   */
  readonly readWindowDiagnostics: () => LedgerWindowReading;
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
 * The re-mint arm is `frame/session/session-lifecycle.ts`' idiom, for its reason: a remount
 * of the same component instance — React's StrictMode double-mount is the one that
 * does it today — has already run the cleanup, and a disposed controller attaches
 * nothing, so the second mount takes a fresh one rather than a corpse.
 */
export function useLedgerViewport(options: UseLedgerViewportOptions): LedgerViewportBinding {
  const { clock, rows, hasActiveTurn, isRevealDraining } = options;
  // The element the controller is attached to, kept for the one act that needs the
  // node rather than the controller. A ref rather than state: nothing renders from
  // it, so writing it during attach must not schedule a render.
  const surfaceElementRef = useRef<HTMLElement | null>(null);
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
    // The attribute the row primitive WRITES, named here rather than left to the
    // library's identically-spelled default: the row and the measurement are two
    // sides of one seam, and a default is not a seam — a rename in the primitive
    // would leave this reading an attribute nothing writes, which measures every
    // row as row zero with no gate anywhere to notice.
    indexAttribute: WINDOWED_ROW_INDEX_ATTRIBUTE,
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

  // THE PRUNE THE RECONCILE ABOVE COULD NOT FINISH, RE-ASKED WHEN ITS REFUSAL
  // LIFTS.
  //
  // The effect above depends on the row set and the two activity flags and on
  // nothing else, which is right for what it does and is exactly why it is not
  // enough on its own: the window also refuses a prune while the reader is above
  // the tail, while history is pinned, while a programmatic scroll is mid-write, and
  // while the rows the cap wants are held — and none of those four moves any of its
  // three dependencies. A reader who scrolled up on a busy session and then came
  // back to the tail therefore left the window over its cap for as long as the log
  // stayed quiet.
  //
  // COULD NOT FINISH, NOT COULD NOT PERFORM. The commonest case by far is a pass
  // that APPLIED — it took the rows above the reader and stopped at their row with
  // thousands still over the cap. That outcome names no deferral, so it is the
  // outcome's `owedBecause` and not its `deferredBecause` that the cycle re-asks on.
  //
  // THE DEPENDENCIES ARE THE TRANSITIONS AND NOT THE SCROLL. The reading fields
  // carry the first two refusals and move only when the reading state itself does —
  // the snapshot deliberately omits the anchor point, so scrolling within a mode
  // changes neither. `lastPrune` is what carries the third: the veto is raised and
  // dropped inside a single synchronous write, so by the time a render observes the
  // refusal it recorded, the write that caused it is already over. Keying on the
  // outcome's identity is therefore what makes that refusal reachable at all, and it
  // cannot spin — every pass that lands takes rows the next one no longer has to,
  // and a residual whose blocker is still standing answers `undefined` however often
  // it is asked.
  const { mode: readingMode, pinnedRootCursor } = snapshot.reading;
  const lastPrune = snapshot.lastPrune;
  useEffect(() => {
    if (controller.isDisposed) {
      return;
    }
    controller.retryDeferredPrune();
  }, [controller, readingMode, pinnedRootCursor, lastPrune]);

  // THE POSITION HOLD, PERFORMED AFTER THE HEIGHT IT DEPENDS ON IS COMMITTED.
  //
  // `reconcile` runs in a PASSIVE effect, so the rows it took have not rendered when
  // it runs and the sizer still carries the previous total size. Both deferred arms
  // fail there for that one reason: a glide to the tail lands on the bottom of the log
  // as it was before the append, and a head hold reads the offset the row that used to
  // be first had before a page was inserted above it. The controller therefore arms
  // whichever is owed and this performs it — `viewport-deferred-hold.ts` states which
  // is which.
  //
  // A LAYOUT effect, declared AFTER `useVirtualizer`, and both halves are the
  // mechanism rather than style. The adapter writes the container's height under
  // `directDomUpdates` from its own layout effect; React runs a component's layout
  // effects in hook order, so this one runs after that write and before the browser
  // paints. No timer and no second animation frame is involved: the signal is the
  // library's own commit, and reading `scrollHeight` here answers with the height it
  // just wrote.
  //
  // No dependency array, because the height can move on any render — a re-measured
  // row changes the total size with the row set untouched — and the call costs a
  // boolean read on every render that armed nothing.
  useLayoutEffect(() => {
    if (controller.isDisposed) {
      return;
    }
    controller.commitPendingPositionHold();
  });

  // A lease write is state the WINDOW owns, so it is not React state — but the tree
  // has to repaint to show it. The revision is the notification, and nothing reads
  // it: it exists so the density overlay recomputes on the frame a lease changes.
  const [leaseRevision, setLeaseRevision] = useState(0);

  const virtualItems = virtualizer.getVirtualItems();
  const rowsPastElementCeiling = controller.measurements.rowsPastElementCeiling(
    snapshot.keyProjection.virtualKeys,
    virtualizer.getTotalSize(),
  );

  return {
    snapshot,
    virtualItems,
    rowsPastElementCeiling,
    attachSurface: useCallback(
      (element: HTMLElement | null) => {
        surfaceElementRef.current = element;
        if (element === null) {
          controller.detach();
          return;
        }
        controller.attach(element);
      },
      [controller],
    ),
    focusSurface: useCallback(() => {
      surfaceElementRef.current?.focus();
    }, []),
    attachSizer: virtualizer.containerRef,
    attachRow: virtualizer.measureElement,
    jumpToTail: useCallback(() => {
      controller.jumpToTail();
    }, [controller]),
    rowLease: useCallback(
      (rowKey: string) => {
        // `leaseRevision` is the memo's reason to recompute, and reading it here is
        // what makes that honest rather than a dependency nobody spends.
        void leaseRevision;
        return controller.window.lease(rowKey);
      },
      [controller, leaseRevision],
    ),
    setRowLease: useCallback(
      (rowKey: string, lease: LedgerRowLease) => {
        controller.window.setLease(rowKey, lease);
        setLeaseRevision((current) => current + 1);
      },
      [controller],
    ),
    readWindowDiagnostics: useCallback((): LedgerWindowReading => {
      // `getVirtualItems()` FIRST, because it is the call that recomputes the range:
      // reading `virtualizer.range` before it would report the window as it was at
      // the last render rather than as it is now, and the two disagree exactly when
      // this reading is worth taking.
      const virtualItems = virtualizer.getVirtualItems();
      const range = virtualizer.range;
      // The ELEMENT, and not the chokepoint's last sample. The sample is what the
      // library was told the box is, so a reading taken from it could only ever
      // agree with the window — including when both are describing a box that has
      // since collapsed. Read here, a disagreement between the two is visible.
      const surface = surfaceElementRef.current;
      return {
        virtualItemCount: virtualItems.length,
        // Counted under the SURFACE rather than the sizer, so a row the view placed
        // outside the sizer is still counted and the figure cannot be flattered by
        // asking only where rows are supposed to be.
        mountedRowCount: surface?.querySelectorAll(`[${WINDOWED_ROW_INDEX_ATTRIBUTE}]`).length ?? 0,
        totalRowCount: virtualizer.options.count,
        indexableRowCount: snapshot.rows.length,
        visibleRowCount: range === null ? 0 : range.endIndex - range.startIndex + 1,
        totalContentHeightPx: virtualizer.getTotalSize(),
        viewportClientHeightPx: surface?.clientHeight ?? 0,
        viewportScrollHeightPx: surface?.scrollHeight ?? 0,
        rangedAgainstClientHeightPx: controller.scroll.geometry?.viewportHeight ?? 0,
      };
    }, [controller, snapshot, virtualizer]),
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
