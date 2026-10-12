import { type Range } from "@tanstack/virtual-core";
import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useReducer,
  useState,
} from "react";

import { useDirectlyPlacedVirtualizer } from "#renderer/hooks/useDirectlyPlacedVirtualizer.js";
import { useStopObservingRemovedItems } from "#renderer/hooks/useStopObservingRemovedItems.js";
import { type TranscriptBodyViewport } from "../context.js";
import { DrawnWindowSourcesContext } from "../drawn-window-sources.js";
import { requestLayoutRead } from "../layout-reads.js";
import {
  type MeasuredItemVirtualizer,
  type MeasuredItemWindow,
  type MeasuredWindowRow,
} from "../measured-item-window.js";
import { rangeEnds, withPinnedIndexes } from "../selection-pins.js";
import { useDrawnBandScreenHeights } from "./useDrawnBandScreenHeights.js";
import { useSelectionPins } from "./useSelectionPins.js";

/** What a measured window's owner hands it for one render. */
export interface MeasuredItemWindowOptions<Item> {
  readonly window: MeasuredItemWindow<Item>;
  readonly viewport: TranscriptBodyViewport;
  readonly itemCount: number;
  /** Whether the window's width and type are read, which every estimate needs. */
  readonly isLaidOut: boolean;
  /**
   * Reads the width and type as the window's element first mounts, with the other layout reads of
   * the commit, so the window draws its items before the first frame paints; answers whether it
   * read them.
   */
  readonly readTypeOnMount: () => boolean;
  /** How many items are drawn before the type is read, from the first, as a body drawn whole. */
  readonly firstDrawnCount: number;
  /** An item's room before it is measured; stable for the window's life. */
  readonly estimateSize: (index: number) => number;
  /** The window's element, which its items are observed from; stable for the window's life. */
  readonly getScrollElement: () => HTMLElement | null;
  /** The attribute each item carries its index on. */
  readonly indexAttribute: string;
  /** Each item's text as a copy of it drawn reads, for a copy across its undrawn items. */
  readonly itemText: (index: number) => string;
  /** What a copy writes between two items' texts. */
  readonly itemSeparator: string;
  /** What the items are measured from: each new value measures off screen what is unmeasured. */
  readonly revision: unknown;
}

/** A measured window as one render draws it. */
export interface MeasuredItemWindowView {
  /** The key the feed holds the window's items under, which its spacers carry for a copy. */
  readonly sourceKey: string;
  /** The drawn items and the spacers between them, in document order. */
  readonly rows: readonly MeasuredWindowRow[];
  /**
   * One drawn item, measured as it mounts and each time it resizes; `undefined` for the items
   * drawn before the window lays out, which nothing measures.
   */
  readonly attachItem: ((element: HTMLElement | null) => void) | undefined;
}

/**
 * A window nested in a conversation row over items that are blocks in flow: only the items near the
 * scroller's viewport are drawn, within the conversation's drawn band, plus the items holding the
 * reader's selection's ends; a copy reads the items between them from their text.
 */
export function useMeasuredItemWindow<Item>(
  options: MeasuredItemWindowOptions<Item>,
): MeasuredItemWindowView {
  const { window, viewport, isLaidOut, readTypeOnMount, itemCount } = options;
  const [, redrawRows] = useReducer(countRedraws, 0);
  // The first render draws the first items, as the whole body draws them, and the type is read
  // with them, with the other reads of the commit's mounted bodies; the window draws its own items
  // before the frame paints.
  useLayoutEffect(
    () =>
      requestLayoutRead(() => {
        if (readTypeOnMount()) {
          redrawRows();
        }
      }),
    [readTypeOnMount],
  );

  // The items a copy reads its undrawn ones from, held from the commit that draws its spacers, so a
  // copy asked after any commit finds the items that frame drew from.
  const drawnSources = useContext(DrawnWindowSourcesContext);
  const sourceKey = useId();
  const { itemText, itemSeparator } = options;
  useLayoutEffect(() => {
    drawnSources?.hold(sourceKey, { kind: "text", itemText, itemSeparator });
  });
  useLayoutEffect(
    () => () => {
      drawnSources?.release(sourceKey);
    },
    [drawnSources, sourceKey],
  );

  const readItemCount = useCallback(() => itemCount, [itemCount]);
  const pins = useSelectionPins(
    viewport,
    options.getScrollElement,
    readItemCount,
    options.indexAttribute,
  );
  // The items the scroller shows and the conversation's band past each edge, so a fling meets
  // drawn items rather than a spacer while the next ones mount. The items holding a selection's
  // ends stay drawn too.
  const bandScreenHeights = useDrawnBandScreenHeights();
  const rangeExtractor = useCallback(
    (range: Range) =>
      withPinnedIndexes(
        window.drawnIndexesOf(range, bandScreenHeights),
        rangeEnds(pins),
        range.count,
      ),
    [window, bandScreenHeights, pins],
  );
  // The virtualizer renders again only when the items it draws change; an item that moves a
  // spacer redraws here.
  const onChange = useCallback(
    (instance: MeasuredItemVirtualizer) => {
      if (window.isTakingHeights) {
        return;
      }
      if (window.differsFromCommittedRows(instance.getVirtualItems(), instance.getTotalSize())) {
        redrawRows();
      }
    },
    [window],
  );
  const [initialRect] = useState(() => window.initialRect());

  const virtualizer = useDirectlyPlacedVirtualizer<HTMLElement, HTMLElement>({
    count: itemCount,
    // Laid out only once the type is read: every estimate is reckoned at it.
    enabled: isLaidOut,
    estimateSize: options.estimateSize,
    getScrollElement: options.getScrollElement,
    observeElementOffset: window.observeElementOffset,
    observeElementRect: window.observeElementRect,
    measureElement: window.measureElement,
    scrollToFn: window.scrollToFn,
    initialOffset: window.initialOffset,
    initialRect,
    rangeExtractor,
    onChange,
    indexAttribute: options.indexAttribute,
  });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = window.holdPlaceThroughResizedItem;
  useStopObservingRemovedItems(virtualizer);

  useEffect(() => {
    window.bindVirtualizer(virtualizer);
  }, [window, virtualizer]);
  // Each revision and the first layout measure off screen whatever items the window has not, so
  // the whole height is laid out before the reader scrolls to it.
  const { revision } = options;
  useEffect(() => {
    if (isLaidOut) {
      window.measurement.measure();
    }
  }, [window, revision, isLaidOut]);
  useEffect(
    () => () => {
      window.measurement.stop();
    },
    [window],
  );

  const rows = isLaidOut
    ? window.windowRows(virtualizer.getVirtualItems(), virtualizer.getTotalSize())
    : firstItemRows(Math.min(itemCount, options.firstDrawnCount));
  useLayoutEffect(() => {
    window.commitRows(rows);
  });

  return {
    sourceKey,
    rows,
    attachItem: isLaidOut ? virtualizer.measureElement : undefined,
  };
}

/**
 * The rows drawn before the type is read: the first items, each under the key the window draws it
 * at, so an item the window draws too stays mounted and is measured from then.
 */
function firstItemRows(count: number): MeasuredWindowRow[] {
  return Array.from({ length: count }, (_unused, index) => ({
    kind: "item",
    key: String(index),
    index,
  }));
}

function countRedraws(count: number): number {
  return count + 1;
}
