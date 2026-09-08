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
//     `ledger/structure/replay/ReplayControls.tsx`: the dock is hidden until
//     the rail is hovered or focused, because both triggers are facts about this
//     surface rather than about replay. What the dock's POSITION reveals is the
//     rows: the viewport is given the rows the position has reached, so playing or
//     scrubbing moves the ledger rather than only its timestamp.
//   • Find's result and the rail's marks are derived from the same window the feed
//     renders — the viewport's own reconciled snapshot, after the cap — so the
//     boundary find states is the boundary that is actually true of what is on
//     screen, and every tick the rail draws is a row the viewport can scroll to.
//     Matches outside that window are counted beside the field rather than walked
//     into and lost — in FOUR counts, one per narrowing, because a match the cap
//     took, one the replay position has not reached, one the facet bar is hiding and
//     one a folded chapter holds are four states with four different exits.
//   • A row body is the SEAT's, handed down whole. This file supplies only the three
//     decisions the seat says the list makes.
//
// ONE OF THOSE SEAMS IS A SMALL SYSTEM AND LIVES NEXT DOOR. The find field, the
// classification of an id against four narrowings, the act that answer deserves and
// the jump that has to outlive the render it was asked in are `ledger-feed-find-jump.ts`\'
// — read inside this arrangement they were forty lines of callbacks between two
// elements. What stays here is the composition that hands them their windows.
//
// AND WHAT THIS FILE RENDERS IS THREE CHILDREN, NOT TWENTY ELEMENTS. What the ledger
// says ABOVE its rows is `LedgerFeedHeader.tsx`' — the find field, the facet bar, the
// id jump, and the four absences a person can still act on, one subject — and the
// right-hand column is `LedgerFeedRail.tsx`', where the dock's reveal is a property
// of the strip that reveals it. Both DERIVE NOTHING: every value they take is a
// reading already held here, so neither can become a second answer to a question the
// derivations below already answer. What is left in this file is the arrangement.
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
// own chokepoint. The palette's nine acts are built in `ledger-feed-acts.ts` and the
// follow seat in `ledger-actor-follow-seat.ts`.
//
// AND ONE WALK THIS MOUNT OWNS, which is the OTHER end of the log. The store's window
// begins wherever this participant's stream was last acknowledged, and everything
// below that head was never delivered — so the ledger reaches it by asking rather than
// by scrolling. `useLedgerEarlierPaging` is that walk, minted here because this is the
// mount holding the session store, and handed to the viewport, where the head control
// is placed beside the tail's.
//
// THE TWO STRUCTURAL CONTROLS STILL TAKE NO `onLoadEarlier` HANDLER, and the reason is
// that they are about a different absence. `ledger-visible-window.ts` sets
// `hasEarlierRows` exactly when the window CAP took rows — rows this store still
// HOLDS — so the offer behind that clip would re-admit rows already in memory, which
// is a decision about the cap and the reading pin in `ledger/frame/viewport/` and not
// a fetch. Wiring the backward read to it would send the daemon after rows the console
// is already holding. The clip is passed truthfully either way, so the rail still
// draws its dotted segment and the find result still carries its boundary over a
// window the cap has truncated.

import { useCallback, useEffect, useMemo } from "react";

