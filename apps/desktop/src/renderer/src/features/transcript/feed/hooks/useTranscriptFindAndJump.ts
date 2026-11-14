// The find field, wired to the rows it searches and the scroll writer its walk jumps through:
// the walk that jumps to each match, and the close that hands focus back to the log. The find
// state itself is `useTranscriptFind.ts`; this holds only the wiring.

import { useCallback, useLayoutEffect, useRef } from "react";

import { type FindStepDirection } from "../../find/matcher.js";
import { type SystemMessageReading } from "../../system-messages/classifier.js";
import { type TranscriptFindState, useTranscriptFind } from "../../find/hooks/useTranscriptFind.js";
import type { ProjectedTranscriptRow } from "#renderer/store/session/entities/vocabulary.js";

/** Everything the find field needs, over one transcript. */
export interface TranscriptFindAndJump {
  /** The field's own state, also handed to the palette's acts. */
  readonly find: TranscriptFindState;
  /** Walk to the next or previous match, opening what hides it and scrolling to it. */
  readonly onStep: (direction: FindStepDirection) => void;
  /** Close the field and put focus back on the log. */
  readonly onClose: () => void;
  /** Whether the feed shows its rows, which the walk searches only once they are. */
  readonly areRowsShown: boolean;
}

/** Wire the find field to the rows it searches and the scroll writer it jumps through. */
export function useTranscriptFindAndJump(inputs: {
  /** The unfurled window's system messages, whose line a match in one reads. */
  readonly systemMessageByRowId: ReadonlyMap<string, SystemMessageReading>;
  /** Every row the window holds, in log order, folded away or not. */
  readonly rows: readonly ProjectedTranscriptRow[];
  /** Whether the feed shows its rows. Until it does, nothing is found and no count is claimed. */
  readonly areRowsShown: boolean;
  /** Opens what hides a row; answers whether it was hidden. */
  readonly unfoldRow: (rowId: string) => boolean;
  /** The transcript's ONE scroll writer, which lands on a row its window let go. */
  readonly jumpToRow: (rowId: string) => void;
  readonly focusTranscriptViewport: () => void;
}): TranscriptFindAndJump {
  const { systemMessageByRowId, areRowsShown } = inputs;
  const { unfoldRow, jumpToRow, focusTranscriptViewport } = inputs;

  const find = useTranscriptFind({
    rows: areRowsShown ? inputs.rows : NO_ROWS,
    systemMessageByRowId,
  });

  // A match a fold hid is landed on in the commit of the step that opened it, the first whose
  // viewport holds its row; the step's own render is that commit, so nothing lands later.
  const unfoldedMatchRowId = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const rowId = unfoldedMatchRowId.current;
    if (rowId !== undefined) {
      unfoldedMatchRowId.current = undefined;
      jumpToRow(rowId);
    }
  });

  const onStep = useCallback(
    (direction: FindStepDirection) => {
      const step = find.step(direction);
      if (step === undefined) {
        return;
      }
      if (unfoldRow(step.match.rowId)) {
        unfoldedMatchRowId.current = step.match.rowId;
      } else {
        jumpToRow(step.match.rowId);
      }
    },
    [find, unfoldRow, jumpToRow],
  );

  const closeFind = find.close;
  const onClose = useCallback(() => {
    closeFind();
    // The field took focus when it opened and is unmounted by the close; without this focus falls
    // to `body` and the next Tab restarts from the top of the document.
    focusTranscriptViewport();
  }, [closeFind, focusTranscriptViewport]);

  return { find, onStep, onClose, areRowsShown };
}

/** What the walk sees while the rows are hidden. */
const NO_ROWS: readonly ProjectedTranscriptRow[] = [];
