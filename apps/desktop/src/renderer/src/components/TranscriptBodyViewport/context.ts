// What a long body in a transcript row reads from the viewport it is drawn in: a markdown reply,
// to draw only the blocks near the reader, and a diff opened whole, to keep the reader still as
// its rows first lay out above them. Outside a viewport there is none.

import { createContext, type Context } from "react";

import type { Unsubscribe } from "#shared/preload-api.js";
import { type ScrollController } from "#renderer/lib/scroll/chokepoint.js";

/** The conversation scroller as a long body in one of its rows lays itself against it. */
export interface TranscriptBodyViewport {
  /**
   * The scroller's one writer, whose geometry a body follows. A markdown body never writes it; a
   * diff writes it only to take back what its rows grew above the reader.
   */
  readonly scrollController: ScrollController;
  /**
   * A row's top edge in the scroller's content, in pixels, read when called and reading no
   * element; `undefined` when the viewport does not hold the row.
   */
  readonly rowStartPx: (rowKey: string) => number | undefined;
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
 * one, where a markdown body is drawn whole.
 */
export const TranscriptBodyViewportContext: Context<TranscriptBodyViewport | undefined> =
  createContext<TranscriptBodyViewport | undefined>(undefined);
