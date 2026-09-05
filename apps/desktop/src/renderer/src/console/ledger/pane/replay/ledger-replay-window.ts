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

import { useConsoleClock } from "../../../bridge/index.js";
import {
  ReplayEngine,
  type ReplayPosition,
  type ReplaySpeed,
  type ReplayState,
} from "../../structure/index.js";
import { useSubjectScopedResource, type SubjectScopedDisposal } from "../../../store/index.js";
import { isReplayEngaged } from "./ledger-replay-reveal.js";
import { type LedgerWindowModel } from "../window/index.js";

/**
 * How a replay engine ends, and how an ended one is recognised. At module scope.
 *
 * MODULE SCOPE BECAUSE THE HOLDER HOLDS IT ON A DEPENDENCY. `useSubjectScopedResource`
 * keeps its caller's `dispose` and `isClosed` in a layout effect keyed on their
 * identity, so an object minted per render would restart that lifetime every pass. One
 * constant has one identity for the module's life and nothing to close over.
 *
 * THE TERMINAL ARM, AND THE READING COMES OFF THE ENGINE. Disposal is one-way there,
 * so the engine can answer whether it is past it; this mount used to remember on the
 * side which engines it had closed, which was a second record of a fact the object
 * already had.
 */
const REPLAY_ENGINE_DISPOSAL: SubjectScopedDisposal<ReplayEngine> = {
  dispose: (engine) => {
    engine.dispose();
  },
  isClosed: (engine) => engine.isDisposed,
};

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
  /**
   * Which walk this is, counted from the mount's first.
   *
   * The engine's key, and a COUNTER rather than the wrapper's own identity because a
   * subject-scoped key is a name inside one key space and never an object. It moves
   * on exactly the acts that end a walk and start another, which is what makes an
   * engine's lifetime the walk's.
   */
  readonly generation: number;
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
  /** What the replaced walk was doing, so the re-minted one is doing it too. */
  readonly state: ReplayState;
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
    generation: 0,
    rows: ledgerWindow.rows,
    loadedRows: loadedWindow.rows,
    resumeFrom: undefined,
  }));
  const isEngaged = position !== undefined && isReplayEngaged(position.state);
  const hasLogMoved = walk.loadedRows !== loadedWindow.rows;
  if (!isEngaged) {
    if (walk.rows !== ledgerWindow.rows || hasLogMoved) {
      setWalk((previous) => ({
        generation: previous.generation + 1,
        rows: ledgerWindow.rows,
        loadedRows: loadedWindow.rows,
        resumeFrom: undefined,
      }));
    }
  } else if (!hasLogMoved && walk.rows !== ledgerWindow.rows) {
    setWalk((previous) => ({
      generation: previous.generation + 1,
      rows: ledgerWindow.rows,
      loadedRows: loadedWindow.rows,
      // The position AND what the walk was doing at it, because the two states a
      // replay can be stopped in offer different next moves: a walk re-minted at
      // the very end settles `at-tail` through the engine's own scrub, so the dock
      // still offers to replay from the beginning rather than to resume a walk with
      // nothing left to play.
      resumeFrom: { elapsedMs: position.elapsedMs, state: position.state },
    }));
  }

  // THE ENGINE IS A RESOURCE, AND `useMemo` COULD NOT HOLD ONE. Minting it arms a
  // timeout on the console clock — `play()` reaches the engine's own scheduler — and a
  // memo factory runs DURING the render. A pass React discards therefore really
  // constructed an engine and really armed it, and nothing committed that pass, so no
  // effect ever closed over it: the orphan went on firing `onPositionChange` forever
  // while a later pass minted the engine the dock is actually reading, and the
  // scrubber jumped between the two on alternating frames. Every discarded pass added
  // another. `useSubjectScopedResource` closes exactly that hole: a resource opened by
  // a pass no commit saw is disposed inside the render that drops it, and the
  // committed one is disposed by the effect that holds it.
  //
  // THE SUBJECT IS THE CLOCK AND THE KEY IS THE WALK'S GENERATION. The clock is what
  // a replay runs on, so a window handed a different one is holding an engine armed
  // somewhere else; and the walk is keyed by a COUNTER rather than by its rows,
  // because ending a walk over an unchanged window has to re-mint one and two arrays
  // compared by identity could not say "same rows, new walk".
  const walkKey = String(walk.generation);
  const openEngine = useCallback((): ReplayEngine => {
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
      // Resumed only from `paused`, which is where the scrub leaves a position with
      // window left to play. `play()` from `at-tail` restarts at the HEAD by design,
      // so a walk whose rows narrowed under it — the position clamped onto the new
      // span's end — would have been thrown back to the beginning by the very call
      // meant to carry it across.
      if (walk.resumeFrom.state === "playing" && mintedEngine.position().state === "paused") {
        mintedEngine.play();
      }
    }
    return mintedEngine;
  }, [clock, walk]);
  const engine = useSubjectScopedResource(clock, walkKey, openEngine, REPLAY_ENGINE_DISPOSAL).value;

  useEffect(() => {
    setPosition(engine.position());
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
      // A fresh GENERATION every time, so a walk ends over an unchanged window too —
      // the resource above re-mints on the new key, and disposes the walk being left.
      // At the head, because ending a walk is a return to the live log rather than a
      // re-mint of the one being left.
      setWalk((previous) => ({
        generation: previous.generation + 1,
        rows: ledgerWindow.rows,
        loadedRows: loadedWindow.rows,
        resumeFrom: undefined,
      }));
    }, [ledgerWindow, loadedWindow]),
    replayFromRow: useCallback((rowId: string) => engine.replayFrom(rowId), [engine]),
  };
}
