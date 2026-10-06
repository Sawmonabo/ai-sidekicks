import { useCallback, useContext, useEffect, useSyncExternalStore } from "react";

import type { Unsubscribe } from "#shared/preload-api.js";
import { RowRevealContext } from "../../reveal/components/RowRevealProvider.js";
import { PART_SEPARATOR, type CopyFlavor } from "../conversation-selection.js";
import { replyCopyFlavorOf, type DrawnRowText } from "../drawn-reply-text.js";

/** What a reply's foot reads of the whole reply's text. */
export interface ReplyText {
  /**
   * The whole reply's text, for its Copy: each of the reply's rows that has drawn text, in log
   * order, joined by a blank line.
   */
  readonly read: () => string;
  /**
   * Whether any of the reply's rows has drawn text, even text since dropped from its row, so the
   * foot, its time and its Copy stay for the rest of the turn once drawn.
   */
  readonly hasText: boolean;
  /** Markdown when any of the reply's rows is drawn as prose, plain text otherwise. */
  readonly flavor: CopyFlavor;
}

/** Nothing to unsubscribe from, outside a transcript. Module-scope, so subscribe stays stable. */
const NO_DRAWN_TEXT_SUBSCRIPTION: Unsubscribe = () => {};

/**
 * The text of a whole reply. The row asking supplies its own drawn text, and records it so the
 * foot keeps it once this row unmounts; every other row's is the text the transcript is drawing
 * for it now, else what it drew before.
 */
export function useReplyText(
  replyRowIds: readonly string[],
  ownRowId: string,
  own: DrawnRowText | undefined,
): ReplyText {
  const revealChannel = useContext(RowRevealContext);
  const drawnReplyText = revealChannel?.drawnReplyText;
  const ownText = own?.text;
  const ownFlavor = own?.flavor;
  useEffect(() => {
    if (ownText !== undefined && ownFlavor !== undefined) {
      drawnReplyText?.note(ownRowId, { text: ownText, flavor: ownFlavor });
    }
  }, [drawnReplyText, ownRowId, ownText, ownFlavor]);
  const subscribe = useCallback(
    (onChange: () => void): Unsubscribe =>
      drawnReplyText === undefined
        ? NO_DRAWN_TEXT_SUBSCRIPTION
        : drawnReplyText.subscribe(onChange),
    [drawnReplyText],
  );
  // A row elsewhere in the reply gaining its first text re-renders this foot through the record.
  useSyncExternalStore(subscribe, () => drawnReplyText?.revision ?? 0);

  const partOf = useCallback(
    (rowId: string): DrawnRowText | undefined => {
      if (rowId === ownRowId && ownText !== undefined && ownText !== "") {
        return own;
      }
      const recorded = drawnReplyText?.drawnTextOf(rowId);
      const live = revealChannel?.publishedTextFor(rowId);
      if (live !== undefined) {
        return { text: live, flavor: recorded?.flavor ?? replyCopyFlavorOf(live) };
      }
      return recorded;
    },
    [drawnReplyText, own, ownRowId, ownText, revealChannel],
  );
  const parts = drawnPartsOf(replyRowIds, partOf);
  const read = useCallback(
    () =>
      drawnPartsOf(replyRowIds, partOf)
        .map((part) => part.text)
        .join(PART_SEPARATOR),
    [replyRowIds, partOf],
  );
  return {
    read,
    hasText: parts.length > 0,
    flavor: parts.some((part) => part.flavor === "markdown") ? "markdown" : "text",
  };
}

function drawnPartsOf(
  replyRowIds: readonly string[],
  partOf: (rowId: string) => DrawnRowText | undefined,
): readonly DrawnRowText[] {
  return replyRowIds
    .map(partOf)
    .filter((part): part is DrawnRowText => part !== undefined && part.text !== "");
}
