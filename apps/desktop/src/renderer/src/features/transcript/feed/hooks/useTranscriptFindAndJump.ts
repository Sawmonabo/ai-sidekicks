// The find field, wired to the rows it searches and the scroll writer its walk jumps through:
// the walk that jumps to each match, and the close that hands focus back to the log. The find
// state itself is `useTranscriptFind.ts`; this holds only the wiring.

import { useCallback } from "react";

import { type FindStepDirection } from "../../find/matcher.js";
import { type TranscriptRowRenderer } from "../../rows/renderer.js";
import { type SystemMessageReading } from "../../system-messages/classifier.js";
import { type TranscriptFindState, useTranscriptFind } from "../../find/hooks/useTranscriptFind.js";
import type { ProjectedTranscriptRow } from "#renderer/store/session/entities/vocabulary.js";

/** Everything the find field needs, over one transcript. */
export interface TranscriptFindAndJump {
  /** The field's own state, also handed to the palette's acts. */
  readonly find: TranscriptFindState;
  /** Walk to the next or previous match, scrolling to it. */
  readonly onStep: (direction: FindStepDirection) => void;
  /** Close the field and put focus back on the log. */
  readonly onClose: () => void;
  /** Whether the feed shows its rows, which the walk searches only once they are. */
  readonly areRowsShown: boolean;
}

/** Wire the find field to the rows it searches and the scroll writer it jumps through. */
export function useTranscriptFindAndJump(inputs: {
  /** What the run group fold reported withholding, for the count beside the field. */
  readonly foldedAwayRows: readonly ProjectedTranscriptRow[];
  /** The unfurled window's system messages, which the feed always draws, folded or not. */
  readonly systemMessageByRowId: ReadonlyMap<string, SystemMessageReading>;
  /**
   * The renderer's answer to whether it draws a row, so a folded row it would not is not counted.
   */
  readonly drawsBody: TranscriptRowRenderer["drawsBody"];
  /** The rows the feed draws, in log order, whether or not the viewport's window holds them. */
  readonly rows: readonly ProjectedTranscriptRow[];
  /**
   * Whether the feed shows its rows. Until it does, nothing hidden is found or counted, folded
   * rows included, and the field claims no count.
   */
  readonly areRowsShown: boolean;
  /** The transcript's ONE scroll writer, which lands on a row its window let go. */
  readonly jumpToRow: (rowId: string) => void;
  readonly focusTranscriptViewport: () => void;
}): TranscriptFindAndJump {
  const { systemMessageByRowId, drawsBody, areRowsShown } = inputs;
  const { jumpToRow, focusTranscriptViewport } = inputs;

  // What the fold withholds is counted as that stage reported it rather than re-derived here.
  const find = useTranscriptFind({
    rows: areRowsShown ? inputs.rows : NO_ROWS,
    foldedAwayRows: areRowsShown ? inputs.foldedAwayRows : NO_ROWS,
    systemMessageByRowId,
    drawsBody,
  });

  const onStep = useCallback(
    (direction: FindStepDirection) => {
      const step = find.step(direction);
      if (step !== undefined) {
        jumpToRow(step.match.rowId);
      }
    },
    [find, jumpToRow],
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

/** What the walk and the folded count see while the rows are hidden. */
const NO_ROWS: readonly ProjectedTranscriptRow[] = [];
