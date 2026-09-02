// What the feed derives, with no markup in it.
//
// `LedgerFeed.tsx` arranges four pieces; everything those pieces are handed is
// derived here, so the component body holds no fold and every derivation can be
// driven by a test with no DOM at all — `ledger-window.ts`' own split, for its
// reason.
//
// THE ONE IDEA THIS MODULE OWNS: there are TWO windows, and the difference between
// them is the defect it exists to make unrepresentable.
//
//   • `LedgerWindowModel` is the whole loaded log — everything the subscription
//     delivered and the projection could place. Replay plays over it, because
//     `Spec-023 §Console Design (Meridian)` replays "the rows already loaded".
//   • `VisibleLedgerWindow` is what the viewport is actually showing, after the
//     window cap has pruned and after replay has withheld whatever the position has
//     not reached. Find searches it and the rail marks it, because both of them
//     offer to JUMP, and a jump is performed by the viewport: a control that
//     counted a row the viewport does not hold would step to it and land nowhere,
//     reporting success.
//
// So the rows the two structural controls see are read back off the viewport's own
// reconciled snapshot rather than off the log — one window on screen, one window
// searched, one window marked. What falls outside it is not silently dropped: the
// rows are counted, and the feed says so.
//
// AND THE ROWS OUTSIDE IT ARE COUNTED IN TWO PILES, NOT ONE. Cap retention and
// replay visibility are two facts about a row, and this module tracks them
// separately because a person's next move differs: a row the cap took is gone until
// the session is read again, and a row the replay position has not reached comes
// back the moment the dock is scrubbed forward. One complement over the viewport's
// rows reported every not-yet-replayed row as an older entry the cap had removed,
// which is wrong twice — those rows are NEWER than the window's head, and nothing
// removed them.
//
// Replay sits BETWEEN the two: it plays over the log and decides which of its rows
// the viewport is given, so a scrub moves the rows on screen and find and the rail
// follow them down. That ordering is what keeps the derivation acyclic — the window
// replay reads is the log, and the window find reads is whatever the viewport made
// of replay's answer.

import { useCallback, useEffect, useMemo, useState } from "react";

import { type TimelineRow } from "@ai-sidekicks/contracts";

import { useConsoleClock } from "../../bridge/index.js";
import { type LedgerViewportRow } from "../../ledger/frame/index.js";
// The frame's door carries the four symbols a stranger holds; this range is the
// binding's own shape, reached by module path the way this family's other subtrees
// reach the frame's internals.
import { type LedgerVisibleRowRange } from "../../ledger/frame/viewport-binding.js";
import {
  ProvenanceRailModel,
  ReplayEngine,
  UNFILTERED_LEDGER,
  applyLedgerFilter,
  deriveLedgerFacets,
  emptyFindResult,
  findInLedger,
  isLedgerFiltered,
  stepFindMatch,
  type LedgerFacets,
  type LedgerFilter,
  type LedgerFindResult,
  type ReplayPosition,
  type ReplaySpeed,
  type ReplayState,
} from "../../ledger/structure/index.js";
import { type LedgerWindowModel } from "./ledger-window.js";

