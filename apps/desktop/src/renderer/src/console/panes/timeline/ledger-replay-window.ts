// Stage two of the feed's pipeline: replay, and which of the window's rows it lets
// the viewport have.
//
// REPLAY SITS BETWEEN THE TWO WINDOWS. It plays over the loaded log and decides
// which of its rows the viewport is given, so a scrub moves the rows on screen and
// find and the rail follow them down. That ordering is what keeps the derivation
// acyclic — the window replay reads is the log, and the window find reads is
// whatever the viewport made of replay's answer.

import { useCallback, useEffect, useMemo, useState } from "react";

import { type TimelineRow } from "@ai-sidekicks/contracts";

import { useConsoleClock } from "../../bridge/index.js";
import { type LedgerViewportRow } from "../../ledger/frame/index.js";
// The frame's door carries the four symbols a stranger holds; this range is the
// binding's own shape, reached by module path the way this family's other subtrees
// reach the frame's internals.
import { type LedgerVisibleRowRange } from "../../ledger/frame/viewport-binding.js";
import {
  ReplayEngine,
  type ReplayPosition,
  type ReplaySpeed,
  type ReplayState,
} from "../../ledger/structure/index.js";
import { type LedgerWindowModel } from "./ledger-window.js";

/** The replay dock's engine, its reveal, and the position it renders. */
export interface LedgerReplayState {
  readonly position: ReplayPosition;
  readonly isRevealed: boolean;
  /**
   * Rows the log admitted after this walk began.
   *
   * Zero while nobody is replaying, and zero again the moment the walk ends. A
   * non-zero count is a real absence with an exit of its own — see `end`.
   */
  readonly rowsAdmittedSinceReplayBegan: number;
  readonly reveal: () => void;
  readonly conceal: () => void;
  readonly play: () => void;
  readonly pause: () => void;
  readonly setSpeed: (speed: ReplaySpeed) => void;
  readonly scrub: (elapsedMs: number) => void;
  readonly jumpToNextSeam: () => void;
  /**
   * Abandon the walk and return to the live log.
   *
   * The one act that reaches a row admitted mid-replay: the walk is over a fixed
   * set, so scrubbing to the end of it does not reveal a row that was never in it.
   * A fresh walk over the window as it now stands is what does.
   */
  readonly end: () => void;
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

/**
 * The row set one walk is over, and the log it began over.
 *
 * A WRAPPER rather than the arrays themselves, because the object's identity is what
 * decides when the engine is re-minted, and ending a walk over an unchanged window
 * has to re-mint one. The arrays alone could not say "same rows, new walk".
 *
 * TWO ROW SETS, AND THE SECOND IS WHY THE FIRST CAN MOVE. `rows` is what the engine
 * plays — the folded, narrowed window — and it follows a fold or a filter change,
 * because a chapter opened mid-walk otherwise puts rows in the window the engine has
 * never heard of and the viewport drops every one of them. `loadedRows` is the LOG
 * this walk began over, and it is frozen from engagement to the end of the walk: it
 * is what "the session moved on" is measured against, so clearing a filter or
 * opening a chapter cannot be counted as an arrival.
 */
interface LedgerReplayWalk {
  readonly rows: readonly TimelineRow[];
  readonly loadedRows: readonly TimelineRow[];
  /**
   * Where a re-minted engine resumes, for a walk that replaced one mid-flight.
   *
   * `undefined` for a walk that begins at the head, which is every walk the engine
   * is not already running: a fresh engine is idle at elapsed zero and restoring a
   * position onto it would start a replay nobody pressed play on.
   */
  readonly resumeFrom: LedgerReplayResumePoint | undefined;
}

/** The two facts a replaced walk carries across the re-mint. */
interface LedgerReplayResumePoint {
  readonly elapsedMs: number;
  readonly isPlaying: boolean;
}

export interface LedgerReplayInputs {
  /** The window the walk plays over — narrowed and folded, what the viewport draws. */
  readonly ledgerWindow: LedgerWindowModel;
  /**
   * The loaded log that window was derived from, before any narrowing or fold.
   *
   * The arrival count's subject, and the reason it is a second input rather than a
   * derivation of the first: a filter change and a chapter disclosure both replace
   * the folded window's rows without the session having emitted anything, and
   * counted against that window they read as entries arriving mid-replay.
   */
  readonly loadedWindow: LedgerWindowModel;
}

export function useLedgerReplay(inputs: LedgerReplayInputs): LedgerReplayState {
  const { ledgerWindow, loadedWindow } = inputs;
  const clock = useConsoleClock();
  const [isRevealed, setIsRevealed] = useState(false);

  // REPLAY IS A WALK OVER A FIXED SET, AND THIS IS WHERE THAT SET IS FIXED.
  //
  // The engine's whole ordering is built from its rows at construction, so the
  // window identity used to key the mint — and every admitted event, filter change
  // and chapter disclosure mints a new one. A person watching a session replay
  // therefore had the replay stopped and the whole window revealed by the next event
  // the session happened to emit, which is the one moment they were least likely to
  // be looking away.
  //
  // So the walk's rows are STATE, adjusted during render rather than derived: while
  // nothing is being replayed the walk is whatever the log now holds, and from the
  // moment playback begins the LOG side of it is frozen until the walk ends. An
  // event admitted mid-walk joins the tail AFTER the walk rather than the walk
  // itself — it is counted below and named on screen, because a row a walk can never
  // reach is an absence and not a rendering detail.
  //
  // A FOLD OR A FILTER CHANGE IS NOT AN ARRIVAL AND IS NOT FROZEN OUT. Neither
  // changes the log, so the walk follows the new folded window and the engine is
  // re-minted over it at the position the replaced one held. Freezing there was two
  // defects in one: the notice announced arrivals the session never sent, and a
  // chapter disclosed at the tail opened onto nothing, because its members were in
  // the window and in no engine.
  const [position, setPosition] = useState<ReplayPosition | undefined>(undefined);
  const [walk, setWalk] = useState<LedgerReplayWalk>(() => ({
    rows: ledgerWindow.rows,
    loadedRows: loadedWindow.rows,
    resumeFrom: undefined,
  }));
  const isEngaged = position !== undefined && isReplayEngaged(position.state);
  const hasLogMoved = walk.loadedRows !== loadedWindow.rows;
  if (!isEngaged) {
    if (walk.rows !== ledgerWindow.rows || hasLogMoved) {
      setWalk({ rows: ledgerWindow.rows, loadedRows: loadedWindow.rows, resumeFrom: undefined });
    }
  } else if (!hasLogMoved && walk.rows !== ledgerWindow.rows) {
    setWalk({
      rows: ledgerWindow.rows,
      loadedRows: loadedWindow.rows,
      // A walk re-minted at the very end resumes PAUSED at the very end: the engine
      // reaches `at-tail` only by advancing into it, and the rows a paused position
      // at the span's end reveals are the rows `at-tail` reveals. The dock therefore
      // offers "resume" where it had offered "follow", which is the whole of the
      // difference and is stated rather than hidden.
      resumeFrom: { elapsedMs: position.elapsedMs, isPlaying: position.state === "playing" },
    });
  }

  const engine = useMemo(() => {
    const mintedEngine = new ReplayEngine({
      clock,
      rows: walk.rows.map((row) => ({ rowId: row.id, occurredAt: row.timestamp })),
      // The engine publishes rather than being polled: playback advances on its own
      // armed handle, so a surface reading `position()` per render would show the
      // frame before last on every tick the render did not coincide with.
      onPositionChange: setPosition,
    });
    if (walk.resumeFrom !== undefined) {
      // Restored here rather than in an effect, so the first render of the re-minted
      // walk already reveals the rows the replaced one had reached — an effect would
      // paint the whole window at elapsed zero first.
      mintedEngine.scrubTo(walk.resumeFrom.elapsedMs);
      if (walk.resumeFrom.isPlaying) {
        mintedEngine.play();
      }
    }
    return mintedEngine;
  }, [clock, walk]);

  useEffect(() => {
    setPosition(engine.position());
    return () => {
      engine.dispose();
    };
  }, [engine]);

  // COUNTED AGAINST THE FROZEN LOG AND NOT AGAINST THE WALKED ROWS, which is what
  // makes it an arrival rather than a re-derivation: a row of the current folded
  // window whose id the log did not hold when this walk began is a row the session
  // admitted mid-walk, and nothing else is. Counted by id rather than by length,
  // because the window loses rows at the head as well as gaining them at the tail: a
  // subtraction would report a pruned walk as having admitted nothing. The identity
  // short-circuit is what keeps an unreplayed ledger free — while nobody is walking,
  // the frozen log IS the log.
  const rowsAdmittedSinceReplayBegan = useMemo(() => {
    if (walk.loadedRows === loadedWindow.rows) {
      return 0;
    }
    const rowIdsTheWalkBeganOver = new Set(walk.loadedRows.map((row) => row.id));
    let admittedCount = 0;
    for (const row of ledgerWindow.rows) {
      if (!rowIdsTheWalkBeganOver.has(row.id)) {
        admittedCount += 1;
      }
    }
    return admittedCount;
  }, [walk, ledgerWindow, loadedWindow]);

  return {
    // Before the first publication the engine's own current position is the truth,
    // and it is a pure read — there is no state to hold that would not be a copy.
    position: position ?? engine.position(),
    isRevealed,
    rowsAdmittedSinceReplayBegan,
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
    end: useCallback(() => {
      // A fresh wrapper every time, so a walk ends over an unchanged window too —
      // the memo above re-mints, and its own cleanup disposes the walk being left.
      // At the head, because ending a walk is a return to the live log rather than a
      // re-mint of the one being left.
      setWalk({ rows: ledgerWindow.rows, loadedRows: loadedWindow.rows, resumeFrom: undefined });
    }, [ledgerWindow, loadedWindow]),
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
 * TWO KINDS OF ROW, AND ONLY ONE OF THEM IS ON THE REPLAY CLOCK. The engine is
 * built from projected rows, so `revealedRowIds` holds event-row ids and nothing
 * else — while a chapter header's viewport key is its RUN id, which is in that set
 * at no position at all. Tested against it, every synthetic header was stripped at
 * every position including `at-tail`, and a folded chapter's receipt came through
 * without it: the disclosure that names the run and reopens it was gone, and the
 * receipt hung under a parent the window no longer held, which the cap reads as a
 * top-level row rather than as the chapter's child.
 *
 * SO A HEADER IS ADMITTED WHEN ITS CHAPTER HAS REACHED THE POSITION, and reached is
 * defined from the model rather than from the clock: at least one of the chapter's
 * rows THIS WINDOW HOLDS is revealed. Two properties follow, and both are why this
 * definition and not one over the chapter's first row or its run's start instant:
 *
 *   • `at-tail` renders exactly what an unreplayed ledger renders. Every held row
 *     is revealed there, every chapter holds at least one — a folded one keeps its
 *     receipt, an open one keeps its rows — so every header is admitted.
 *   • A header and its chapter appear and disappear together. There is no position
 *     at which a header stands over nothing, and none at which a member row hangs
 *     off a header the window has dropped. For a folded chapter that means header
 *     and receipt arrive in the same instant the run ended, which is also the only
 *     honest moment for a header that renders the terminal's own name.
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
    const reachedChapterRunIds = new Set<string>();
    for (const row of ledgerWindow.viewportRows) {
      if (row.parentKey !== undefined && revealedRowIds.has(row.key)) {
        reachedChapterRunIds.add(row.parentKey);
      }
    }
    return ledgerWindow.viewportRows.filter((row) =>
      // The same lookup the feed's row renderer dispatches on, so "is this a header"
      // is one classification rather than a second guess at what a key means.
      ledgerWindow.chapterByHeaderKey.has(row.key)
        ? reachedChapterRunIds.has(row.key)
        : revealedRowIds.has(row.key),
    );
  }, [ledgerWindow, position]);
}
