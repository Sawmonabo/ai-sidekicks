// What a long markdown body reads from the transcript viewport it is drawn in, to draw only the
// blocks near the reader. Outside a viewport there is none, and every body is drawn whole.

import { createContext, type Context } from "react";

import type { Unsubscribe } from "#shared/preload-api.js";
import { type ScrollController } from "#renderer/lib/scroll/chokepoint.js";
import { type DrawnBandScreenHeights } from "#renderer/features/transcript/viewport/drawn-band.js";

/** The conversation scroller as a windowed body lays its blocks against it. */
export interface MarkdownWindowViewport {
  /** The scroller's one writer, whose geometry the body follows; the body never writes it. */
  readonly scrollController: ScrollController;
  /**
   * A row's top edge in the scroller's content, in pixels, read when called and reading no
   * element; `undefined` when the viewport does not hold the row.
   */
  readonly rowStartPx: (rowKey: string) => number | undefined;
  /**
   * Whether the body holds the reader's place for a block that resized above the scroller's top,
   * which the conversation holds for a row wholly above it and for a following reader instead.
   */
  readonly holdsPlaceInsideRow: (rowKey: string) => boolean;
  /**
   * How far beyond each edge of the scroller the body draws its items, in screen heights, read
   * when called; the same object until a side changes.
   */
  readonly drawnBandScreenHeights: () => DrawnBandScreenHeights;
  /** Hears each change that may move what `drawnBandScreenHeights` answers. */
  readonly subscribeToDrawnBand: (listener: () => void) => Unsubscribe;
  /** Hears each selection change that moves what `readSelectionRange` answers. */
  readonly subscribeToSelection: (listener: () => void) => Unsubscribe;
  /**
   * The selection's range while it starts or ends inside the scroller and is more than a caret,
   * otherwise `undefined`. The blocks between its ends stay drawn, so copying it copies them.
   */
  readonly readSelectionRange: () => AbstractRange | undefined;
}

/**
 * The viewport a markdown body is drawn in, provided by the transcript viewport. `undefined`
 * outside one, where a body is drawn whole.
 */
export const MarkdownWindowViewportContext: Context<MarkdownWindowViewport | undefined> =
  createContext<MarkdownWindowViewport | undefined>(undefined);