/** The window the viewport is showing, and what fell outside it. */
export interface VisibleLedgerWindow {
  /** The projected rows the viewport holds, in log order. */
  readonly rows: readonly TimelineRow[];
  /** Rows the log has and this window does not — what the cap took. */
  readonly prunedAwayRows: readonly TimelineRow[];
  /**
   * Rows the log has and the replay position has not reached yet.
   *
   * A separate pile from `prunedAwayRows` because the two absences are different
   * facts, and the difference is the whole point: nothing removed these rows, they
   * are newer rather than older, and scrubbing the dock forward brings them back.
   */
  readonly withheldByReplayRows: readonly TimelineRow[];
  /**
   * Whether rows sit before this window's head — the CLIP, measured rather than
   * declared.
   *
   * True exactly when the cap took something, which is what `prunedAwayRows`
   * records — and deliberately NOT when replay is merely holding rows back, which
   * would draw an unloaded segment over a complete window and make find state a
   * boundary that is not there. It was a hard-coded `false` until now, on the
   * reasoning that no registered read pages a session's log backwards — but that
   * reasoning answers a different question. Whether anybody can FETCH earlier rows
   * and whether earlier
   * rows EXIST are two facts, and collapsing them made the rail draw a complete
   * session over a window the cap had already truncated, and told the find result
   * it had searched a whole log.
   *
   * So the two are separated: this is the fact, and an absent `onLoadEarlier`
   * handler is the offer. The rail's dotted segment and the find result's boundary
   * read the fact; the "load earlier" button reads both, which is why it is never
   * drawn on this build.
   */
  readonly hasEarlierRows: boolean;
  /** The rail's derivation over the rows on screen. */
  readonly railModel: ProvenanceRailModel;
}

/**
 * Project the viewport's reconciled snapshot back into rows, and name what is not
 * in it and why.
 *
 * Keyed on the snapshot's ROW ARRAY rather than on the snapshot, because a
 * snapshot is republished whenever the reading state moves — which is every time
 * somebody scrolls, and re-deriving the rail on a scroll is the render this frame's
 * budget exists to avoid. The row array's identity changes exactly on a reconcile.
 *
 * THE THREE LISTS NEST — `viewportRows ⊆ revealedRows ⊆ ledgerWindow.viewportRows`
 * — because the window cap ADOPTS the array it is handed rather than accumulating
 * across ingests, so whatever replay withheld the cap never saw. That nesting is
 * what makes the partition below a decision and not a guess: a row the viewport
 * holds is on screen, a row only the revealed set holds is one the cap took, and a
 * row neither holds is one the replay position has not reached.
 */
export function useVisibleLedgerWindow(
  ledgerWindow: LedgerWindowModel,
  revealedRows: readonly LedgerViewportRow[],
  viewportRows: readonly LedgerViewportRow[],
): VisibleLedgerWindow {
  return useMemo(() => {
    const visibleKeys = new Set(viewportRows.map((row) => row.key));
    const revealedKeys = new Set(revealedRows.map((row) => row.key));
    const rows: TimelineRow[] = [];
    const prunedAwayRows: TimelineRow[] = [];
    const withheldByReplayRows: TimelineRow[] = [];
    for (const row of ledgerWindow.rows) {
      if (visibleKeys.has(row.id)) {
        rows.push(row);
      } else if (revealedKeys.has(row.id)) {
        prunedAwayRows.push(row);
      } else {
        withheldByReplayRows.push(row);
      }
    }
    // One measurement, read by the rail and by find, so the two can never disagree
    // about whether this window is the whole session.
    const hasEarlierRows = prunedAwayRows.length > 0;
    return {
      rows,
      prunedAwayRows,
      withheldByReplayRows,
      hasEarlierRows,
      railModel: new ProvenanceRailModel({ rows, hasEarlierRows }),
    };
  }, [ledgerWindow, revealedRows, viewportRows]);
}

/** What a person has narrowed this ledger to, and what the bar may offer them. */
export interface LedgerFilterState {
  readonly filter: LedgerFilter;
  /** Derived from the WHOLE loaded window, never from the narrowed one. */
  readonly facets: LedgerFacets;
  readonly isFiltered: boolean;
  readonly setFilter: (filter: LedgerFilter) => void;
  /** Widen back to the whole window — what the palette's clear row runs. */
  readonly clear: () => void;
}

