import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";

import {
  type HeldTableColumns,
  type MarkdownTableOffer,
} from "#renderer/components/Markdown/table-offer.js";
import { MARKDOWN_TABLE_ROW_INDEX_ATTRIBUTE } from "../../markdown/block-window/markers.js";
import { rangeEnds, withPinnedIndexes } from "../../markdown/block-window/selection-pins.js";
import { refuseScrollAdjustment } from "../../markdown/scroller-window.js";
import {
  ListedBodiesContext,
  MarkdownBlockIndexContext,
  TableWindowBodyContext,
} from "../../markdown/table-window/context.js";
import {
  TableWindowLayout,
  type TableRowVirtualizer,
  type TableWindowRow,
} from "../../markdown/table-window/layout.js";
import { type TableMeasuringFrame } from "../../markdown/table-window/measurement.js";
import { useSelectionPins } from "./useSelectionPins.js";

/** A long table's elements as one render draws them. */
export interface TableWindow {
  /** The widths the drawn table's columns are held at; `undefined` until they are measured. */
  readonly heldColumns: HeldTableColumns | undefined;
  /**
   * Whether the table is drawn whole while its first columns are measured: its body has a width
   * and no columns are held yet. Before the body has a width the table draws nothing.
   */
  readonly drawsWhole: boolean;
  /** What this render lays out hidden for the running measurement, or `undefined`. */
  readonly measuring: TableMeasuringFrame | undefined;
  /** Reads the frame drawn hidden for `measuring` from its table, once the browser laid it out. */
  readonly readMeasuringFrame: (frame: TableMeasuringFrame, table: HTMLTableElement) => void;
  /** The drawn rows and the spacers between them, in document order. */
  readonly rows: readonly TableWindowRow[];
  /** The drawn table's body element, whose place in its block the window reads. */
  readonly attachBody: (element: HTMLElement | null) => void;
  /** One drawn row, measured as it mounts and each time it resizes. */
  readonly attachRow: (element: HTMLElement | null) => void;
}

/**
 * Body rows drawn past each edge of the scroller, so a fling meets drawn rows rather than an empty
 * band while the next ones mount: about half a screen of one-line rows.
 */
const TABLE_WINDOW_OVERSCAN_ROWS = 12;

/**
 * One long table's window over its body rows, inside a transcript viewport: only the rows near the
 * scroller's viewport are drawn, plus the rows holding the reader's selection's ends and a row
 * brought into view on request. Its columns are held at the widths automatic layout gives the
 * whole table, measured from its head and the rows holding each column's widest cells. Throws
 * outside a viewport's markdown body block.
 */
export function useTableWindow(offer: MarkdownTableOffer): TableWindow {
  const body = useContext(TableWindowBodyContext);
  const blockIndex = useContext(MarkdownBlockIndexContext);
  if (body === undefined || blockIndex === undefined) {
    throw new Error("A long table was drawn outside a markdown body's block in a viewport.");
  }
  const [, redraw] = useReducer(countRedraws, 0);
  const listedBodies = useContext(ListedBodiesContext);
  const [layout] = useState(
    () => new TableWindowLayout(body, offer.table, blockIndex, redraw, listedBodies),
  );
  layout.setTable(offer.table, blockIndex);
  layout.update();

  const heldColumns = layout.heldColumns;
  const measuring = layout.measuringFrame;
  // Fonts that loaded set the cells at other widths: the table is measured again while it draws
  // the columns it holds.
  useEffect(
    () =>
      layout.followFontLoads(() => {
        layout.forgetMeasurements();
        redraw();
      }),
    [layout],
  );
  // The table's geometry is filed as it last stood, for the mount that draws it next.
  useEffect(
    () => () => {
      layout.release();
    },
    [layout],
  );
  // A body that changed width wraps the cells anew: columns remembered at its width are taken
  // before the frame paints, and otherwise measured while the table keeps its widths.
  useEffect(
    () =>
      layout.followPlacement(() => {
        const columns = layout.heldColumns;
        const frame = layout.measuringFrame;
        layout.update();
        if (layout.heldColumns !== columns || layout.measuringFrame !== frame) {
          flushSync(redraw);
        }
      }),
    [layout],
  );

  const readRowCount = useCallback(() => layout.rowCount, [layout]);
  const pins = useSelectionPins(
    body.viewport,
    layout.getScrollElement,
    readRowCount,
    MARKDOWN_TABLE_ROW_INDEX_ATTRIBUTE,
  );
  const [revealedRowIndex, setRevealedRowIndex] = useState<number | undefined>(undefined);
  // The rows holding a selection's ends stay drawn; the rows between are copied from the text.
  const rangeExtractor = useCallback(
    (range: Range) =>
      withPinnedIndexes(
        defaultRangeExtractor(range),
        revealedRowIndex === undefined ? rangeEnds(pins) : [...rangeEnds(pins), revealedRowIndex],
        range.count,
      ),
    [pins, revealedRowIndex],
  );
  const onChange = useCallback(
    (instance: TableRowVirtualizer) => {
      if (layout.differsFromCommittedRows(instance.getVirtualItems(), instance.getTotalSize())) {
        redraw();
      }
    },
    [layout],
  );
  const [initialRect] = useState(() => layout.initialRect());

  const virtualizer = useVirtualizer<HTMLElement, HTMLElement>({
    count: layout.rowCount,
    // Laid out only once its columns are held: a row's estimate wraps its cells at their widths.
    enabled: heldColumns !== undefined,
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
    overscan: TABLE_WINDOW_OVERSCAN_ROWS,
    indexAttribute: MARKDOWN_TABLE_ROW_INDEX_ATTRIBUTE,
    // A geometry sample can arrive while React commits, where a synchronous flush only warns.
    useFlushSync: false,
    // With no container attached the adapter writes nothing to the page and re-renders only when
    // the drawn range changes; a row that moves a spacer redraws through `onChange`.
    directDomUpdates: true,
  });
  // The table follows the conversation's place and never moves it, however a row measures.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = refuseScrollAdjustment;

  useEffect(() => {
    layout.bindWindow(virtualizer, setRevealedRowIndex);
  }, [layout, virtualizer]);
  // Columns held anew wrap every row anew: each row's room is estimated again at their widths.
  const laidOutColumnsRef = useRef(heldColumns);
  useLayoutEffect(() => {
    if (laidOutColumnsRef.current !== heldColumns) {
      laidOutColumnsRef.current = heldColumns;
      virtualizer.measure();
    }
  });

  const rows =
    heldColumns === undefined
      ? []
      : layout.windowRows(virtualizer.getVirtualItems(), virtualizer.getTotalSize());
  useLayoutEffect(() => {
    layout.commitRows(rows);
  });

  return {
    heldColumns,
    drawsWhole: heldColumns === undefined && layout.bodyType !== undefined,
    measuring,
    readMeasuringFrame: layout.readMeasuringFrame,
    rows,
    attachBody: layout.attachBody,
    attachRow: virtualizer.measureElement,
  };
}

function countRedraws(count: number): number {
  return count + 1;
}
