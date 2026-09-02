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
  emptyFindResult,
  findInLedger,
  stepFindMatch,
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
   * reasoning that no
   * registered read pages a session's log backwards — but that reasoning answers a
   * different question. Whether anybody can FETCH earlier rows and whether earlier
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
  };
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
 * engine orders by `occurredAt` because that is what §5.5 plays in, and the ledger
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