/**
 * Hold one mount's narrowing, and derive what the bar can offer.
 *
 * THE FACETS COME OFF THE UNFILTERED WINDOW, which is the only choice that leaves
 * the bar usable: derived from the narrowed rows instead, admitting one participant
 * would collapse the offer to that participant and there would be no chip left to
 * press to get back — a control that removes itself the first time it is used.
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
 * Narrow one loaded window, before anything downstream of it has seen it.
 *
 * THE ORDER IS THE WHOLE DESIGN: filter, then replay's reveal, then the viewport,
 * then the visible window. The filter runs on the LOG because that is what
 * `Spec-023 §Console Design (Meridian)` narrows — everything after it then holds
 * without restatement. Replay plays over rows the filter admitted, the cap prunes
 * what the filter left, and find and the rail keep reading only rows the one scroll
 * writer can reach. Applying it after the viewport instead would have left the rail
 * marking rows the feed no longer draws.
 *
 * A NARROWED CHAPTER KEEPS ITS HEADER, and a chapter the filter emptied loses one:
 * the header is a row of the list keyed by its run, so leaving one over nothing
 * would draw a finished run that this narrowing has no rows for.
 *
 * The unnarrowed case returns the model BY IDENTITY, so a ledger nobody has
 * filtered reconciles nothing and pays nothing — `foldChapterHeaders`' own early
 * return, for its reason.
 */
export function useFilteredLedgerWindow(
  ledgerWindow: LedgerWindowModel,
  filter: LedgerFilter,
): LedgerWindowModel {
  return useMemo(() => {
    if (!isLedgerFiltered(filter)) {
      return ledgerWindow;
    }
    const rows = applyLedgerFilter(ledgerWindow.rows, filter);
    const admittedRowIds = new Set(rows.map((row) => row.id));
    const admittedRunIds = new Set<string>();
    for (const row of rows) {
      if (row.kind !== "general") {
        admittedRunIds.add(row.runId);
      }
    }
    return {
      ...ledgerWindow,
      rows,
      rowsByKey: new Map([...ledgerWindow.rowsByKey].filter(([key]) => admittedRowIds.has(key))),
      viewportRows: ledgerWindow.viewportRows.filter(
        (row) => admittedRowIds.has(row.key) || admittedRunIds.has(row.key),
      ),
      chapterByHeaderKey: new Map(
        [...ledgerWindow.chapterByHeaderKey].filter(([runId]) => admittedRunIds.has(runId)),
      ),
      // The dock's next-seam jump walks these, so a seam the filter took out must
      // leave with it: scrubbing to a row the feed is not drawing would move the
      // position and reveal nothing.
      seams: ledgerWindow.seams.filter((seam) => admittedRowIds.has(seam.rowId)),
      seamByRowId: new Map(
        [...ledgerWindow.seamByRowId].filter(([rowId]) => admittedRowIds.has(rowId)),
      ),
    };
  }, [ledgerWindow, filter]);
}

/** The find field's state, and the walk over one window's matches. */
export interface LedgerFindState {
  readonly isOpen: boolean;
  readonly query: string;
  readonly result: LedgerFindResult;
  /** Matches in rows the cap took out of this window. Named, never hidden. */
  readonly beyondWindowMatchCount: number;
  /**
   * Matches in rows the replay position has not reached.
   *
   * Its own figure rather than a share of the one above, because the sentence each
   * is rendered in offers a different move: nothing brings a pruned row back, and
   * scrubbing forward brings these back at once.
   */
  readonly notYetReplayedMatchCount: number;
  /**
   * Where the walk is in the CURRENT result, or `-1` with nothing selected.
   *
   * Derived from the selected ROW rather than held as an ordinal, because the
   * result recomputes whenever the visible window moves — every replay withhold,
   * every prune, every appended row — while the query stays the same. A held
   * ordinal survived into a shorter list, so the counter could read "10 of 2" and
   * the next step wrapped over the new count from a position that meant nothing.
   * A lookup answers `-1` exactly when the selected row has left the result, and
   * `-1` is already the sentinel the stepper enters the list from.
   */
  readonly currentMatchIndex: number;
  readonly setQuery: (query: string) => void;
  /**
   * Reveal the field without touching the query or the walk.
   *
   * Separate from `setQuery`, which also opens: the palette's "Find in ledger" row
   * and the chord behind it open a field somebody is about to type into, and
   * folding that into the query setter would have made the act pass an empty string
   * and reset a walk the reader was already in the middle of.
   */
  readonly open: () => void;
  /**
   * How many times `open` has been pressed, monotonic for the mount's life.
   *
   * The field is conditionally mounted, so a mount IS one open — but the chord
   * pressed while the field is already up has to put the caret back and select what
   * is there, and a mount-only effect cannot see that press. One counter covers both
   * entries and stays drivable by a unit test, which `autoFocus` is not.
   */
  readonly openRequestCount: number;
  readonly close: () => void;
  readonly step: (direction: "next" | "previous") => ReturnType<typeof stepFindMatch>;
}

