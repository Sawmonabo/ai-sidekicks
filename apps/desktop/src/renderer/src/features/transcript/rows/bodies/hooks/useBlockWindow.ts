import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useReducer, useState } from "react";

import { type MarkdownBodyBlocksSnapshot } from "../../markdown/body-blocks.js";
import { type MarkdownWindowViewport } from "../../markdown/block-window/context.js";
import {
  BlockWindowLayout,
  windowedBlockKeyOf,
  type BlockVirtualizer,
  type BlockWindowRow,
} from "../../markdown/block-window/layout.js";
import { MARKDOWN_BLOCK_INDEX_ATTRIBUTE } from "../../markdown/block-window/markers.js";
import { indexesBetween, withPinnedIndexes } from "../../markdown/block-window/selection-pins.js";
import { refuseScrollAdjustment } from "../../markdown/scroller-window.js";
import { useSelectionPins } from "./useSelectionPins.js";

/** A windowed body's elements as one render draws them. */
export interface BlockWindow {
  /** The drawn blocks and the spacers between them, in document order. */
  readonly rows: readonly BlockWindowRow[];
  /** The body's element, whose width and place in its row the window reads. */
  readonly attachBody: (element: HTMLElement | null) => void;
  /** The body's layout, which a long table in one of its blocks lays its rows out from. */
  readonly layout: BlockWindowLayout;
  /** One block wrapper, measured as it mounts and each time it resizes. */
  readonly attachBlock: (element: HTMLElement | null) => void;
}

/**
 * Blocks drawn past each edge of the scroller, so a fling meets drawn text rather than an empty
 * band while the next blocks mount. Six blocks of agent prose are about two screens of lines.
 */
const BLOCK_WINDOW_OVERSCAN_BLOCKS = 6;

/**
 * One long body's window over its blocks: only those near the scroller's viewport are drawn, plus
 * every block the reader's selection runs across. A scroll re-renders the body only when the
 * drawn blocks change, and a measured block only when it moves a spacer. `viewport` and `rowKey`
 * are held for the body's life.
 */
export function useBlockWindow(
  blocks: MarkdownBodyBlocksSnapshot,
  bodyTextLength: number,
  viewport: MarkdownWindowViewport,
  rowKey: string,
): BlockWindow {
  const [layout] = useState(
    () => new BlockWindowLayout({ viewport, rowKey, blocks, bodyTextLength }),
  );
  layout.setBlocks(blocks, bodyTextLength);
  const [, redrawRows] = useReducer(countRedraws, 0);

  // The body is the window's element: its children are the wrappers and spacers.
  const readBodyElement = layout.getScrollElement;
  const readBlockCount = useCallback(() => layout.blockCount, [layout]);
  const pins = useSelectionPins(
    viewport,
    readBodyElement,
    readBlockCount,
    MARKDOWN_BLOCK_INDEX_ATTRIBUTE,
  );
  // Every block between a selection's ends stays drawn, so a copy reads the blocks from the page.
  const rangeExtractor = useCallback(
    (range: Range) =>
      withPinnedIndexes(defaultRangeExtractor(range), indexesBetween(pins), range.count),
    [pins],
  );
  // A new identity whenever a block settles, so the library re-reads every key even where the
  // count did not change: the tail's place can pass to a settled block at the same index.
  const settledBlocks = blocks.settledBlocks;
  const getItemKey = useCallback(
    (index: number) => windowedBlockKeyOf(settledBlocks, index),
    [settledBlocks],
  );
  const onChange = useCallback(
    (instance: BlockVirtualizer) => {
      if (layout.differsFromCommittedRows(instance.getVirtualItems(), instance.getTotalSize())) {
        redrawRows();
      }
      layout.announcePlacementChange("moved");
    },
    [layout],
  );
  const [initialRect] = useState(() => layout.initialRect());

  const virtualizer = useVirtualizer<HTMLElement, HTMLElement>({
    count: layout.blockCount,
    getItemKey,
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
    overscan: BLOCK_WINDOW_OVERSCAN_BLOCKS,
    indexAttribute: MARKDOWN_BLOCK_INDEX_ATTRIBUTE,
    // A geometry sample can arrive while React commits, where a synchronous flush only warns.
    useFlushSync: false,
    // With no container attached the adapter writes nothing to the page and re-renders only when
    // the drawn range changes; a block that moves a spacer redraws through `onChange`.
    directDomUpdates: true,
  });
  // The body follows the conversation's place and never moves it, however a block measures.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = refuseScrollAdjustment;

  useEffect(() => {
    layout.bindVirtualizer(virtualizer);
  }, [layout, virtualizer]);

  const rows = layout.windowRows(virtualizer.getVirtualItems(), virtualizer.getTotalSize());
  useLayoutEffect(() => {
    layout.commitRows(rows);
  });

  return { rows, attachBody: layout.attachBody, attachBlock: virtualizer.measureElement, layout };
}

function countRedraws(count: number): number {
  return count + 1;
}
