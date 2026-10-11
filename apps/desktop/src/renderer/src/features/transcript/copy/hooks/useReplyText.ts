import { useCallback, useContext, useEffect, useSyncExternalStore } from "react";

import type { Unsubscribe } from "#shared/preload-api.js";
import { joinIntoPieces, type PiecedText } from "#renderer/lib/text-pieces.js";
import { RowRevealContext } from "../../reveal/components/RowRevealProvider.js";
import { type CopyFlavor } from "#renderer/components/Markdown/drawn-text.js";
import { PART_SEPARATOR } from "../conversation-selection.js";
import { type DrawnRowText } from "../drawn-reply-text.js";
import { replyRowTextOf } from "../row-text.js";

/** What a reply's foot reads of the whole reply's text. */
export interface ReplyText {
  /**
   * The whole reply's text, for its Copy: each of the reply's rows that has drawn text, in log
   * order, a blank line between each, held in pieces. Built when called, for the copy alone.
   */
  readonly read: () => PiecedText;
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
  const partOf = useCallback(
    (rowId: string): DrawnRowText | undefined => {
      if (rowId === ownRowId && ownText !== undefined && ownText.length > 0) {
        return own;
      }
      return revealChannel === undefined ? undefined : replyRowTextOf(rowId, revealChannel);
    },
    [own, ownRowId, ownText, revealChannel],
  );
  // A row elsewhere in the reply gaining its first text re-renders this foot through the record;
  // a change to another reply's rows, which the record also announces, leaves it alone.
  const drawnFlavor = useSyncExternalStore(
    subscribe,
    useCallback(() => drawnFlavorOf(drawnPartsOf(replyRowIds, partOf)), [replyRowIds, partOf]),
  );
  const read = useCallback(
    () =>
      joinIntoPieces(
        drawnPartsOf(replyRowIds, partOf)
          .flatMap((part) => [PART_SEPARATOR, ...part.text.chunks()])
          .slice(1),
      ),
    [replyRowIds, partOf],
  );
  return {
    read,
    hasText: drawnFlavor !== undefined,
    flavor: drawnFlavor ?? "text",
  };
}

/** How a reply with these drawn parts copies, or `undefined` when it has none. */
function drawnFlavorOf(parts: readonly DrawnRowText[]): CopyFlavor | undefined {
  if (parts.length === 0) {
    return undefined;
  }
  return parts.some((part) => part.flavor === "markdown") ? "markdown" : "text";
}

function drawnPartsOf(
  replyRowIds: readonly string[],
  partOf: (rowId: string) => DrawnRowText | undefined,
): readonly DrawnRowText[] {
  return replyRowIds
    .map(partOf)
    .filter((part): part is DrawnRowText => part !== undefined && part.text.length > 0);
}