/**
 * Search the window on screen, and count what lies outside it.
 *
 * Two passes over two DISJOINT sets rather than one pass over the log and a
 * partition afterwards, which costs the same and keeps the walkable result honest:
 * every match in `result` is a row `jumpToRow` can reach, and every match that is
 * not is in the count beside it.
 *
 * THE WALK IS HELD BY ROW, NOT BY ORDINAL. The result recomputes whenever the
 * window moves under a query somebody is still walking, and an ordinal into the
 * previous result is a position in a list that no longer exists.
 */
export function useLedgerFind(visible: VisibleLedgerWindow): LedgerFindState {
  const [isOpen, setIsOpen] = useState(false);
  const [openRequestCount, setOpenRequestCount] = useState(0);
  const [query, setQueryValue] = useState("");
  const [selectedMatchRowId, setSelectedMatchRowId] = useState<string | undefined>(undefined);

  const result = useMemo(
    () =>
      query.trim().length === 0
        ? emptyFindResult(visible.rows.length, visible.hasEarlierRows)
        : findInLedger(visible.rows, query, visible.hasEarlierRows),
    [visible, query],
  );

  const beyondWindowMatchCount = useMemo(
    () =>
      query.trim().length === 0
        ? 0
        : findInLedger(visible.prunedAwayRows, query, false).totalMatchCount,
    [visible, query],
  );

  const notYetReplayedMatchCount = useMemo(
    () =>
      query.trim().length === 0
        ? 0
        : findInLedger(visible.withheldByReplayRows, query, false).totalMatchCount,
    [visible, query],
  );

  // Looked up rather than remembered, so a result that recomputed under the walk
  // reports where the walk actually is — or that it is nowhere.
  const currentMatchIndex = useMemo(
    () =>
      selectedMatchRowId === undefined
        ? -1
        : result.matches.findIndex((match) => match.rowId === selectedMatchRowId),
    [result, selectedMatchRowId],
  );

  const setQuery = useCallback((next: string) => {
    setQueryValue(next);
    // A new query restarts the walk. Keeping the selection would resume inside a
    // match list built from a different question.
    setSelectedMatchRowId(undefined);
    setIsOpen(true);
  }, []);

  const step = useCallback(
    (direction: "next" | "previous") => {
      const outcome = stepFindMatch(result, currentMatchIndex, direction);
      if (outcome !== undefined) {
        setSelectedMatchRowId(outcome.match.rowId);
      }
      return outcome;
    },
    [result, currentMatchIndex],
  );

  const open = useCallback(() => {
    setIsOpen(true);
    // Bumped rather than set, so the field can tell a fresh press from a re-render
    // and take the caret on both the first open and every one after it.
    setOpenRequestCount((count) => count + 1);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    setQueryValue("");
    setSelectedMatchRowId(undefined);
  }, []);

  return {
    isOpen,
    query,
    result,
    beyondWindowMatchCount,
    notYetReplayedMatchCount,
    currentMatchIndex,
    setQuery,
    open,
    openRequestCount,
    close,
    step,
  };
}

