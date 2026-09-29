// The find field and the jump-by-id, wired to the window they are asked about.
//
// SPLIT FROM `LedgerFeed.tsx` FOR THE REASON THAT FILE SPLITS FROM THE PANE. The
// feed's job is arrangement: it composes the pipeline, mounts the pieces, and hands
// each of them what it needs. This is one of the four seams between those pieces,
// and it is the only one that is a small system of its own — a query, a
// classification against four narrowings, the act that answer deserves, and a jump
// that has to outlive the render it was asked in. Read inside the arrangement it was
// forty lines of callbacks between two elements; read here it is one subject.
//
// WHAT IT DELIBERATELY DOES NOT OWN. The find state itself is `ledger-find.ts`', the
// classification is `ledger/structure/narrowing/filters.ts`', the act table and the deferred
// request are `ledger-jump.ts`'. This module holds only the WIRING those four need
// to reach each other over one ledger — which acts exist, and what each of them does
// to this window — so nothing here decides anything twice.

import { useCallback } from "react";

import { type TimelineRow } from "@ai-sidekicks/contracts";

import {
  UNFILTERED_LEDGER,
  type FindStepDirection,
  type LedgerChapter,
  type LedgerFilter,
  type LedgerJumpOutcome,
} from "@renderer/console/ledger/structure/index.js";
import {
  chapterRunIdInWindow,
  jumpOutcomeRowId,
  type LedgerJumpReach,
  useDeferredRowJump,
  useEventIdJumpOutcome,
  useLedgerJumpReach,
} from "@renderer/console/ledger/pane/find/ledger-jump.js";
import { type LedgerFindState, useLedgerFind } from "../../find/hooks/useTranscriptFind.js";
import { type LedgerWindowModel } from "../../window/transcript-window.js";
import { type VisibleLedgerWindow } from "../../window/hooks/useVisibleTranscriptWindow.js";

/** Everything the find field and the jump notice need, over one ledger. */
export interface LedgerFindAndJump {
  /** The field's own state, also handed to the palette's acts. */
  readonly find: LedgerFindState;
  /** Which narrowing is hiding the row the query names, if the query names one. */
  readonly outcome: LedgerJumpOutcome | undefined;
  /** The act that reaches it over THIS ledger, where one exists. */
  readonly reach: LedgerJumpReach | undefined;
  /** Walk to the next or previous match, scrolling to it. */
  readonly onStep: (direction: FindStepDirection) => void;
  /** Close the field and put focus back on the log. */
  readonly onClose: () => void;
}

/**
 * Wire the field, the classification, the act, and the deferred jump together.
 *
 * THE THREE WINDOWS ARE NOT A CONVENIENCE. The classification's answer is not
 * whether the row is on screen but WHICH narrowing is the reason it is not, so it
 * takes every stage between the loaded log and the viewport — and taking fewer is
 * exactly how every absence after the filter came to be reported as the filter's.
 */
export function useLedgerFindAndJump(inputs: {
  readonly unfurledWindow: LedgerWindowModel;
  readonly narrowedWindow: LedgerWindowModel;
  readonly foldedWindow: LedgerWindowModel;
  /** What the narrowing stage reported removing, for the count beside the field. */
  readonly filteredAwayRows: readonly TimelineRow[];
  /** What the chapter fold reported withholding, for the count beside the field. */
  readonly foldedAwayRows: readonly TimelineRow[];
  readonly visible: VisibleLedgerWindow;
  readonly openedTerminalRunIds: ReadonlySet<string>;
  readonly toggleChapter: (chapter: LedgerChapter) => void;
  readonly setFilter: (filter: LedgerFilter) => void;
  /** The ledger's ONE scroll writer. Nothing here touches an element. */
  readonly jumpToRow: (rowId: string) => void;
  readonly focusLedgerSurface: () => void;
}): LedgerFindAndJump {
  const {
    unfurledWindow,
    narrowedWindow,
    foldedWindow,
    filteredAwayRows,
    foldedAwayRows,
    visible,
    openedTerminalRunIds,
    toggleChapter,
    setFilter,
    jumpToRow,
    focusLedgerSurface,
  } = inputs;

  // Every stage, not just the rows on screen: what the walk cannot reach is counted
  // under the name of the narrowing holding it, each reported by the stage that
  // performed it rather than re-derived here from a pair of windows.
  const find = useLedgerFind({ visible, filteredAwayRows, foldedAwayRows });
  // Classified against every stage between the log and the screen rather than
  // against the rows on it, so an id the fold or the cap took is not reported as one
  // the filter is hiding.
  const outcome = useEventIdJumpOutcome({
    unfurledWindow,
    narrowedWindow,
    foldedWindow,
    visible,
    query: find.query.trim(),
  });

  // The act each absence deserves cannot itself jump — every one of them widens the
  // window on the next render — so the jump is requested and spent when the row is
  // one the viewport holds.
  const requestJump = useDeferredRowJump({
    visibleRows: visible.rows,
    jumpToRow,
    // The request dies with the question that asked it: a held jump whose row the
    // field no longer names would scroll the ledger away long after the person who
    // asked closed the field.
    questionRowId: jumpOutcomeRowId(outcome),
  });

  const clearFilter = useCallback(() => {
    setFilter(UNFILTERED_LEDGER);
  }, [setFilter]);
  // Offered only for a shut chapter, so toggling it opens it.
  const openFoldsHoldingRow = useCallback(
    (row: TimelineRow) => {
      const chapterRunId = chapterRunIdInWindow(row, foldedWindow);
      const chapter =
        chapterRunId === undefined ? undefined : foldedWindow.chapterByHeaderKey.get(chapterRunId);
      if (chapter !== undefined) {
        toggleChapter(chapter);
      }
    },
    [foldedWindow, toggleChapter],
  );
  const reach = useLedgerJumpReach({
    outcome,
    foldedWindow,
    openedTerminalRunIds,
    clearFilter,
    openFoldsHoldingRow,
    requestJump,
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
    // The field took focus when it opened, and it is unmounted by the close — so
    // without this focus falls to `body` and the next Tab restarts from the top of
    // the document, well away from the log somebody was reading.
    focusLedgerSurface();
  }, [closeFind, focusLedgerSurface]);

  return { find, outcome, reach, onStep, onClose };
}
