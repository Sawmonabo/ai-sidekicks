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
//     delivered and the projection could place. Replay plays over it, because §5.5
//     replays "the rows already loaded".
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
// Replay sits BETWEEN the two: it plays over the log and decides which of its rows
// the viewport is given, so a scrub moves the rows on screen and find and the rail
// follow them down. That ordering is what keeps the derivation acyclic — the window
// replay reads is the log, and the window find reads is whatever the viewport made
// of replay's answer.

import { useCallback, useEffect, useMemo, useState } from "react";

import { type TimelineRow } from "@ai-sidekicks/contracts";

import { useConsoleClock } from "../../bridge/index.js";
import { type LedgerViewportRow } from "../../ledger/frame/index.js";
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

/**
 * Whether a "load earlier" affordance may be offered. It may not.
 *
 * Settled against the wire rather than against a wish. The console reaches the
 * daemon through one live subscription plus a whole-session snapshot read, and
 * neither takes a cursor or a sequence bound: `sessionRead` is keyed by session and
 * `hydratedEventRead` by a single event id, whose own registration says a range
 * read "would be a batching decision made ahead of the surface that would need it".
 * `timeline.read` is registered in the corpus and on no bridge namespace and on no
 * growth-slate row, so this console cannot call it.
 *
 * Both structural controls draw their "load earlier" button from this flag, so the
 * honest value makes the button ABSENT — and the feed states the two real gaps, the
 * rows the cap took and the sequences that never arrived, in words that say which
 * read is missing. A control whose press cannot do anything is the one shape rule 8
 * refuses.
 */
const NO_HISTORY_READ_EXISTS = false;

/** The window the viewport is showing, and what fell outside it. */
export interface VisibleLedgerWindow {
  /** The projected rows the viewport holds, in log order. */
  readonly rows: readonly TimelineRow[];
  /** Rows the log has and this window does not — what the cap took. */
  readonly prunedAwayRows: readonly TimelineRow[];
  /** The rail's derivation over the rows on screen. */
  readonly railModel: ProvenanceRailModel;
}

/**
 * Project the viewport's reconciled snapshot back into rows.
 *
 * Keyed on the snapshot's ROW ARRAY rather than on the snapshot, because a
 * snapshot is republished whenever the reading state moves — which is every time
 * somebody scrolls, and re-deriving the rail on a scroll is the render this frame's
 * budget exists to avoid. The row array's identity changes exactly on a reconcile.
 */
export function useVisibleLedgerWindow(
  ledgerWindow: LedgerWindowModel,
  viewportRows: readonly LedgerViewportRow[],
): VisibleLedgerWindow {
  return useMemo(() => {
    const visibleKeys = new Set(viewportRows.map((row) => row.key));
    const rows: TimelineRow[] = [];
    const prunedAwayRows: TimelineRow[] = [];
    for (const row of ledgerWindow.rows) {
      (visibleKeys.has(row.id) ? rows : prunedAwayRows).push(row);
    }
    return {
      rows,
      prunedAwayRows,
      // `false`, and it is a claim about this console rather than about this log:
      // the rail's unloaded extent is also what draws its "load earlier" control,
      // and no read the console can perform returns rows before the window's head.
      // The rows the cap took are named in words by the feed instead, which is the
      // honest half of what the dotted segment was standing in for.
      railModel: new ProvenanceRailModel({ rows, hasEarlierRows: NO_HISTORY_READ_EXISTS }),
    };
  }, [ledgerWindow, viewportRows]);
}

/** The find field's state, and the walk over one window's matches. */
export interface LedgerFindState {
  readonly isOpen: boolean;
  readonly query: string;
  readonly result: LedgerFindResult;
  /** Matches in rows the log holds and this window does not. Named, never hidden. */
  readonly beyondWindowMatchCount: number;
  readonly currentMatchIndex: number;
  readonly setQuery: (query: string) => void;
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
 */
export function useLedgerFind(visible: VisibleLedgerWindow): LedgerFindState {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQueryValue] = useState("");
  const [currentMatchIndex, setCurrentMatchIndex] = useState(-1);

  const result = useMemo(
    () =>
      query.trim().length === 0
        ? emptyFindResult(visible.rows.length, NO_HISTORY_READ_EXISTS)
        : findInLedger(visible.rows, query, NO_HISTORY_READ_EXISTS),
    [visible, query],
  );

  const beyondWindowMatchCount = useMemo(
    () =>
      query.trim().length === 0
        ? 0
        : findInLedger(visible.prunedAwayRows, query, false).totalMatchCount,
    [visible, query],
  );

  const setQuery = useCallback((next: string) => {
    setQueryValue(next);
    // A new query restarts the walk. Keeping the index would step from a position
    // inside a match list that no longer exists.
    setCurrentMatchIndex(-1);
    setIsOpen(true);
  }, []);

  const step = useCallback(
    (direction: "next" | "previous") => {
      const outcome = stepFindMatch(result, currentMatchIndex, direction);
      if (outcome !== undefined) {
        setCurrentMatchIndex(outcome.index);
      }
      return outcome;
    },
    [result, currentMatchIndex],
  );

  const close = useCallback(() => {
    setIsOpen(false);
    setQueryValue("");
    setCurrentMatchIndex(-1);
  }, []);

  return {
    isOpen,
    query,
    result,
    beyondWindowMatchCount,
    currentMatchIndex,
    setQuery,
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
 * everywhere. Read off the virtualizer's own rendered range, so there is no second
 * measurement of what is on screen.
 */
export function useRailGeometry(
  virtualItems: readonly { readonly index: number }[],
  rowCount: number,
): RailGeometry {
  return useMemo(() => {
    if (rowCount === 0 || virtualItems.length === 0) {
      return { position: 0, extent: 1 };
    }
    const firstIndex = virtualItems[0]?.index ?? 0;
    const lastIndex = virtualItems[virtualItems.length - 1]?.index ?? firstIndex;
    const visibleCount = lastIndex - firstIndex + 1;
    // Divided by the last INDEX rather than by the count, so a viewport sitting on
    // the final row reports 1 rather than falling short of the rail's own end.
    const lastPossibleIndex = Math.max(1, rowCount - 1);
    return {
      position: Math.min(1, firstIndex / lastPossibleIndex),
      extent: Math.min(1, visibleCount / rowCount),
    };
  }, [virtualItems, rowCount]);
}
