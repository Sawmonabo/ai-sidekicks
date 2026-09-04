// Stage three of the feed's pipeline read backwards: an id, and which narrowing is
// the reason it is not on screen.
//
// THE CLASSIFICATION AND THE ACT ARE TWO HALVES OF ONE THING, and they are here
// together because separating them is what made the surface dishonest. The
// classifier used to be asked one question — is this id in the rows the viewport
// holds — over a set four narrowings deep, so a row folded into a chapter, a row a
// replay was holding back, and a row the cap had taken all came back as the one
// arm that had a name: hidden by the filter. The ledger then offered to clear a
// filter that was not on.
//
// So the stages are named to the classifier in the order the feed applies them,
// and the act each answer deserves is resolved here from the same stage set. An
// arm whose act cannot reach the row gets no act — the cap took those rows and no
// read this console holds fetches them back — rather than a button that reports
// success and scrolls nothing.
//
// AND THE ACT CANNOT JUMP, WHICH IS WHY THE JUMP IS DEFERRED. Clearing a filter,
// opening a chapter and ending a replay all widen the window on the NEXT render;
// the viewport's `jumpToRow` reads the snapshot of the render it was built in, so
// performing the act and jumping in one handler jumps against the window that was
// still hiding the row. The request is held instead, and spent the moment the row
// is one the viewport holds — which also makes a chain honest: an act that removes
// one narrowing and leaves another re-states the next absence, and the held
// request survives to the end of it.

import { useCallback, useEffect, useMemo, useState } from "react";

import { type TimelineRow } from "@ai-sidekicks/contracts";

import {
  jumpToEventId,
  type LedgerJumpOutcome,
  type LedgerJumpStages,
} from "../../ledger/structure/index.js";
import { type LedgerWindowModel } from "./ledger-window.js";
import { type VisibleLedgerWindow } from "./ledger-visible-window.js";

/** What one arm offers, when there is an act that reaches the row. */
export interface LedgerJumpReach {
  /** The button's words — the act, named for what it does to this ledger. */
  readonly label: string;
  /** Perform it. The jump itself is the deferred request, not this. */
  readonly perform: () => void;
}

/**
 * Classify one event id against every stage between the loaded log and the screen.
 *
 * `undefined` for an empty query, which is a field nobody has typed in rather than
 * an id nothing carries — the two used to share the `outside-window` arm, so the
 * arm that should have said "no entry here carries that id" was the arm that had
 * to render nothing.
 *
 * Memoized and short-circuited on the empty query: this is a scan of the whole
 * loaded window, and the field is closed for most of a ledger's life.
 */
export function useEventIdJumpOutcome(inputs: {
  readonly unfurledWindow: LedgerWindowModel;
  readonly narrowedWindow: LedgerWindowModel;
  readonly foldedWindow: LedgerWindowModel;
  readonly visible: VisibleLedgerWindow;
  readonly query: string;
}): LedgerJumpOutcome | undefined {
  const { unfurledWindow, narrowedWindow, foldedWindow, visible, query } = inputs;
  return useMemo(() => {
    if (query.length === 0) {
      return undefined;
    }
    // Each stage names what IT kept, in the feed's own order. The two windows
    // answer through their own row tables and the two later stages through the
    // sets the visible-window partition was decided by, so no membership here is
    // a second copy of one held elsewhere.
    const stages: LedgerJumpStages = {
      "hidden-by-filter": narrowedWindow.rowsByKey,
      "folded-into-chapter": foldedWindow.rowsByKey,
      "withheld-by-replay": visible.revealedRowKeys,
      "outside-window": visible.heldRowKeys,
    };
    return jumpToEventId(unfurledWindow.rows, stages, query);
  }, [unfurledWindow, narrowedWindow, foldedWindow, visible, query]);
}

