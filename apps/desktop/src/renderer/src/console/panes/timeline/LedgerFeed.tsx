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
//     element. There is exactly ONE binding, minted here and handed to
//     `<LedgerViewport>`: a second one would leave the rail and the find walk
//     reading a virtualizer with no element under it, which is a jump that reports
//     success and scrolls nothing.
//   • The replay dock's reveal is the caller's, per
//     `ledger/structure/ReplayControls.tsx`: the dock is hidden until
//     the rail is hovered or focused, because both triggers are facts about this
//     surface rather than about replay. What the dock's POSITION reveals is the
//     rows: the viewport is given the rows the position has reached, so playing or
//     scrubbing moves the ledger rather than only its timestamp.
//   • Find's result and the rail's marks are derived from the same window the feed
//     renders — the viewport's own reconciled snapshot, after the cap — so the
//     boundary find states is the boundary that is actually true of what is on
//     screen, and every tick the rail draws is a row the viewport can scroll to.
//     Matches outside that window are counted beside the field rather than walked
//     into and lost — in TWO counts, because a match the cap took and a match the
//     replay position has not reached are different states with different exits.
//   • A row body is the SEAT's, handed down whole. This file supplies only the three
//     decisions the seat says the list makes.
//
// AND ONE ENGINE THIS MOUNT OWNS. The reveal engine is per feed, minted here and
// disposed with the feed, because a lane is a row of THIS window and a second engine
// would publish a second answer for one row's text. It is not a fifth seam: nothing
// mounted here reads it. Rows reach it through the frame's own per-row channel and the
// viewport reads only its drain state.
//
// AND TWO SEATS THIS MOUNT CLAIMS, both for callers composed before it existed: the
// palette's, so a ledger chord acts on the feed that is up when it fires, and the
// workspace's follow seat, so a cast chip scrolls this ledger through this ledger's
// own chokepoint. Every act behind both is built in `ledger-feed-acts.ts`.
//
// NEITHER STRUCTURAL CONTROL IS GIVEN AN `onLoadEarlier` HANDLER, and the omission
// is the offer being absent rather than the boundary being denied. The two rows the
// growth slate carries for this read — `timeline-epoch-attestation` and
// `timeline-path-reference`, both Spec-013 — grow MEMBERS of a timeline read, and
// neither is a backward-paging one; no slate row registers a read that returns rows
// before the window's head, so there is nothing for a press to call. The clip
// itself is passed truthfully, so the rail still draws its dotted segment and the
// find result still carries its boundary over a window the cap has truncated.

import { useCallback, useEffect, useMemo } from "react";

import { useConsoleClock } from "../../bridge/index.js";
import {
  LedgerRowLeaseProvider,
  LedgerRowRevealProvider,
  LedgerViewport,
  type LedgerViewportRow,
  useLedgerReveal,
  useLedgerViewport,
} from "../../ledger/frame/index.js";
import {
  ChapterHeader,
  FindInLedger,
  LedgerFilterBar,
  ProvenanceRail,
  ReplayControls,
  SeamRow,
  jumpToEventId,
  type LedgerJumpOutcome,
} from "../../ledger/structure/index.js";
import { Nothing } from "../../primitives/index.js";
import {
  LedgerEventIdJump,
  LedgerMatchesNotYetReplayedNotice,
  LedgerMatchesOutsideWindowNotice,
  LedgerWindowAbsences,
} from "./LedgerFeedNotices.js";
import { type SessionStore } from "../../store/index.js";
import { type TimelineRowRenderer } from "../../seats/index.js";
import { useActorFollowSeat, useLedgerStructureActs } from "./ledger-feed-acts.js";
import { densityFor, useChapterDisclosure, useFoldedChapters } from "./ledger-chapter-fold.js";
import { useLedgerFind } from "./ledger-find.js";
import { useFilteredLedgerWindow, useLedgerFilter } from "./ledger-narrowing.js";
import {
  useLedgerReplay,
  useReplayAnchorRowId,
  useReplayRevealedRows,
} from "./ledger-replay-window.js";
import { useRailGeometry, useVisibleLedgerWindow } from "./ledger-visible-window.js";
import { useLedgerProjection } from "./ledger-window.js";

export interface LedgerFeedProps {
  readonly sessionStore: SessionStore;
  /** The row body, from the seat. Resolved by the pane, so this file reads no seat. */
  readonly renderTimelineRow: TimelineRowRenderer;
  /** Names the feed for a screen reader walking the window. */
  readonly feedLabel: string;
}

