// The ledger, composed: the find field and the feed.
//
// WHAT THIS FILE ADDS TO THE PIECES IT MOUNTS: arrangement, and the callbacks
// that let one of them act on another. Every derivation it renders is
// `ledger-feed-windows.ts`', every scroll it performs is the viewport binding's, and
// every model it drives is `ledger/structure/`'s. Nothing here folds a log, measures
// a row, or writes a `scrollTop`.
//
// TWO GROUPS, AND `../model/` CARRIES A DOOR. `../model/` is what the feed works out —
// the chapter fold, the window chain, the palette's acts, the find-and-jump system,
// and the workspace's follow seat — and
// `surface/` is what draws it: this component, the header, the row and its footer, and
// the row host the pane mounts. The log fixtures two of them share stay at `feed/`, the
// directory that owns both. Every edge runs one way, surface to model — measured with
// the parser, seven edges out of `surface/` and none back — which is exactly the
// condition this package puts a sub-module door on, so this
// side reads through `../model/index.js` and `surface/` stays doorless because nothing
// reads it. `model/index.ts` states what it publishes and why nothing else is on it.
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
// THE THREE SEAMS BETWEEN THE PIECES:
//
//   • Find's walk JUMPS, and it jumps through the viewport's `jumpToRow` — the
//     ledger's one scroll writer. Nothing here touches an element. There is exactly
//     ONE binding, minted by the chain and handed to `<LedgerViewport>`: a second one
//     would leave the find walk reading a virtualizer with no element under it, which
//     is a jump that reports success and scrolls nothing.
//   • Find's result is derived from the same window the feed renders — the viewport's
//     own reconciled snapshot, after the cap — so the boundary find states is the
//     boundary that is actually true of what is on screen. Matches outside that window
//     are counted beside the field rather than walked into and lost — in THREE counts,
//     one per narrowing, because a match the cap took, one a filter is hiding and
//     one a folded chapter holds are three states with three different exits.
//   • A row body is the SEAT's, handed down whole. This file supplies only the three
//     decisions the seat says the list makes.
//
// ONE OF THOSE SEAMS IS A SMALL SYSTEM AND LIVES NEXT DOOR. The find field, the
// classification of an id against four narrowings, the act that answer deserves and
// the jump that has to outlive the render it was asked in are `ledger-feed-find-jump.ts`\'
// — read inside this arrangement they were forty lines of callbacks between two
// elements. What stays here is the composition that hands them their windows.
//
// AND WHAT THIS FILE RENDERS IS A FEW CHILDREN, NOT TWENTY ELEMENTS. What the ledger
// says ABOVE its rows is `LedgerFeedHeader.tsx`' — the find field and the absences a
// person can still act on, one subject. It DERIVES
// NOTHING: every value it takes is a reading already held here, so it cannot become a
// second answer to a question the derivations next door already answer.
//
// AND ONE SEAT THIS MOUNT CLAIMS, for a caller composed before it existed: the
// palette's, so a ledger chord acts on the feed that is up when it fires. Its nine
// acts are built in `ledger-feed-acts.ts`.
//
// THE STRUCTURAL CONTROL OFFERS NO LOAD-EARLIER ACT, and the reason is that it is
// about a different absence. `ledger-visible-window.ts` sets `hasEarlierRows`
// exactly when the window CAP took rows — rows this store still HOLDS — so an offer
// behind that clip would re-admit rows already in memory, which is a decision about
// the cap and the reading pin in `ledger/frame/viewport/` and not a fetch. Wiring the
// backward read to it would send the daemon after rows the console is already
// holding. The clip is passed truthfully either way; the find result states its own
// boundary as the rows it searched and carries no copy of that clip, because no
// surface reading the result would branch on one.
//
// AND THE ACT ITSELF HAS A HOME, which is why the surface takes none: the backward
// read is `frame/paging/`'s, offered by `LoadEarlierAffordance` off the viewport this
// mount already composes, over `earlier-window-reader`'s producer verdict about the
// LOG rather than over the cap's fact about the window. The surface carried a
// handler prop for a while and no caller anywhere supplied one — a button, a CSS
// block and a focus ring for an offer this file had already decided against —
// so the prop went and the readings stayed.

import { useCallback, useMemo } from "react";

import { useConsoleClock } from "@renderer/console/bridge/BridgeProvider.js";
import { LedgerAskTerminalProvider } from "@renderer/console/ledger/cards/index.js";
import { LedgerRowLeaseProvider } from "../../viewport/components/RetainedRowStateProvider.js";
import { LedgerRowRevealProvider } from "../../reveal/components/RowRevealProvider.js";
import { LedgerViewport } from "../../viewport/components/TranscriptViewport.js";
import { LedgerFeedHeader } from "./TranscriptFeedHeader.js";
import {
  LedgerWindowAbsences,
  LedgerWindowReadState,
} from "@renderer/console/ledger/pane/window/index.js";
import { useLedgerRowRenderer } from "@renderer/console/ledger/pane/feed/surface/LedgerFeedRow.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { type TimelineRowRenderer } from "@renderer/console/seats/index.js";
import { useLedgerFeedWindows } from "../hooks/useTranscriptFeedWindows.js";
import { useLedgerFindAndJump } from "../hooks/useTranscriptFindAndJump.js";
import { useLedgerStructureActs } from "@renderer/console/ledger/pane/feed/model/ledger-feed-acts.js";