/** The replay dock's engine, its reveal, and the position it renders. */
export interface LedgerReplayState {
  readonly position: ReplayPosition;
  readonly isRevealed: boolean;
  readonly reveal: () => void;
  readonly conceal: () => void;
  readonly play: () => void;
  readonly pause: () => void;
  readonly setSpeed: (speed: ReplaySpeed) => void;
  readonly scrub: (elapsedMs: number) => void;
  readonly jumpToNextSeam: () => void;
  /**
   * Scrub to where one row sits on the replay clock — the design's "replay from
   * here".
   *
   * Answers whether the engine could place the row, so a caller renders the
   * absence rather than reporting a move that did not happen. The engine's window
   * and the viewport's are not the same set: the cap can drop a row between a
   * caller reading its id and pressing.
   */
  readonly replayFromRow: (rowId: string) => boolean;
}

export function useLedgerReplay(ledgerWindow: LedgerWindowModel): LedgerReplayState {
  const clock = useConsoleClock();
  const [isRevealed, setIsRevealed] = useState(false);

  // One engine per loaded window. Re-minted when the window changes because the
  // engine's whole ordering is built from the rows at construction, and disposed on
  // the way out so a playing replay never outlives the rows it was revealing.
  const [position, setPosition] = useState<ReplayPosition | undefined>(undefined);
  const engine = useMemo(
    () =>
      new ReplayEngine({
        clock,
        rows: ledgerWindow.rows.map((row) => ({ rowId: row.id, occurredAt: row.timestamp })),
        // The engine publishes rather than being polled: playback advances on its own
        // armed handle, so a surface reading `position()` per render would show the
        // frame before last on every tick the render did not coincide with.
        onPositionChange: setPosition,
      }),
    [clock, ledgerWindow],
  );

  useEffect(() => {
    setPosition(engine.position());
    return () => {
      engine.dispose();
    };
  }, [engine]);

  return {
    // Before the first publication the engine's own current position is the truth,
    // and it is a pure read — there is no state to hold that would not be a copy.
    position: position ?? engine.position(),
    isRevealed,
    reveal: useCallback(() => {
      setIsRevealed(true);
    }, []),
    conceal: useCallback(() => {
      setIsRevealed(false);
    }, []),
    play: useCallback(() => {
      engine.play();
    }, [engine]),
    pause: useCallback(() => {
      engine.pause();
    }, [engine]),
    setSpeed: useCallback(
      (speed: ReplaySpeed) => {
        engine.setSpeed(speed);
      },
      [engine],
    ),
    scrub: useCallback(
      (elapsedMs: number) => {
        engine.scrubTo(elapsedMs);
      },
      [engine],
    ),
    jumpToNextSeam: useCallback(() => {
      engine.jumpToNextSeam(ledgerWindow.seams);
    }, [engine, ledgerWindow]),
    replayFromRow: useCallback((rowId: string) => engine.replayFrom(rowId), [engine]),
  };
}

/**
 * The row a "replay from here" starts at — the one at the top of the box.
 *
 * WHY THE VIEWPORT AND NOT A ROW CONTROL. "Here" is a row, and the row a person
 * means is the one they are looking at. A per-row button would say it more
 * directly, and this console cannot draw one: a row's body is the timeline row
 * seat's, whose props are the row and three list decisions with no callback among
 * them, and the seat belongs to another plan. So the anchor is read from the
 * surface this family does own — the range the virtualizer reports the box
 * intersects, off the same reading `useRailGeometry` sizes the rail's thumb from.
 *
 * FIRST VISIBLE, not the middle or the last: the first row is the one under the
 * reader's eye at the top edge, and it is the row a scroll position names.
 *
 * `undefined` for a box nothing has measured or a window with no rows — which the
 * act refuses on rather than substituting the window's head, because replaying from
 * the beginning is a different act with its own control on the dock.
 */
