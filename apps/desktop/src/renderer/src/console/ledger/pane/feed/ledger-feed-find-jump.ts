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
} from "../../structure/index.js";
import {
  chapterRunIdOf,
  jumpOutcomeRowId,
  type LedgerFindState,
  type LedgerJumpReach,
  useDeferredRowJump,
  useEventIdJumpOutcome,
  useLedgerFind,
  useLedgerJumpReach,
} from "../find/index.js";
import { type LedgerWindowModel, type VisibleLedgerWindow } from "../window/index.js";

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
  readonly visible: VisibleLedgerWindow;
  readonly openedTerminalRunIds: ReadonlySet<string>;
  readonly toggleChapter: (chapter: LedgerChapter) => void;
  readonly setFilter: (filter: LedgerFilter) => void;
  readonly endReplay: () => void;
  /** The ledger's ONE scroll writer. Nothing here touches an element. */
  readonly jumpToRow: (rowId: string) => void;
  readonly focusLedgerSurface: () => void;
}): LedgerFindAndJump {
  const {
    unfurledWindow,
    narrowedWindow,
    foldedWindow,
    visible,
    openedTerminalRunIds,
    toggleChapter,
    setFilter,
    endReplay,
    jumpToRow,
    focusLedgerSurface,
  } = inputs;

  const find = useLedgerFind(visible);
  // Classified against every stage between the log and the screen rather than
  // against the rows on it, so an id the fold, the replay or the cap took is not
  // reported as one the filter is hiding.
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
  const openChapterOfRow = useCallback(
    (row: TimelineRow) => {
      const chapterRunId = chapterRunIdOf(row, foldedWindow);
      const chapter =
        chapterRunId === undefined ? undefined : foldedWindow.chapterByHeaderKey.get(chapterRunId);
      if (chapter !== undefined) {
        // A toggle, and the arm that offers this act is only reachable while the
        // chapter is shut — `useLedgerJumpReach` withholds the offer otherwise, so
        // this never closes one.
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
    openChapterOfRow,
    endReplay,
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

/**
 * Conceal the replay dock when focus really leaves the rail, and not before.
 *
 * React backs `onBlur` with `focusout`, which BUBBLES, so tabbing from the rail's
 * slider to a dock button reaches the wrapper although focus never left it — and
 * concealing there makes the dock's controls vanish or be skipped mid-tab. A
 * related target the wrapper contains is that move.
 *
 * A NULL related target is focus leaving the document, and that IS a conceal rather
 * than an exemption: reading it as one would leave the dock open under a window
 * nobody is in. Do not "fix" this into a leak.
 */
export function useReplayDockConcealOnFocusLeaving(
  conceal: () => void,
): (event: React.FocusEvent<HTMLDivElement>) => void {
  return useCallback(
    (event: React.FocusEvent<HTMLDivElement>) => {
      if (
        event.relatedTarget instanceof Node &&
        event.currentTarget.contains(event.relatedTarget)
      ) {
        return;
      }
      conceal();
    },
    [conceal],
  );
}
