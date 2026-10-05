import { useCallback, useContext } from "react";

import { RowRevealContext } from "../../reveal/components/RowRevealProvider.js";
import { PART_SEPARATOR } from "../conversation-selection.js";

/**
 * A reader of a whole reply's text, for its Copy: each of the reply's rows that has text, in log
 * order, joined by a blank line. The row asking supplies its own text; every other row's comes
 * from the text the transcript is drawing for it.
 */
export function useReplyText(
  replyRowIds: readonly string[],
  ownRowId: string,
  ownText: string | undefined,
): () => string {
  const revealChannel = useContext(RowRevealContext);
  return useCallback(
    () =>
      replyRowIds
        .map((rowId) => (rowId === ownRowId ? ownText : revealChannel?.publishedTextFor(rowId)))
        .filter((text): text is string => text !== undefined && text !== "")
        .join(PART_SEPARATOR),
    [replyRowIds, ownRowId, ownText, revealChannel],
  );
}