export function useReplayAnchorRowId(
  visibleRange: LedgerVisibleRowRange | undefined,
  viewportRows: readonly LedgerViewportRow[],
): string | undefined {
  const firstIndex = visibleRange?.startIndex;
  return useMemo(
    () => (firstIndex === undefined ? undefined : viewportRows[firstIndex]?.key),
    [firstIndex, viewportRows],
  );
}

/**
 * Whether replay is holding the window back.
 *
 * Derived from the state union rather than restated as a second enumeration, and
 * `idle` is the only arm that is not engaged: an idle replay sits at elapsed zero,
 * where the revealed set is the rows that share the window's first instant, so
 * treating it as engaged would hide the whole session behind a control nobody had
 * touched.
 */
export function isReplayEngaged(state: ReplayState): boolean {
  return state !== "idle";
}

/**
 * The rows a replay has reached, in the log's own order.
 *
 * A FILTER over the window's own identity list, never a re-ordering of it. The
 * engine orders by `occurredAt` because that is what replay plays in, and the ledger
 * renders in wire order; sorting the viewport by the engine's order would make a
 * replay silently rearrange a log wherever the daemon admitted rows out of
 * wall-clock order.
 *
 * While replay is idle the window's own array is returned by identity, so the
 * viewport does not reconcile and a ledger nobody is replaying pays nothing.
 */
export function useReplayRevealedRows(
  ledgerWindow: LedgerWindowModel,
  position: ReplayPosition,
): readonly LedgerViewportRow[] {
  return useMemo(() => {
    if (!isReplayEngaged(position.state)) {
      return ledgerWindow.viewportRows;
    }
    const revealedRowIds = new Set(position.revealedRowIds);
    return ledgerWindow.viewportRows.filter((row) => revealedRowIds.has(row.key));
  }, [ledgerWindow, position]);
}

/** Where the reader is in the window, and how much of it they can see. */
export interface RailGeometry {
  readonly position: number;
  readonly extent: number;
}

/**
 * The rail's two fractions, in ROW space.
 *
 * Row space rather than pixel space because that is the space the rail lays its own
 * marks out in: a tick sits at its row's place in the window, so a thumb measured in
 * pixels would drift away from the marks it is supposed to point at wherever rows
 * differ in height — which, with tool cards and streamed prose in the same log, is
 * everywhere.
 *
 * Measured off the binding's `visibleRange` and NOT off `virtualItems`, which is
 * that range widened by the overscan at both edges: at the estimated row height a
 * 400px box intersects about five rows and mounts about seventeen, so a thumb sized
 * off the mount range is more than three times too tall and starts six rows early —
 * a thumb that no longer points at the ticks under it. An absent range is a box
 * nothing has measured, and the honest answer for one is the whole rail.
 */
export function useRailGeometry(
  visibleRange: LedgerVisibleRowRange | undefined,
  rowCount: number,
): RailGeometry {
  const firstIndex = visibleRange?.startIndex;
  const lastIndex = visibleRange?.endIndex;
  return useMemo(() => {
    if (rowCount === 0 || firstIndex === undefined || lastIndex === undefined) {
      return { position: 0, extent: 1 };
    }
    const visibleCount = lastIndex - firstIndex + 1;
    // Divided by the last INDEX rather than by the count, so a viewport sitting on
    // the final row reports 1 rather than falling short of the rail's own end.
    const lastPossibleIndex = Math.max(1, rowCount - 1);
    return {
      position: Math.min(1, firstIndex / lastPossibleIndex),
      extent: Math.min(1, visibleCount / rowCount),
    };
    // The two indices rather than the range object: the virtualizer recomputes that
    // object whenever the scroll offset moves, so keying on its identity would
    // re-derive the geometry on scrolls that did not change which rows are on
    // screen.
  }, [firstIndex, lastIndex, rowCount]);
}
