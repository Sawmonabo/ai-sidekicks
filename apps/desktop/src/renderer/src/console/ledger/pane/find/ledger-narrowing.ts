// Stage one of the feed's pipeline: what a person has narrowed this ledger to.
//
// THE ORDER IS THE WHOLE DESIGN, and this module is its head: narrow, then fold the
// chapters, then replay's reveal, then the viewport, then the visible window. Each
// stage is a module of its own so the ordering is a composition in `LedgerFeed.tsx`
// rather than a convention a reader has to hold — and so a stage cannot quietly
// swap with its neighbour, which is what put the fold ahead of the narrowing and
// made a finished run's rows uncountable and unreachable.

import { useCallback, useMemo, useState } from "react";

import {
  UNFILTERED_LEDGER,
  applyLedgerFilter,
  deriveLedgerFacets,
  isLedgerFiltered,
  type LedgerChapter,
  type LedgerFacets,
  type LedgerFilter,
} from "../../structure/index.js";
import { narrowChapterToAdmittedRows } from "../feed/ledger-chapter-fold.js";
import {
  NO_ROWS_REMOVED,
  type LedgerPipelineStage,
  type LedgerWindowModel,
} from "../window/index.js";

/** What a person has narrowed this ledger to, and what the bar may offer them. */
export interface LedgerFilterState {
  readonly filter: LedgerFilter;
  /** Derived from the whole UNFURLED projection, never from the narrowed or folded one. */
  readonly facets: LedgerFacets;
  readonly isFiltered: boolean;
  readonly setFilter: (filter: LedgerFilter) => void;
  /** Widen back to the whole window — what the palette's clear row runs. */
  readonly clear: () => void;
}

/**
 * Hold one mount's narrowing, and derive what the bar can offer.
 *
 * THE FACETS COME OFF THE UNFURLED, UNFILTERED PROJECTION, and each half of that is
 * load-bearing. Unfiltered, because derived from the narrowed rows instead,
 * admitting one participant would collapse the offer to that participant and there
 * would be no chip left to press to get back — a control that removes itself the
 * first time it is used. Unfurled, because a closed terminal chapter is one receipt
 * in the folded window: counted there, a finished run's messages, tool calls and
 * participants offer no chip at all, and the families they belong to are missing
 * from the bar entirely for as long as nobody hand-expands the chapter.
 */
export function useLedgerFilter(ledgerWindow: LedgerWindowModel): LedgerFilterState {
  const [filter, setFilter] = useState<LedgerFilter>(UNFILTERED_LEDGER);
  const facets = useMemo(() => deriveLedgerFacets(ledgerWindow.rows), [ledgerWindow]);
  const clear = useCallback(() => {
    setFilter(UNFILTERED_LEDGER);
  }, []);
  return useMemo(
    () => ({ filter, facets, isFiltered: isLedgerFiltered(filter), setFilter, clear }),
    [filter, facets, clear],
  );
}

/**
 * Narrow the UNFURLED projection, before anything downstream of it has seen it.
 *
 * THE ORDER IS THE WHOLE DESIGN: narrow, then fold the chapters, then replay's
 * reveal, then the viewport, then the visible window. The narrowing runs on the
 * unfurled projection because that is what `Spec-023 §Console Design (Meridian)`
 * narrows — the loaded log, every row of it — and everything after it then holds
 * without restatement. The fold runs on what the narrowing admitted, replay plays
 * over rows the fold left, the cap prunes what replay revealed, and find and the
 * rail keep reading only rows the one scroll writer can reach.
 *
 * NARROWING AFTER THE FOLD WAS THE DEFECT. A closed terminal chapter is a header
 * and one receipt, so a filter handed that window saw neither the chapter's messages
 * nor its tool calls nor the people in it: a completed run full of message rows
 * offered no message-family chip, and narrowing to one could not reveal them
 * without somebody first opening the chapter by hand. Applying it before the
 * viewport is a separate necessity — after it, the rail would mark rows the feed no
 * longer draws.
 *
 * A NARROWED CHAPTER KEEPS ITS HEADER AND RE-COUNTS IT, and a chapter the narrowing
 * emptied loses its header: the header is a row of the list keyed by its run, so
 * leaving one over nothing would draw a finished run this narrowing has no rows for,
 * and leaving its whole-run count on it would put a figure over a body that cannot
 * hold that many. `narrowChapterToAdmittedRows` is the one place that decides both.
 *
 * The unnarrowed case returns the model BY IDENTITY, so a ledger nobody has
 * filtered reconciles nothing and pays nothing — `foldChapterHeaders`' own early
 * return, for its reason.
 *
 * AND THE STAGE REPORTS WHAT IT REMOVED, because the find field counts it and this is
 * the only pass that already holds the answer. Derived downstream it cost a `Set` over
 * this stage's rows and a filter over the previous stage's, re-run on every appended
 * row for as long as a query was in the field.
 */
export function useFilteredLedgerWindow(
  ledgerWindow: LedgerWindowModel,
  filter: LedgerFilter,
): LedgerPipelineStage {
  return useMemo(() => {
    if (!isLedgerFiltered(filter)) {
      return { window: ledgerWindow, removedRows: NO_ROWS_REMOVED };
    }
    // Read once and held: this is the loaded projection, and the two derivations below
    // are the only passes over it this stage may cost.
    const loadedRows = ledgerWindow.rows;
    const rows = applyLedgerFilter(loadedRows, filter);
    const admittedRowIds = new Set(rows.map((row) => row.id));
    const removedRows = loadedRows.filter((row) => !admittedRowIds.has(row.id));
    const chapterByHeaderKey = new Map<string, LedgerChapter>();
    for (const [runId, chapter] of ledgerWindow.chapterByHeaderKey) {
      const narrowedChapter = narrowChapterToAdmittedRows(chapter, admittedRowIds);
      if (narrowedChapter !== undefined) {
        chapterByHeaderKey.set(runId, narrowedChapter);
      }
    }
    const window = {
      ...ledgerWindow,
      rows,
      rowsByKey: new Map([...ledgerWindow.rowsByKey].filter(([key]) => admittedRowIds.has(key))),
      // Row keys only: this runs on the unfurled projection, whose viewport rows are
      // one per projected row. The synthetic header keys appear downstream, in the
      // fold this window is handed to.
      viewportRows: ledgerWindow.viewportRows.filter((row) => admittedRowIds.has(row.key)),
      chapterByHeaderKey,
      // The dock's next-seam jump walks these, so a seam the filter took out must
      // leave with it: scrubbing to a row the feed is not drawing would move the
      // position and reveal nothing.
      seams: ledgerWindow.seams.filter((seam) => admittedRowIds.has(seam.rowId)),
      seamByRowId: new Map(
        [...ledgerWindow.seamByRowId].filter(([rowId]) => admittedRowIds.has(rowId)),
      ),
    };
    return { window, removedRows };
  }, [ledgerWindow, filter]);
}
