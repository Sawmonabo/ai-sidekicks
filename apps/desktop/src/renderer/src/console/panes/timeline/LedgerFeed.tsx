// The ledger, composed: the rail, the find field, the feed, and the replay dock.
//
// WHAT THIS FILE ADDS TO THE PIECES IT MOUNTS: arrangement, and the four callbacks
// that let one of them act on another. Every derivation it renders is
// `ledger-window.ts`', every scroll it performs is the viewport binding's, and every
// model it drives is `ledger/structure/`'s. Nothing here folds a log, measures a
// row, or writes a `scrollTop`.
//
// WHY THE FEED IS A COMPONENT OF ITS OWN RATHER THAN THE PANE'S BODY. The pane owns
// chrome — a header, a heading id, and the row seat's two absences — and can render
// every one of those with no session store at all. The feed cannot exist without
// one: it subscribes to a log. Splitting them is what lets the pane hold the
// `undefined` arm as an ordinary render instead of as a conditional hook, which
// React does not allow and which a single component would have forced.
//
// THE FOUR SEAMS BETWEEN THE PIECES:
//
//   • The rail's tick and find's walk both JUMP, and both jump through the
//     viewport's `jumpToRow` — the ledger's one scroll writer. Neither touches an
//     element.
//   • The replay dock's reveal is the caller's, per §5.5: the dock is hidden until
//     the rail is hovered or focused, because both triggers are facts about this
//     surface rather than about replay.
//   • Find's result is derived from the same window the feed renders, so the
//     boundary it states — rows searched, and whether earlier rows exist — is the
//     boundary that is actually true of what is on screen.
//   • A row body is the SEAT's, handed down whole. This file supplies only the three
//     decisions the seat says the list makes.

import { useCallback, useEffect, useMemo, useState } from "react";

import { useConsoleClock } from "../../bridge/index.js";
import {
  LedgerViewport,
  type LedgerViewportRow,
  useLedgerViewport,
} from "../../ledger/frame/index.js";
import {
  FindInLedger,
  ProvenanceRail,
  ReplayControls,
  ReplayEngine,
  emptyFindResult,
  findInLedger,
  stepFindMatch,
  type ReplayPosition,
  type ReplaySpeed,
} from "../../ledger/structure/index.js";
import { Nothing } from "../../primitives/index.js";
import { type SessionStore } from "../../store/index.js";
import { type TimelineRowRenderer } from "../../workspace/index.js";
import { densityFor, useLedgerWindow, type LedgerWindowModel } from "./ledger-window.js";

export interface LedgerFeedProps {
  readonly sessionStore: SessionStore;
  /** The row body, from the seat. Resolved by the pane, so this file reads no seat. */
  readonly renderTimelineRow: TimelineRowRenderer;
  /** Names the feed for a screen reader walking the window. */
  readonly feedLabel: string;
}

