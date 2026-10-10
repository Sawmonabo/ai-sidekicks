// The conversation scroller as the long bodies in its rows read it: its one scroll writer, where
// each row starts, and the selection inside it, held as one value for the scroller's life.

import { useMemo, type ReactNode } from "react";

import type { Unsubscribe } from "#shared/preload-api.js";
import type { ScrollController } from "#renderer/lib/scroll/chokepoint.js";
import { TranscriptBodyViewportContext, type TranscriptBodyViewport } from "./context.js";

/** The selection inside the scroller, as a body reads it: heard on each change, read when asked. */
export interface ScrollerSelection {
  readonly subscribe: (listener: () => void) => Unsubscribe;
  /** The selection's range while it starts or ends inside the scroller, otherwise `undefined`. */
  readonly selectionRange: AbstractRange | undefined;
}

/** What the scroller's bodies read, and the tree they are drawn in. */
export interface TranscriptBodyViewportProviderProps {
  readonly scrollController: ScrollController;
  readonly rowStartPx: TranscriptBodyViewport["rowStartPx"];
  readonly selection: ScrollerSelection;
  readonly children: ReactNode;
}

/**
 * Gives the long bodies under it the scroller they are drawn in. The value changes only with the
 * scroll writer, the row geometry or the selection's source, so a mounted body keeps the one it
 * read.
 */
export function TranscriptBodyViewportProvider(
  props: TranscriptBodyViewportProviderProps,
): React.JSX.Element {
  const { scrollController, rowStartPx, selection } = props;
  const viewport = useMemo<TranscriptBodyViewport>(
    () => ({
      scrollController,
      rowStartPx,
      subscribeToSelection: (listener) => selection.subscribe(listener),
      readSelectionRange: () => selection.selectionRange,
    }),
    [scrollController, rowStartPx, selection],
  );
  return (
    <TranscriptBodyViewportContext value={viewport}>{props.children}</TranscriptBodyViewportContext>
  );
}
