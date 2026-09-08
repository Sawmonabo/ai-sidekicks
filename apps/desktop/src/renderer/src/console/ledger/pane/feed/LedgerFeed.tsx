// The ledger, composed: the rail, the find field, the feed, and the replay dock.
//
// WHAT THIS FILE ADDS TO THE PIECES IT MOUNTS: arrangement, and the four callbacks
// that let one of them act on another. Every derivation it renders is
// `ledger-feed-windows.ts`', every scroll it performs is the viewport binding's, and
// every model it drives is `ledger/structure/`'s. Nothing here folds a log, measures
// a row, or writes a `scrollTop`.
//
// WHY THE FEED IS A COMPONENT OF ITS OWN RATHER THAN THE PANE'S BODY. The pane owns
// chrome — a header, a heading id, and the row seat's two absences — and can render
// every one of those with no session store at all. The feed cannot exist without
// one: it subscribes to a log. Splitting them is what lets the pane hold the
// `undefined` arm as an ordinary render instead of as a conditional hook, which
// React does not allow and which a single component would have forced.
//
// AND WHY THE WINDOW CHAIN IS A MODULE OF ITS OWN RATHER THAN THE TOP OF THIS ONE.
// The stages between the store and the screen are only truthful in one order, and
// three of them state why at their own call site — `ledger-feed-windows.ts` is where
// that order lives, so the ordering has one home and this file has none of it. What
// is left here is the arrangement and the seams.
//
// THE FOUR SEAMS BETWEEN THE PIECES:
//
//   • The rail's tick and find's walk both JUMP, and both jump through the
//     viewport's `jumpToRow` — the ledger's one scroll writer. Neither touches an
//     element. There is exactly ONE binding, minted by the chain and handed to
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
// derivations next door already answer.
//
// AND TWO SEATS THIS MOUNT CLAIMS, both for callers composed before it existed: the
// palette's, so a ledger chord acts on the feed that is up when it fires, and the
// workspace's follow seat, so a cast chip scrolls this ledger through this ledger's
// own chokepoint. The palette's nine acts are built in `ledger-feed-acts.ts` and the
// follow seat in `ledger-actor-follow-seat.ts`.
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

import { useCallback, useMemo } from "react";

import { useConsoleClock } from "../../../bridge/index.js";
import { LedgerAskTerminalProvider } from "../../cards/index.js";
import {
  LedgerRowLeaseProvider,
  LedgerRowRevealProvider,
  LedgerViewport,
  type LedgerScope,
} from "../../frame/index.js";
import { LedgerFeedHeader } from "./LedgerFeedHeader.js";
import { LedgerFeedRail } from "./LedgerFeedRail.js";
import { LedgerWindowAbsences, LedgerWindowReadState, useRailGeometry } from "../window/index.js";
import { useLedgerRowRenderer } from "./LedgerFeedRow.js";
import { type SessionStore } from "../../../store/index.js";
import { type TimelineRowRenderer } from "../../../seats/index.js";
import { useActorFollowSeat } from "./ledger-actor-follow-seat.js";
import { buildReplayFromRowAct, useLedgerStructureActs } from "./ledger-feed-acts.js";
import { LedgerRowOffersMenu, useLedgerRowOffers } from "./row-offers/index.js";
import { useLedgerFeedWindows } from "./ledger-feed-windows.js";
import {
  useLedgerFindAndJump,
  useReplayDockConcealOnFocusLeaving,
} from "./ledger-feed-find-jump.js";
import { useReplayAnchorRowId } from "../replay/index.js";

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
  const windows = useLedgerFeedWindows({
    sessionStore: props.sessionStore,
    channelId: props.channelId,
    clock,
  });
  const {
    chapterDisclosure,
    ledgerFilter,
    ledgerWindow,
    replay,
    supersededBandDisclosure,
    viewport,
    visible,
  } = windows;
  const jumpToRow = viewport.jumpToRow;
  // THE FIELD, THE CLASSIFICATION, AND THE ACT — one seam, wired next door.
  // Every window between the loaded log and the screen goes in, because the answer
  // is not whether a row is on screen but which narrowing is the reason it is not.
  const findAndJump = useLedgerFindAndJump({
    unfurledWindow: windows.unfurledWindow,
    narrowedWindow: windows.narrowing.window,
    foldedWindow: ledgerWindow,
    filteredAwayRows: windows.narrowing.removedRows,
    foldedAwayRows: windows.chapterFold.removedRows,
    bandFoldedAwayRows: windows.bandFold.removedRows,
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
    childRunDisclosure: windows.childRunDisclosure,
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
          <LedgerRowRevealProvider channel={windows.reveal.channel}>
            {/* INSIDE the two row channels and around the viewport, because it is read
                by one row body and not by the list: the ask card asks for its own ask's
                terminal, and every other row consumes nothing here. */}
            <LedgerAskTerminalProvider
              terminalsByAskIdentity={ledgerWindow.askTerminalByAskIdentity}
            >
              <LedgerViewport
                binding={viewport}
                renderRow={renderRow}
                feedLabel={props.feedLabel}
                scope={scope}
                peerInvocationEnabled={windows.peerInvocationEnabled}
                firstReadSettled={windows.firstReadSettled}
                hasActiveTurn={ledgerWindow.hasActiveTurn}
                earlierPaging={windows.earlierPaging}
              />
            </LedgerAskTerminalProvider>
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
        //
        // THE WINDOW-SCOPED READING, because this pile is this window's. An arrival
        // the fold or the facet bar is hiding never reached `withheldByReplayRows`,
        // so subtracting the log-wide count here would take away rows that pile
        // never held and understate what scrubbing forward brings back.
        withheldByReplayRowCount={
          visible.withheldByReplayRows.length - replay.rowsAdmittedIntoThisWindowSinceReplayBegan
        }
        hasUnreceivedEntries={ledgerWindow.hasUnreceivedEntries}
        scope={scope}
      />
    </div>
  );
}
