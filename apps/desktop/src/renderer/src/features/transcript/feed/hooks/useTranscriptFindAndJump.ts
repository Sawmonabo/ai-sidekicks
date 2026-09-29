// The find field, wired to the window it searches and the scroll writer its walk jumps
// through.
//
// SPLIT FROM `TranscriptFeed.tsx` FOR THE REASON THAT FILE SPLITS FROM THE PANE. The
// feed's job is arrangement: it composes the pipeline, mounts the pieces, and hands each
// of them what it needs. This is one of the seams between those pieces: the walk that
// jumps to each match, and the close that hands focus back to the log.
//
// WHAT IT DELIBERATELY DOES NOT OWN. The find state itself is `useTranscriptFind.ts`';
// this module holds only the wiring between it and this window's scroll writer and focus.

import { useCallback } from "react";

import { type TimelineRow } from "@ai-sidekicks/contracts";

import { type FindStepDirection } from "../../find/find-model.js";
import { type TranscriptFindState, useTranscriptFind } from "../../find/hooks/useTranscriptFind.js";
import { type VisibleTranscriptWindow } from "../../window/hooks/useVisibleTranscriptWindow.js";

/** Everything the find field needs, over one transcript. */
export interface TranscriptFindAndJump {
  /** The field's own state, also handed to the palette's acts. */
  readonly find: TranscriptFindState;
  /** Walk to the next or previous match, scrolling to it. */
  readonly onStep: (direction: FindStepDirection) => void;
  /** Close the field and put focus back on the log. */
  readonly onClose: () => void;
}

/** Wire the find field to the window it searches and the scroll writer it jumps through. */
export function useTranscriptFindAndJump(inputs: {
  /** What the run group fold reported withholding, for the count beside the field. */
  readonly foldedAwayRows: readonly TimelineRow[];
  readonly visible: VisibleTranscriptWindow;
  /** The transcript's ONE scroll writer. Nothing here touches an element. */
  readonly jumpToRow: (rowId: string) => void;
  readonly focusTranscriptViewport: () => void;
}): TranscriptFindAndJump {
  const { foldedAwayRows, visible, jumpToRow, focusTranscriptViewport } = inputs;

  // Every stage, not just the rows on screen: what the walk cannot reach is counted
  // under the name of the stage holding it, each reported by the stage that removed it
  // rather than re-derived here from a pair of windows.
  const find = useTranscriptFind({ visible, foldedAwayRows });

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
    // The field took focus when it opened, and it is unmounted by the close — so
    // without this focus falls to `body` and the next Tab restarts from the top of
    // the document, well away from the log somebody was reading.
    focusTranscriptViewport();
  }, [closeFind, focusTranscriptViewport]);

  return { find, onStep, onClose };
}