/**
 * Hold a jump until the row it names is one the viewport holds, then spend it.
 *
 * ONE REQUEST AT A TIME, last one wins: a second ask is a person having changed
 * their mind, and queueing the first would scroll them somewhere they had already
 * moved on from. A request whose row never becomes reachable simply never spends —
 * it costs one comparison per reconcile and nothing else, and there is deliberately
 * no timeout, because a deadline here would abandon a jump exactly when a slow
 * widening finally delivered the row.
 */
export function useDeferredRowJump(
  visibleRows: readonly TimelineRow[],
  jumpToRow: (rowId: string) => void,
): (rowId: string) => void {
  const [requestedRowId, setRequestedRowId] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (requestedRowId === undefined) {
      return;
    }
    if (!visibleRows.some((row) => row.id === requestedRowId)) {
      return;
    }
    // Cleared before the jump, so a scroll that republishes the snapshot re-runs
    // this effect against no request rather than jumping a second time.
    setRequestedRowId(undefined);
    jumpToRow(requestedRowId);
  }, [requestedRowId, visibleRows, jumpToRow]);
  return useCallback((rowId: string) => {
    setRequestedRowId(rowId);
  }, []);
}

/**
 * The act each absence deserves over THIS ledger, or `undefined` where none exists.
 *
 * Resolved per outcome rather than per absence because two of the arms are only
 * conditionally reachable, and offering an act that cannot work is the defect this
 * whole module exists to remove:
 *
 *   • A row the fold dropped is reachable by opening its chapter — unless the
 *     chapter is already OPEN and the row sits past the chapter's own row cap, in
 *     which case toggling would close the chapter and take the rest of the run
 *     off screen too.
 *   • A row the cap took is reachable by nothing. This console subscribes to the
 *     log and holds no read that fetches a range of it, so the honest surface is
 *     the sentence alone.
 */
export function useLedgerJumpReach(inputs: {
  readonly outcome: LedgerJumpOutcome | undefined;
  readonly foldedWindow: LedgerWindowModel;
  readonly openedTerminalRunIds: ReadonlySet<string>;
  readonly clearFilter: () => void;
  readonly openChapterOfRow: (row: TimelineRow) => void;
  readonly endReplay: () => void;
  readonly requestJump: (rowId: string) => void;
}): LedgerJumpReach | undefined {
  const {
    outcome,
    foldedWindow,
    openedTerminalRunIds,
    clearFilter,
    openChapterOfRow,
    endReplay,
    requestJump,
  } = inputs;
  return useMemo(() => {
    if (outcome === undefined || outcome.status === "found") {
      return undefined;
    }
    if (outcome.status === "not-in-loaded-log" || outcome.status === "outside-window") {
      return undefined;
    }
    const { row } = outcome;
    if (outcome.status === "hidden-by-filter") {
      return {
        label: "Clear the filter and go to it",
        perform: () => {
          clearFilter();
          requestJump(row.id);
        },
      };
    }
    if (outcome.status === "withheld-by-replay") {
      return {
        label: "Leave the replay and go to it",
        perform: () => {
          endReplay();
          requestJump(row.id);
        },
      };
    }
    const chapterRunId = chapterRunIdOf(row, foldedWindow);
    if (chapterRunId === undefined || openedTerminalRunIds.has(chapterRunId)) {
      return undefined;
    }
    return {
      label: "Open that chapter and go to it",
      perform: () => {
        openChapterOfRow(row);
        requestJump(row.id);
      },
    };
  }, [
    outcome,
    foldedWindow,
    openedTerminalRunIds,
    clearFilter,
    openChapterOfRow,
    endReplay,
    requestJump,
  ]);
}

/** Which chapter of this window holds a row, if one does. */
export function chapterRunIdOf(
  row: TimelineRow,
  foldedWindow: LedgerWindowModel,
): string | undefined {
  if (row.kind === "general") {
    return undefined;
  }
  return foldedWindow.chapterByHeaderKey.has(row.runId) ? row.runId : undefined;
}
