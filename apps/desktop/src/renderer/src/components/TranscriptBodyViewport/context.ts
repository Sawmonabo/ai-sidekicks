// What a long body in a transcript row reads from the viewport it is drawn in, to draw only what is
// near the reader: a markdown reply, a long table, a command output or a diff opened whole. Each is
// a window nested in its row, drawing its items within the conversation's own drawn band. Outside a
// viewport there is none.

import { createContext, type Context } from "react";

import type { Unsubscribe } from "#shared/preload-api.js";
import { type ScrollController } from "#renderer/lib/scroll/chokepoint.js";
import { type DrawnBandScreenHeights } from "#renderer/lib/scroll/window-side.js";

/** The conversation scroller as a long body in one of its rows lays itself against it. */
export interface TranscriptBodyViewport {
  /**
   * The scroller's one writer, whose geometry a body follows. A body writes it only to hold the
   * reader's place through items it resized above them.
   */
  readonly scrollController: ScrollController;
  /**
   * A row's top edge in the scroller's content, in pixels, read when called and reading no
   * element; `undefined` when the viewport does not hold the row.
   */
  readonly rowStartPx: (rowKey: string) => number | undefined;
  /**
   * A row's bottom edge in the scroller's content, in pixels, at the height the conversation lays
   * it out at, measured or estimated, read when called and reading no element; `undefined` when
   * the viewport does not hold the row.
   */
  readonly rowEndPx: (rowKey: string) => number | undefined;
  /**
   * Whether the body holds the reader's place for a block that resized above the scroller's top,
   * which the conversation holds for a row wholly above it and for a following reader instead.
   */
  readonly holdsPlaceInsideRow: (rowKey: string) => boolean;
  /** Hears each selection change that moves what `readSelectionRange` answers. */
  readonly subscribeToSelection: (listener: () => void) => Unsubscribe;
  /**
   * The selection's range while it starts or ends inside the scroller and is more than a caret,
   * otherwise `undefined`. The blocks between its ends stay drawn, so copying it copies them.
   */
  readonly readSelectionRange: () => AbstractRange | undefined;
}

/**
 * The viewport a long body is drawn in, provided by the transcript viewport. `undefined` outside
 * one, where a body is drawn whole.
 */
export const TranscriptBodyViewportContext: Context<TranscriptBodyViewport | undefined> =
  createContext<TranscriptBodyViewport | undefined>(undefined);

/**
 * How far beyond each edge of the scroller a windowed body draws its items, in screen heights, as
 * the viewport's render draws its rows; the same object until a side changes. Apart from the
 * viewport's value, so a band that moves draws again only the windows that read it, in the same
 * render as the rows. `undefined` outside a viewport.
 */
export const DrawnBandContext: Context<DrawnBandScreenHeights | undefined> = createContext<
  DrawnBandScreenHeights | undefined
>(undefined);