/** What the feed is a log of and the row body it draws each row through. */
export interface LedgerFeedProps {
  readonly sessionStore: SessionStore;
  /**
   * The deck pane this feed is the body of.
   *
   * Carried rather than derived, because the follow seat is keyed by it: a deck can
   * hold this feed beside a second one, and a chip press names the pane it focused.
   */
  readonly paneId: string;
  /** The row body, from the seat. Resolved by the pane, so this file reads no seat. */
  readonly renderTimelineRow: TimelineRowRenderer;
  /** Names the feed for a screen reader walking the window. */
  readonly feedLabel: string;
}

/** The session's log: the find field, the rows, and what the window does not hold. */
export function LedgerFeed(props: LedgerFeedProps): React.JSX.Element {
  const clock = useConsoleClock();
  const windows = useLedgerFeedWindows({ sessionStore: props.sessionStore, clock });
  const { chapterDisclosure, ledgerFilter, ledgerWindow, viewport, visible } = windows;
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
    visible,
    openedTerminalRunIds: chapterDisclosure.openedTerminalRunIds,
    toggleChapter: chapterDisclosure.toggle,
    setFilter: ledgerFilter.setFilter,
    jumpToRow,
    focusLedgerSurface: viewport.focusSurface,
  });
  const find = findAndJump.find;

  // The STORE's wheel, which is the one the session header reads, handed to the rows so one
  // person wears one color everywhere. A surface asks the session who somebody is
  // rather than deciding it again from the order this window happened to meet them in.
  // `assignmentFor` never allocates, so an actor the wheel has never admitted
  // answers `undefined`: the row renders its unattributed shape rather than being
  // handed a color nobody else would agree with.
  const hueForActor = useCallback(
    (userId: string) => props.sessionStore.hueAllocator.assignmentFor(userId),
    [props.sessionStore],
  );

  const toggleChapter = chapterDisclosure.toggle;
  const openedTerminalRunIds = chapterDisclosure.openedTerminalRunIds;
  const rowLease = viewport.rowLease;
  const setRowLease = viewport.setRowLease;
  // Named off the props object rather than read through it, because the callback
  // below keys on this and `props` is a fresh object on every render. Depending on
  // the whole object rebuilt `renderRow` on every render of this feed — a find
  // keystroke, a lease write — and `LedgerRowMount`'s memo compares it, so every
  // mounted row re-rendered for a change none of them could see.
  const renderTimelineRow = props.renderTimelineRow;
  const rowLeaseChannel = useMemo(() => ({ setLease: setRowLease }), [setRowLease]);
  const renderRow = useLedgerRowRenderer({
    ledgerWindow,
    openedTerminalRunIds,
    hueForActor,
    toggleChapter,
    rowLease,
    renderTimelineRow,
  });

  // The palette's chords and the session header's chips both act on whichever ledger is
  // mounted when they fire, and neither can import this component. Both seats are
  // claimed here for the mount's lifetime; what each act does is its own module's.
  const collapseAllTerminal = chapterDisclosure.collapseAllTerminal;
  const collapseAllTerminalChapters = useCallback(() => {
    collapseAllTerminal([...ledgerWindow.chapterByHeaderKey.values()]);
  }, [collapseAllTerminal, ledgerWindow]);
  useLedgerStructureActs({
    find,
    jumpToRow,
    jumpToTail: viewport.jumpToTail,
    collapseAllTerminalChapters,
    ledgerFilter,
  });

  return (
    <div className="meridian-ledger">
      <LedgerFeedHeader findAndJump={findAndJump} />
      <div className="meridian-ledger__body">
        <LedgerRowLeaseProvider channel={rowLeaseChannel}>
          <LedgerRowRevealProvider channel={windows.reveal.channel}>
            {/* INSIDE the two row channels and around the viewport, because it is read
                by one row body and not by the list: the ask card asks for its own ask's
                terminal, and every other row consumes nothing here.

                THE CHAIN'S FOLD AND NOT THIS WINDOW'S. `ledgerWindow` is what the filter
                and the chapter fold left, and a narrowing that admits
                a request row while excluding the row that answered it must not be able
                to take the terminal with it — the card would then offer answer controls
                for an ask the log had already settled. */}
            <LedgerAskTerminalProvider terminalsByAskIdentity={windows.askTerminalByAskIdentity}>
              <LedgerViewport
                binding={viewport}
                renderRow={renderRow}
                feedLabel={props.feedLabel}
                firstReadSettled={windows.firstReadSettled}
                hasActiveTurn={ledgerWindow.hasActiveTurn}
                earlierPaging={windows.earlierPaging}
              />
            </LedgerAskTerminalProvider>
          </LedgerRowRevealProvider>
        </LedgerRowLeaseProvider>
      </div>
      <LedgerWindowReadState sessionStore={props.sessionStore} />
      <LedgerWindowAbsences
        unprojectableEventCount={ledgerWindow.unprojectableEventCount}
        droppedRowCount={visible.prunedAwayRows.length}
        hasUnreceivedEntries={ledgerWindow.hasUnreceivedEntries}
      />
    </div>
  );
}