import { useConsoleClock } from "../../../bridge/index.js";
import {
  LedgerRowLeaseProvider,
  LedgerRowRevealProvider,
  LedgerViewport,
  useLedgerEarlierPaging,
  useLedgerFrameCoordinator,
  useLedgerReveal,
  useLedgerViewport,
  type LedgerScope,
} from "../../frame/index.js";
import { LedgerFeedHeader } from "./LedgerFeedHeader.js";
import { LedgerFeedRail } from "./LedgerFeedRail.js";
import {
  LedgerWindowAbsences,
  LedgerWindowReadState,
  useLedgerFirstReadSettled,
  useLedgerProjection,
  useRailGeometry,
  useVisibleLedgerWindow,
} from "../window/index.js";
import { useLedgerRowRenderer } from "./LedgerFeedRow.js";
import { usePeerInvocationProjection, type SessionStore } from "../../../store/index.js";
import { type TimelineRowRenderer } from "../../../seats/index.js";
import { useActorFollowSeat } from "./ledger-actor-follow-seat.js";
import { buildReplayFromRowAct, useLedgerStructureActs } from "./ledger-feed-acts.js";
import { LedgerRowOffersMenu, useLedgerRowOffers } from "./row-offers/index.js";
import { useChapterDisclosure, useFoldedChapters } from "./ledger-chapter-fold.js";
import { useFoldedSupersededBands, useSupersededBandDisclosure } from "./ledger-superseded-fold.js";
import { useChildRunDisclosure } from "../../structure/child-runs/index.js";
import {
  useLedgerFindAndJump,
  useReplayDockConcealOnFocusLeaving,
} from "./ledger-feed-find-jump.js";
import { useFilteredLedgerWindow, useLedgerFilter } from "../find/index.js";
import { useLedgerReplay, useReplayAnchorRowId, useReplayRevealedRows } from "../replay/index.js";

export interface LedgerFeedProps {
  readonly sessionStore: SessionStore;
  /**
   * The deck pane this feed is the body of.
   *
   * Carried rather than derived, because the follow seat is keyed by it: a deck can
   * hold this feed beside a second one, and a chip press names the pane it focused.
   */
  readonly paneId: string;
  /**
   * The channel this feed is a log OF, when it is a log of one.
   *
   * Absent, the feed is the whole session — which is what a bare timeline address
   * means. Present, it is applied inside the projection rather than beside it, so
   * the facets, the chapters, the seams, the cap, replay, find and the rail are all
   * facts about the channel and no piece below has to be told a scope exists.
   */
  readonly channelId?: string;
  /** The row body, from the seat. Resolved by the pane, so this file reads no seat. */
  readonly renderTimelineRow: TimelineRowRenderer;
  /** Names the feed for a screen reader walking the window. */
  readonly feedLabel: string;
}