export function LedgerFeed(props: LedgerFeedProps): React.JSX.Element {
  const clock = useConsoleClock();
  // The fold is this MOUNT's, not the log's: which finished chapters a person has
  // opened is a fact about who is reading, so it is held here and handed to the
  // derivation rather than folded into it.
  const chapterDisclosure = useChapterDisclosure();
  // THE UNFURLED PROJECTION — every member row of every chapter, before any fold.
  const unfurledWindow = useLedgerProjection(props.sessionStore);
  // THE NARROWING RUNS ON THAT PROJECTION, BEFORE ANYTHING ELSE SEES IT. Everything
  // below — the chapter fold, the replay engine, the viewport, the visible window,
  // find and the rail — is built over the narrowed model, so no piece has to
  // remember that a filter exists. The facets the bar offers are the exception, and
  // deliberately so: they are derived from the WHOLE unfurled projection, or
  // admitting one participant would take away the chip that widens back.
  //
  // AND THE FOLD RUNS AFTER IT, which is the ordering the filter needs to be
  // truthful at all: folded first, a closed terminal chapter reaches the filter as
  // one receipt, so its messages and tools are absent from the facet counts and
  // unreachable by narrowing until somebody expands the chapter by hand.
  const ledgerFilter = useLedgerFilter(unfurledWindow);
  const narrowedWindow = useFilteredLedgerWindow(unfurledWindow, ledgerFilter.filter);
  const ledgerWindow = useFoldedChapters(narrowedWindow, chapterDisclosure.openedTerminalRunIds);
  const replay = useLedgerReplay(ledgerWindow);
  // What the replay position has reached. The whole window while nobody is
  // replaying, so a ledger with the dock closed pays nothing and reconciles nothing.
  const revealedViewportRows = useReplayRevealedRows(ledgerWindow, replay.position);

  // THE REVEAL ENGINE IS THIS FEED'S, minted once and disposed with it. What it
  // publishes reaches a row through the frame's own channel below; what it is DOING
  // reaches the viewport as the drain state, which used to be the literal `false` —
  // a default standing in for a reading of a scheduler nothing had mounted.
  const reveal = useLedgerReveal({ clock });
  const viewport = useLedgerViewport({
    clock,
    rows: revealedViewportRows,
    hasActiveTurn: ledgerWindow.hasActiveTurn,
    isRevealDraining: reveal.isDraining,
  });

  // A lane whose row this window no longer holds, or holds only inside a chapter that
  // has reached its terminal, is a turn that is over: the engine drops it so a
  // finished lane stops costing memory. Asked of the engine's own lanes, which are at
  // most one per streaming row — walking the window instead would be a pass over the
  // whole log on every event.
  const retireRevealLanes = reveal.retireLanes;
  useEffect(() => {
    retireRevealLanes(
      (laneId) => !ledgerWindow.rowsByKey.has(laneId) || ledgerWindow.collapsedRowIds.has(laneId),
    );
  }, [retireRevealLanes, ledgerWindow]);

  // Read back off the viewport's own reconciled snapshot, so find and the rail are
  // looking at the window on screen rather than at the log behind it. The revealed
  // set goes in beside it so the two absences stay separable: what the cap took is
  // the difference between the two, and what replay is holding back is everything
  // the revealed set never carried.
  const visible = useVisibleLedgerWindow(
    ledgerWindow,
    revealedViewportRows,
    viewport.snapshot.rows,
  );
  const find = useLedgerFind(visible);
  // Memoized and short-circuited on an empty query: this is a scan of the whole
  // loaded window, and the field is closed — with an empty query — for most of a
  // ledger's life.
  const findQuery = find.query.trim();
  const eventIdJump = useMemo<LedgerJumpOutcome>(
    () =>
      findQuery.length === 0
        ? { status: "outside-window" }
        : jumpToEventId(unfurledWindow.rows, visible.rows, findQuery),
    [unfurledWindow, visible, findQuery],
  );

  // The STORE's wheel, which is the one the cast bar reads, handed to both surfaces
  // that colour by actor — the rows and the rail's marks — so one person wears one
  // colour everywhere. A surface asks the session who somebody is rather than
  // deciding it again from the order this window happened to meet them in.
  // `assignmentFor` never allocates, so an actor the wheel has never admitted
  // answers `undefined`: the row renders its unattributed shape and the rail its
  // neutral tone, rather than either being handed a colour nobody else would agree
  // with.
  const hueForActor = useCallback(
    (participantId: string) => props.sessionStore.hueAllocator.assignmentFor(participantId),
    [props.sessionStore],
  );

  const toggleChapter = chapterDisclosure.toggle;
  const openedTerminalRunIds = chapterDisclosure.openedTerminalRunIds;
  const rowLease = viewport.rowLease;
  const setRowLease = viewport.setRowLease;
  // Named off the props object rather than read through it, because the callback
  // below keys on this and `props` is a fresh object on every render. Depending on
  // the whole object rebuilt `renderRow` on every render of this feed — a find
  // keystroke, a rail hover, a replay tick, a lease write — and `LedgerRowMount`'s
  // memo compares it, so every mounted row re-rendered for a change none of them
  // could see.
  const renderTimelineRow = props.renderTimelineRow;
  const rowLeaseChannel = useMemo(() => ({ setLease: setRowLease }), [setRowLease]);
  const renderRow = useCallback(
    (row: LedgerViewportRow) => {
      // A CHAPTER HEADER IS A ROW OF THE LIST, keyed by the run it heads, so it is
      // dispatched before the body lookup — there is no projected row behind it and
      // there was never meant to be. Every terminal chapter has one; a live chapter
      // has none and its rows stay top-level.
      const chapter = ledgerWindow.chapterByHeaderKey.get(row.key);
      if (chapter !== undefined) {
        return (
          <ChapterHeader
            chapter={chapter}
            isOpen={openedTerminalRunIds.has(chapter.runId)}
            participantHue={
              chapter.actorId === undefined ? undefined : hueForActor(chapter.actorId)
            }
            onToggle={toggleChapter}
          />
        );
      }
      const projected = ledgerWindow.rowsByKey.get(row.key);
      if (projected === undefined) {
        // The window moved under the viewport between its reconcile and this paint.
        // Named rather than rendered as a blank band: a row that vanished mid-frame
        // is a fact about the cap, not about the session.
        return (
          <Nothing kind="not-loaded" placement="inline" title="This entry is no longer loaded." />
        );
      }
      const participantHue =
        projected.actor === undefined ? undefined : hueForActor(projected.actor);
      const isSuperseded = ledgerWindow.supersededRowIds.has(projected.id);
      // A SEAM IS THE LEDGER'S OWN ROW, so it is drawn before the seat is asked.
      // The seat fills with whichever renderer owns a session's row BODIES, and a
      // seam has none: it is a change in the run's condition, laid on one line from
      // parts `seams.ts` derived. Delegating it would render a rollback, a
      // compaction, a switch or a block as an ordinary receipt and drop the boundary
      // position, the continuity, the losses, the reason and the blocked-on state.
      const seam = ledgerWindow.seamByRowId.get(projected.id);
      if (seam !== undefined) {
        return <SeamRow seam={seam} participantHue={participantHue} isSuperseded={isSuperseded} />;
      }
      return renderTimelineRow({
        row: projected,
        participantHue,
        isSuperseded,
        // THE LEASE OVERLAYS THE LIST, and the list is the fallback rather than the
        // other way round: a row nobody has touched holds no lease and follows the
        // chapter fold, and a row somebody opened keeps that choice across an
        // unmount and across a prune, because the window re-parks it.
        density:
          rowLease(projected.id)?.density ?? densityFor(projected.id, ledgerWindow.collapsedRowIds),
      });
    },
    [hueForActor, ledgerWindow, openedTerminalRunIds, renderTimelineRow, rowLease, toggleChapter],
  );

  const geometry = useRailGeometry(viewport.visibleRange, viewport.snapshot.rows.length);
  // "Here", for a console that cannot draw a per-row control: the row at the top of
  // the box, off the same range the rail's thumb is sized from.
  const replayAnchorRowId = useReplayAnchorRowId(viewport.visibleRange, viewport.snapshot.rows);
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

  const closeFind = find.close;
  const focusLedgerSurface = viewport.focusSurface;
  const onCloseFind = useCallback(() => {
    closeFind();
    // The field took focus when it opened, and it is unmounted by the close — so
    // without this focus falls to `body` and the next Tab restarts from the top of
    // the document, well away from the log somebody was reading.
    focusLedgerSurface();
  }, [closeFind, focusLedgerSurface]);

  const concealReplayDock = replay.conceal;
  const concealReplayDockOnFocusLeaving = useCallback(
    (event: React.FocusEvent<HTMLDivElement>) => {
      // React backs `onBlur` with `focusout`, which BUBBLES, so tabbing from the
      // rail's slider to a dock button reaches this wrapper although focus never
      // left it — and concealing there makes the dock's controls vanish or be
      // skipped mid-tab. A related target this wrapper contains is that move.
      //
      // A NULL related target is focus leaving the document, and that IS a conceal
      // rather than an exemption: reading it as one would leave the dock open under
      // a window nobody is in. Do not "fix" this into a leak.
      if (
        event.relatedTarget instanceof Node &&
        event.currentTarget.contains(event.relatedTarget)
      ) {
        return;
      }
      concealReplayDock();
    },
    [concealReplayDock],
  );

  // The palette's chords and the cast bar's chips both act on whichever ledger is
  // mounted when they fire, and neither can import this component. Both seats are
  // claimed here for the mount's lifetime; what each act does is `ledger-feed-acts.ts`'.
  const collapseAllTerminal = chapterDisclosure.collapseAllTerminal;
  const collapseAllTerminalChapters = useCallback(() => {
    collapseAllTerminal([...ledgerWindow.chapterByHeaderKey.values()]);
  }, [collapseAllTerminal, ledgerWindow]);
  const structureActs = useLedgerStructureActs({
    find,
    replay,
    jumpToRow,
    jumpToTail: viewport.jumpToTail,
    collapseAllTerminalChapters,
    ledgerFilter,
    replayAnchorRowId,
  });
  useActorFollowSeat({ visibleRows: visible.rows, jumpToRow });

  return (
    <div className="meridian-ledger">
      {find.isOpen ? (
        <FindInLedger
          query={find.query}
          result={find.result}
          currentMatchIndex={find.currentMatchIndex}
          openRequestCount={find.openRequestCount}
          onQueryChange={find.setQuery}
          onStep={onStepFind}
          onClose={onCloseFind}
        />
      ) : null}
      <LedgerFilterBar
        facets={ledgerFilter.facets}
        filter={ledgerFilter.filter}
        onFilterChange={ledgerFilter.setFilter}
      />
      <LedgerEventIdJump outcome={eventIdJump} onJumpToRow={jumpToRow} />
      <LedgerMatchesOutsideWindowNotice count={find.beyondWindowMatchCount} />
      <LedgerMatchesNotYetReplayedNotice count={find.notYetReplayedMatchCount} />
      <div className="meridian-ledger__body">
        <LedgerRowLeaseProvider channel={rowLeaseChannel}>
          <LedgerRowRevealProvider channel={reveal.channel}>
            <LedgerViewport
              binding={viewport}
              renderRow={renderRow}
              feedLabel={props.feedLabel}
              hasActiveTurn={ledgerWindow.hasActiveTurn}
            />
          </LedgerRowRevealProvider>
        </LedgerRowLeaseProvider>
        <div
          className="meridian-ledger__rail"
          onPointerEnter={replay.reveal}
          // Unguarded, unlike the focus pair: React's leave events do not fire for
          // a pointer move between two elements inside this subtree.
          onPointerLeave={replay.conceal}
          // Reveal needs no guard of its own — it is idempotent, and a focus move
          // arriving from anywhere is a reason for the dock to be on screen.
          onFocus={replay.reveal}
          onBlur={concealReplayDockOnFocusLeaving}
        >
          <ProvenanceRail
            model={visible.railModel}
            viewportPosition={geometry.position}
            viewportExtent={geometry.extent}
            isFollowing={viewport.snapshot.reading.mode === "following"}
            onJumpToRow={jumpToRow}
            hueForActor={hueForActor}
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
            // THE SAME ACT THE PALETTE RUNS, not a second copy: the refusal for an
            // absent anchor lives inside it, so a control with its own callback
            // would be a second place this console decides what to say.
            onReplayFromRowInView={structureActs.replayFromRowInView}
          />
        </div>
      </div>
      <LedgerWindowAbsences
        unprojectableEventCount={ledgerWindow.unprojectableEventCount}
        droppedRowCount={visible.prunedAwayRows.length}
        withheldByReplayRowCount={visible.withheldByReplayRows.length}
        hasUnreceivedEntries={ledgerWindow.hasUnreceivedEntries}
      />
    </div>
  );
}
