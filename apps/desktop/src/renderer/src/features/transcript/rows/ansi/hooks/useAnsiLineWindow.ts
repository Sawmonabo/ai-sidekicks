import { type Range } from "@tanstack/virtual-core";
import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useReducer,
  useState,
  useSyncExternalStore,
} from "react";

import { useDirectlyPlacedVirtualizer } from "#renderer/hooks/useDirectlyPlacedVirtualizer.js";
import { useStopObservingRemovedItems } from "#renderer/hooks/useStopObservingRemovedItems.js";
import { useSelectionPins } from "../../bodies/hooks/useSelectionPins.js";
import { DrawnWindowSourcesContext } from "../../drawn-window-sources.js";
import { type MarkdownWindowViewport } from "../../markdown/block-window/context.js";
import { rangeEnds, withPinnedIndexes } from "../../markdown/block-window/selection-pins.js";
import { type AnsiLineChunkList } from "../lines/chunks.js";
import { ANSI_LINE_CHUNK_INDEX_ATTRIBUTE } from "../lines/markers.js";
import { type AnsiChunkMeasurement } from "../lines/measurement.js";
import {
  AnsiLineWindowLayout,
  type AnsiLineVirtualizer,
  type AnsiLineWindowRow,
} from "../lines/window-layout.js";

/** A command output's window over its chunks of lines, as one render draws it. */
export interface AnsiLineWindow {
  /** The key the feed holds the output's chunks under, which its spacers carry for a copy. */
  readonly outputKey: string;
  /** The drawn chunks and the spacers between them, in document order. */
  readonly rows: readonly AnsiLineWindowRow[];
  /** The output's lines element, whose width, type and place in its row the window reads. */
  readonly attachLines: (element: HTMLElement | null) => void;
  /**
   * One drawn chunk, measured as it mounts and each time it resizes; `undefined` for the chunks
   * drawn before the window lays out, which nothing measures.
   */
  readonly attachChunk: ((element: HTMLElement | null) => void) | undefined;
  /** The measurement of the chunks off screen, whose frame the output draws hidden. */
  readonly measurement: AnsiChunkMeasurement;
}

/**
 * One command output's window over its chunks of lines: only the chunks near the scroller's
 * viewport are drawn, plus the chunks holding the reader's selection's ends; the chunks between
 * them are copied from the text. `viewport` and `rowKey` are held for the window's life, and a
 * new generation of chunks takes a new window.
 */
export function useAnsiLineWindow(
  chunks: AnsiLineChunkList,
  viewport: MarkdownWindowViewport,
  rowKey: string,
): AnsiLineWindow {
  const [layout] = useState(() => new AnsiLineWindowLayout(viewport, rowKey, chunks));
  layout.setChunks(chunks);
  const [, redrawRows] = useReducer(countRedraws, 0);
  // The first render draws the output's first chunks, as the whole output draws them, and the
  // lines are laid out with them once to read their type; the window draws its own chunks before
  // the frame paints.
  useLayoutEffect(() => {
    if (layout.readTypeOnMount()) {
      redrawRows();
    }
  }, [layout]);

  // The chunks a copy reads its undrawn lines from, held from the commit that draws its spacers,
  // so a copy asked after any commit finds the chunks that frame drew from.
  const drawnSources = useContext(DrawnWindowSourcesContext);
  const outputKey = useId();
  useLayoutEffect(() => {
    drawnSources?.hold(outputKey, { kind: "output", chunks });
  });
  useLayoutEffect(
    () => () => {
      drawnSources?.release(outputKey);
    },
    [drawnSources, outputKey],
  );

  const readChunkCount = useCallback(() => layout.chunkCount, [layout]);
  const pins = useSelectionPins(
    viewport,
    layout.getScrollElement,
    readChunkCount,
    ANSI_LINE_CHUNK_INDEX_ATTRIBUTE,
  );
  // The chunks the scroller shows and the conversation's band past each edge, so a fling meets
  // drawn lines rather than a spacer while the next ones mount. The chunks holding a selection's
  // ends stay drawn too.
  const bandScreenHeights = useSyncExternalStore(
    viewport.subscribeToDrawnBand,
    viewport.drawnBandScreenHeights,
  );
  const rangeExtractor = useCallback(
    (range: Range) =>
      withPinnedIndexes(
        layout.drawnIndexesOf(range, bandScreenHeights),
        rangeEnds(pins),
        range.count,
      ),
    [layout, bandScreenHeights, pins],
  );
  // The virtualizer renders again only when the chunks it draws change; a chunk that moves a
  // spacer redraws here.
  const onChange = useCallback(
    (instance: AnsiLineVirtualizer) => {
      if (layout.isTakingHeights) {
        return;
      }
      if (layout.differsFromCommittedRows(instance.getVirtualItems(), instance.getTotalSize())) {
        redrawRows();
      }
    },
    [layout],
  );
  const [initialRect] = useState(() => layout.initialRect());

  const virtualizer = useDirectlyPlacedVirtualizer<HTMLElement, HTMLElement>({
    count: chunks.count,
    // Laid out only once the lines' type is read: every estimate wraps lines at their width.
    enabled: layout.isLaidOut,
    estimateSize: layout.estimateSize,
    getScrollElement: layout.getScrollElement,
    observeElementOffset: layout.observeElementOffset,
    observeElementRect: layout.observeElementRect,
    measureElement: layout.measureElement,
    scrollToFn: layout.scrollToFn,
    initialOffset: layout.initialOffset,
    initialRect,
    rangeExtractor,
    onChange,
    indexAttribute: ANSI_LINE_CHUNK_INDEX_ATTRIBUTE,
  });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = layout.holdPlaceThroughResizedChunk;
  useStopObservingRemovedItems(virtualizer);

  useEffect(() => {
    layout.bindVirtualizer(virtualizer);
  }, [layout, virtualizer]);
  // Each revision and the first layout measure off screen whatever chunks the window has not, so
  // the output's whole height is laid out before the reader scrolls to it.
  const isLaidOut = layout.isLaidOut;
  useEffect(() => {
    if (isLaidOut) {
      layout.measurement.measure();
    }
  }, [layout, chunks, isLaidOut]);
  useEffect(
    () => () => {
      layout.measurement.stop();
    },
    [layout],
  );

  const rows = isLaidOut
    ? layout.windowRows(virtualizer.getVirtualItems(), virtualizer.getTotalSize())
    : firstChunkRows(chunks.count);
  useLayoutEffect(() => {
    layout.commitRows(rows);
  });

  return {
    outputKey,
    rows,
    attachLines: layout.attachLines,
    attachChunk: isLaidOut ? virtualizer.measureElement : undefined,
    measurement: layout.measurement,
  };
}

/**
 * The rows drawn before the lines' type is read: the first chunks, enough of a long output that
 * its cut reads it running past from the first frame, each under a key of its own, so the window's
 * chunks mount in their place and are measured.
 */
function firstChunkRows(chunkCount: number): AnsiLineWindowRow[] {
  return Array.from(
    { length: Math.min(chunkCount, FIRST_DRAWN_CHUNK_COUNT) },
    (_unused, index) => ({
      kind: "chunk",
      key: `first:${String(index)}`,
      index,
    }),
  );
}

/** How many chunks the first render draws: two chunks' lines run past a quarter of the flow. */
const FIRST_DRAWN_CHUNK_COUNT = 2;

function countRedraws(count: number): number {
  return count + 1;
}