export function LedgerFeed(props: LedgerFeedProps): React.JSX.Element {
  const clock = useConsoleClock();
  // WHAT THIS LEDGER IS A LOG OF, resolved once and handed to both surfaces that
  // say something about the window as a whole. Every sentence either of them can
  // print names a subject, and the subject is this.
  const scope: LedgerScope = props.channelId === undefined ? "session" : "channel";
  // WHY THE GRANT IS READ HERE. A session whose sidekicks may not reach each other
  // produces no handoff row at all — every peer invocation is adjudicated per call
  // against this projected member and answers denied — so an empty log in such a
  // session is not the absence of activity it reads as. The empty window says so,
  // and this is the mount that holds the store to read it from. Subscribed rather
  // than read once: the grant is a durable session fact anybody in the session can
  // change, and a value latched at mount would keep saying so after it was turned on.
  const peerInvocation = usePeerInvocationProjection(props.sessionStore);
  // The same reading `<LedgerWindowReadState>` below draws its shells from, so the
  // empty sentence and the loading shells cannot both be on screen.
  const firstReadSettled = useLedgerFirstReadSettled(props.sessionStore);
  // The fold is this MOUNT's, not the log's: which finished chapters a person has
  // opened is a fact about who is reading, so it is held here and handed to the
  // derivation rather than folded into it.
  const chapterDisclosure = useChapterDisclosure(props.sessionStore.sessionId);
  // Held beside the chapter's, at the same scope and for the same reason: a mount
  // that followed a navigation would otherwise carry one session's expansions into
  // the next one's rows.
  const childRunDisclosure = useChildRunDisclosure(props.sessionStore.sessionId);
  // And beside both, at the same scope: which rewound bands this reader has folded
  // away. It starts empty on purpose — a band is dimmed and present until somebody
  // asks for it to be folded, which is the rule `superseded-bands.ts` states.
  const supersededBandDisclosure = useSupersededBandDisclosure(props.sessionStore.sessionId);
  // THE UNFURLED PROJECTION — every member row of every chapter, before any fold.
  const unfurledWindow = useLedgerProjection(props.sessionStore, props.channelId);
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
  //
  // AND EACH STAGE REPORTS WHAT IT REMOVED, which is what the four counts beside the
  // find field are made of: the stage that separated the rows is the one that has
  // them, and re-deriving the difference downstream re-walked the whole projection on
  // every appended row for as long as a query sat in the field.
  const ledgerFilter = useLedgerFilter(unfurledWindow);
  const narrowing = useFilteredLedgerWindow(unfurledWindow, ledgerFilter.filter);
  const narrowedWindow = narrowing.window;
  const fold = useFoldedChapters(
    narrowedWindow,
    chapterDisclosure.openedTerminalRunIds,
    props.sessionStore.sessionId,
  );
  // AND THE BAND FOLD RUNS AFTER THE CHAPTER'S, so a folded chapter has already
  // reduced itself to a header and a receipt and there is nothing left in it for this
  // pass to hide a second time. It reports what it removed for the same reason every
  // stage above it does: the four counts beside the find field are made of exactly
  // these separations, and re-deriving one downstream would re-walk the projection.
  const bandFold = useFoldedSupersededBands(
    fold.window,
    supersededBandDisclosure.foldedBandKeys,
    props.sessionStore.sessionId,
  );
  const ledgerWindow = bandFold.window;
  const replay = useLedgerReplay({ ledgerWindow, loadedWindow: unfurledWindow });
  // What the replay position has reached. The whole window while nobody is
  // replaying, so a ledger with the dock closed pays nothing and reconciles nothing.
  const revealedViewportRows = useReplayRevealedRows(ledgerWindow, replay.position);

  // THE REVEAL ENGINE IS THIS FEED'S, minted once and disposed with it. What it
  // publishes reaches a row through the frame's own channel below; what it is DOING
  // reaches the viewport as the drain state, which used to be the literal `false` —
  // a default standing in for a reading of a scheduler nothing had mounted.
  // THE FRAME IS MINTED HERE, above both holders, because that is the only place one
  // object can order the whole paint: phase one is the viewport's scroll writes and
  // phase two is the reveal drain, and a coordinator minted inside either would order
  // that half against nothing.
  const frameCoordinator = useLedgerFrameCoordinator(clock);
  const reveal = useLedgerReveal({ frameCoordinator });
  const viewport = useLedgerViewport({
    clock,
    rows: revealedViewportRows,
    hasActiveTurn: ledgerWindow.hasActiveTurn,
    isRevealDraining: reveal.isDraining,
  });
  // The walk back past the window's head. Read against the STORE rather than against
  // any of the windows above, because what it can reach is a property of the log this
  // console was given and not of whichever narrowing this pane happens to be applying.
  const earlierPaging = useLedgerEarlierPaging(props.sessionStore);

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
  const jumpToRow = viewport.jumpToRow;
  // THE FIELD, THE CLASSIFICATION, AND THE ACT — one seam, wired next door.
  // Every window between the loaded log and the screen goes in, because the answer
  // is not whether a row is on screen but which narrowing is the reason it is not.
  const findAndJump = useLedgerFindAndJump({
    unfurledWindow,
    narrowedWindow,
    foldedWindow: ledgerWindow,
    filteredAwayRows: narrowing.removedRows,
    foldedAwayRows: fold.removedRows,
    bandFoldedAwayRows: bandFold.removedRows,
    openSupersededBandOfRow: supersededBandDisclosure.openBandKey,
    visible,
    openedTerminalRunIds: chapterDisclosure.openedTerminalRunIds,
    toggleChapter: chapterDisclosure.toggle,
    setFilter: ledgerFilter.setFilter,
    endReplay: replay.end,
    jumpToRow,
    focusLedgerSurface: viewport.focusSurface,
  });
  const find = findAndJump.find;

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
  // THE ROW'S OWN OFFERS, bound once for the mount — `row-offers/` owns why.
  const rowOffers = useLedgerRowOffers({
    rowLease,
    setRowLease,
    jumpToRow,
    replayFromRow: buildReplayFromRowAct(replay),
  });
  const renderRow = useLedgerRowRenderer({
    ledgerWindow,
    openedTerminalRunIds,
    hueForActor,
    toggleChapter,
    rowLease,
    renderTimelineRow,
    childRunDisclosure,
    supersededBandDisclosure,
    rowOffers,
  });

  const geometry = useRailGeometry(viewport.visibleRange, viewport.snapshot.rows.length);
  // "Here" FOR THE CHORD, which fires with no row in hand: the row at the top of the
  // box, off the same range the rail's thumb is sized from. The menu needs no anchor.
  const replayAnchorRowId = useReplayAnchorRowId(viewport.visibleRange, viewport.snapshot.rows);
  const concealReplayDockOnFocusLeaving = useReplayDockConcealOnFocusLeaving(replay.conceal);

  // The palette's chords and the cast bar's chips both act on whichever ledger is
  // mounted when they fire, and neither can import this component. Both seats are
  // claimed here for the mount's lifetime; what each act does is its own module's.
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
  useActorFollowSeat({ paneId: props.paneId, visibleRows: visible.rows, jumpToRow });

  return (
    <div className="meridian-ledger">
      <LedgerFeedHeader
        findAndJump={findAndJump}
        facets={ledgerFilter.facets}
        filter={ledgerFilter.filter}
        onFilterChange={ledgerFilter.setFilter}
        onJumpToRow={jumpToRow}
        rowsAdmittedSinceReplayBegan={replay.rowsAdmittedSinceReplayBegan}
        onEndReplay={replay.end}
      />
      <div className="meridian-ledger__body">
        <LedgerRowLeaseProvider channel={rowLeaseChannel}>
          <LedgerRowRevealProvider channel={reveal.channel}>
            <LedgerViewport
              binding={viewport}
              renderRow={renderRow}
              feedLabel={props.feedLabel}
              scope={scope}
              peerInvocationEnabled={peerInvocation.enabled}
              firstReadSettled={firstReadSettled}
              hasActiveTurn={ledgerWindow.hasActiveTurn}
              earlierPaging={earlierPaging}
            />
          </LedgerRowRevealProvider>
        </LedgerRowLeaseProvider>
        <LedgerFeedRail
          railModel={visible.railModel}
          geometry={geometry}
          isFollowing={viewport.snapshot.reading.mode === "following"}
          onJumpToRow={jumpToRow}
          hueForActor={hueForActor}
          clock={clock}
          replay={replay}
          onFocusLeaving={concealReplayDockOnFocusLeaving}
          // THE SAME ACT THE PALETTE RUNS, not a second copy: the refusal for an
          // absent anchor lives inside it, so a control with its own callback
          // would be a second place this console decides what to say.
          onReplayFromRowInView={structureActs.replayFromRowInView}
        />
      </div>
      {/*
        THE WINDOW'S ONE ROW MENU, mounted beside the list rather than inside each row
        — `row-offers/LedgerRowOffersMenu.tsx` owns why. It draws no element here: the
        root renders none of its own and the popup leaves through the overlay portal,
        so this line adds a machine and not a box.
      */}
      <LedgerRowOffersMenu offers={rowOffers} />
      <LedgerWindowReadState sessionStore={props.sessionStore} />
      <LedgerWindowAbsences
        unprojectableEventCount={ledgerWindow.unprojectableEventCount}
        droppedRowCount={visible.prunedAwayRows.length}
        // The rows a walk began after are a SUBSET of what replay is withholding —
        // they are in no revealed set at any position — so they are subtracted here
        // and reported above under their own exit. Leaving them in would tell
        // somebody to scrub forward for rows scrubbing cannot reach.
        withheldByReplayRowCount={
          visible.withheldByReplayRows.length - replay.rowsAdmittedSinceReplayBegan
        }
        hasUnreceivedEntries={ledgerWindow.hasUnreceivedEntries}
        scope={scope}
      />
    </div>
  );
}
