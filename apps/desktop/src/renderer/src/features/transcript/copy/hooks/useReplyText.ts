import { useCallback, useContext } from "react";

import { RowRevealContext } from "../../reveal/components/RowRevealProvider.js";
import { PART_SEPARATOR } from "../conversation-selection.js";

/** What a reply's foot reads of the whole reply's text. */
export interface ReplyText {
  /**
   * The whole reply's text, for its Copy: each of the reply's rows that has text, in log order,
   * joined by a blank line.
   */
  readonly read: () => string;
  /** Whether any of the reply's rows has text now, so its Copy has something to take. */
  readonly hasText: boolean;
  /**
   * Whether any of the reply's rows has had text, even text since dropped, so the foot and its
   * time stay once drawn.
   */
  readonly hasHadText: boolean;
}

/**
 * The text of a whole reply. The row asking supplies its own text; every other row's comes from
 * the text the transcript is drawing for it.
 */
export function useReplyText(
  replyRowIds: readonly string[],
  ownRowId: string,
  ownText: string | undefined,
): ReplyText {
  const revealChannel = useContext(RowRevealContext);
  const textOf = useCallback(
    (rowId: string) => (rowId === ownRowId ? ownText : revealChannel?.publishedTextFor(rowId)),
    [ownRowId, ownText, revealChannel],
  );
  const read = useCallback(
    () =>
      replyRowIds
        .map(textOf)
        .filter((text): text is string => text !== undefined && text !== "")
        .join(PART_SEPARATOR),
    [replyRowIds, textOf],
  );
  const hasText = replyRowIds.some((rowId) => {
    const text = textOf(rowId);
    return text !== undefined && text !== "";
  });
  return {
    read,
    hasText,
    hasHadText:
      hasText || replyRowIds.some((rowId) => revealChannel?.hasPublishedText(rowId) === true),
  };
}