export function LedgerFeed(props: LedgerFeedProps): React.JSX.Element {
  const clock = useConsoleClock();
  const ledgerWindow = useLedgerWindow(props.sessionStore);
  const find = useLedgerFind(ledgerWindow);
  const replay = useLedgerReplay(ledgerWindow);

  const viewport = useLedgerViewport({
    clock,
    rows: ledgerWindow.viewportRows,
    hasActiveTurn: ledgerWindow.hasActiveTurn,
    isRevealDraining: false,
  });

  const renderRow = useCallback(
    (row: LedgerViewportRow) => {
      const projected = ledgerWindow.rowsByKey.get(row.key);
      if (projected === undefined) {
        // The window moved under the viewport between its reconcile and this paint.
        // Named rather than rendered as a blank band: a row that vanished mid-frame
        // is a fact about the cap, not about the session.
        return (
          <Nothing kind="not-loaded" placement="inline" title="This entry is no longer loaded." />
        );
      }
      return props.renderTimelineRow({
        row: projected,
        participantHue:
          projected.actor === undefined
            ? undefined
            : ledgerWindow.hueByParticipantId.get(projected.actor),
        isSuperseded: ledgerWindow.supersededRowIds.has(projected.id),
        density: densityFor(projected.id, ledgerWindow.collapsedRowIds),
      });
    },
    [ledgerWindow, props],
  );

  const geometry = useRailGeometry(viewport.virtualItems, ledgerWindow.viewportRows.length);
  const jumpToRow = viewport.jumpToRow;
  const onStepFind = useCallback(
    (direction: "next" | "previous") => {
      const step = find.step(direction);
      if (step !== undefined) {
        jumpToRow(step.match.rowId);
      }
    },
    [find, jumpToRow],
  );

  return (
    <div className="meridian-ledger">
      {find.isOpen ? (
        <FindInLedger
          query={find.query}
          result={find.result}
          currentMatchIndex={find.currentMatchIndex}
          onQueryChange={find.setQuery}
          onStep={onStepFind}
          onLoadEarlier={NO_EARLIER_ROWS_TO_LOAD}
          onClose={find.close}
        />
      ) : null}
      <div className="meridian-ledger__body">
        <LedgerViewport
          clock={clock}
          rows={ledgerWindow.viewportRows}
          renderRow={renderRow}
          feedLabel={props.feedLabel}
          hasActiveTurn={ledgerWindow.hasActiveTurn}
        />
        <div
          className="meridian-ledger__rail"
          onPointerEnter={replay.reveal}
          onPointerLeave={replay.conceal}
          onFocus={replay.reveal}
          onBlur={replay.conceal}
        >
          <ProvenanceRail
            model={ledgerWindow.railModel}
            viewportPosition={geometry.position}
            viewportExtent={geometry.extent}
            isFollowing={viewport.snapshot.reading.mode === "following"}
            onJumpToRow={jumpToRow}
            onLoadEarlier={NO_EARLIER_ROWS_TO_LOAD}
            clock={clock}
          />
          <ReplayControls
            position={replay.position}
            isRevealed={replay.isRevealed}
            onPlay={replay.play}
            onPause={replay.pause}
            onSpeedChange={replay.setSpeed}
            onScrub={replay.scrub}
            onJumpToNextSeam={replay.jumpToNextSeam}
          />
        </div>
      </div>
      <LedgerUnprojectableNotice count={ledgerWindow.unprojectableEventCount} />
    </div>
  );
}

/**
 * What "load earlier" does while the console holds no timeline read.
 *
 * A named no-op rather than an inline arrow, so the two call sites share one and a
 * reader meets the reason once: this console subscribes and never pages, so there is
 * nothing earlier to fetch. The control still renders — `hasEarlierRows` is what
 * says whether anything is missing, and it is derived from the store's gap list.
 */
function NO_EARLIER_ROWS_TO_LOAD(): void {
  // Intentionally empty; see this function's own contract above.
}

/** Events the contract package registers no category for, named rather than hidden. */
function LedgerUnprojectableNotice(props: { readonly count: number }): React.JSX.Element | null {
  if (props.count === 0) {
    return null;
  }
  return (
    <Nothing
      kind="not-checked"
      placement="surface"
      title="Some entries could not be placed."
      detail={`${String(props.count)} event${props.count === 1 ? "" : "s"} arrived with a type this build does not recognise, so they are not shown.`}
    />
  );
}

/** The find field's state, and the walk over one window's matches. */
interface LedgerFindState {
  readonly isOpen: boolean;
  readonly query: string;
  readonly result: ReturnType<typeof findInLedger>;
  readonly currentMatchIndex: number;
  readonly setQuery: (query: string) => void;
  readonly close: () => void;
  readonly step: (direction: "next" | "previous") => ReturnType<typeof stepFindMatch>;
}

function useLedgerFind(ledgerWindow: LedgerWindowModel): LedgerFindState {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQueryValue] = useState("");
  const [currentMatchIndex, setCurrentMatchIndex] = useState(-1);

  const result = useMemo(
    () =>
      query.trim().length === 0
        ? emptyFindResult(ledgerWindow.rows.length, ledgerWindow.hasEarlierRows)
        : findInLedger(ledgerWindow.rows, query, ledgerWindow.hasEarlierRows),
    [ledgerWindow, query],
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

  return { isOpen, query, result, currentMatchIndex, setQuery, close, step };
}

/** The replay dock's engine, its reveal, and the position it renders. */
interface LedgerReplayState {
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

function useLedgerReplay(ledgerWindow: LedgerWindowModel): LedgerReplayState {
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

/** Where the reader is in the window, and how much of it they can see. */
interface RailGeometry {
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
function useRailGeometry(
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
