// The palette list's window: which rows the scroll position needs, at what offset, under what
// total height. Every match is a row; only the rows in view (plus the overscan) are drawn.

import { useImperativeHandle } from "react";
import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";

import { WINDOWED_ROW_INDEX_ATTRIBUTE } from "@renderer/lib/windowed-row-markers.js";
import type { PaletteListRow } from "../group-results.js";

/** The palette list's window, scrolled by the list element. */
export type PaletteRowWindow = Virtualizer<HTMLDivElement, HTMLElement>;

/** What the window is built over. */
export interface PaletteRowWindowOptions {
  readonly rows: readonly PaletteListRow[];
  readonly getScrollElement: () => HTMLDivElement | null;
  /** Receives the window so the combobox's highlight handler can scroll to a row. */
  readonly rowWindowRef: React.Ref<PaletteRowWindow | null>;
}

/** Builds the list's window and hands it to `rowWindowRef`. Rows are measured once drawn. */
export function usePaletteRowWindow(options: PaletteRowWindowOptions): PaletteRowWindow {
  const { rows } = options;
  const rowWindow = useVirtualizer<HTMLDivElement, HTMLElement>({
    count: rows.length,
    getScrollElement: options.getScrollElement,
    // Only a first guess: each drawn row is measured, so the sheet stays the one source of size.
    estimateSize: (rowIndex) =>
      rows[rowIndex]?.kind === "group-label" ? ESTIMATED_LABEL_HEIGHT_PX : ESTIMATED_ROW_HEIGHT_PX,
    overscan: OVERSCAN_ROWS,
    indexAttribute: WINDOWED_ROW_INDEX_ATTRIBUTE,
    // React 19 warns when a virtualizer flushes synchronously from a lifecycle method.
    useFlushSync: false,
  });
  useImperativeHandle(options.rowWindowRef, () => rowWindow, [rowWindow]);
  return rowWindow;
}

/** A category heading's first guess, in CSS pixels. */
const ESTIMATED_LABEL_HEIGHT_PX = 28;

/** A command row's first guess, in CSS pixels. */
const ESTIMATED_ROW_HEIGHT_PX = 36;

/** Rows drawn past each edge, so a quick flick or arrow press does not meet an undrawn band. */
const OVERSCAN_ROWS = 8;
