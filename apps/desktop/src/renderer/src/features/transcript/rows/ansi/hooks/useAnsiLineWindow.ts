import { useState } from "react";

import { type TranscriptBodyViewport } from "#renderer/components/TranscriptBodyViewport/context.js";
import {
  useMeasuredItemWindow,
  type MeasuredItemWindowView,
} from "#renderer/components/TranscriptBodyViewport/hooks/useMeasuredItemWindow.js";
import { chunkTextOf, type AnsiLineChunkList } from "../lines/chunks.js";
import { ANSI_LINE_CHUNK_INDEX_ATTRIBUTE } from "../lines/markers.js";
import { AnsiLineWindowLayout } from "../lines/window-layout.js";

/** A command output's window over its chunks of lines, as one render draws it. */
export interface AnsiLineWindow extends MeasuredItemWindowView {
  /** The output's layout: its lines' element, and the measurement of its chunks off screen. */
  readonly layout: AnsiLineWindowLayout;
}

/**
 * One command output's window over its chunks of lines: only the chunks near the scroller's
 * viewport are drawn, plus the chunks holding the reader's selection's ends; the chunks between
 * them are copied from the text. `viewport` and `rowKey` are held for the window's life, and a
 * new generation of chunks takes a new window.
 */
export function useAnsiLineWindow(
  chunks: AnsiLineChunkList,
  viewport: TranscriptBodyViewport,
  rowKey: string,
): AnsiLineWindow {
  const [layout] = useState(() => new AnsiLineWindowLayout(viewport, rowKey, chunks));
  layout.setChunks(chunks);
  const view = useMeasuredItemWindow({
    window: layout.window,
    viewport,
    itemCount: chunks.count,
    isLaidOut: layout.isLaidOut,
    readTypeOnMount: layout.readTypeOnMount,
    // Two chunks' lines run past a quarter of the flow, so a long output's cut reads it running
    // past from the first frame.
    firstDrawnCount: FIRST_DRAWN_CHUNK_COUNT,
    estimateSize: layout.estimateSize,
    getScrollElement: layout.getScrollElement,
    indexAttribute: ANSI_LINE_CHUNK_INDEX_ATTRIBUTE,
    // Each chunk's text ends its own lines.
    itemText: (index) => chunkTextOf(chunks.chunkAt(index)),
    itemSeparator: "",
    revision: chunks,
  });
  return { ...view, layout };
}

/** How many chunks the first render draws. */
const FIRST_DRAWN_CHUNK_COUNT = 2;
