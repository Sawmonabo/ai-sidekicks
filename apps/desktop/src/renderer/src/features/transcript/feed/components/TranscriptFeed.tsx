// The transcript, composed: the find field and the feed.
//
// WHAT THIS FILE ADDS TO THE PIECES IT MOUNTS: arrangement, and the callbacks that let
// one of them act on another. Every derivation it renders is `useTranscriptFeedWindows`',
// every scroll it performs is the viewport binding's, and every model it drives is the
// feature's own. Nothing here folds a log, measures a row, or writes a `scrollTop`.
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
// `useTranscriptFeedWindows` is where that order lives, so the ordering has one home and
// this file has none of it. What is left here is the arrangement and the seams.
//
// THE THREE SEAMS BETWEEN THE PIECES:
//
//   • Find's walk JUMPS, and it jumps through the viewport's `jumpToRow` — the
//     transcript's one scroll writer. Nothing here touches an element. There is exactly
//     ONE binding, minted by the chain and handed to `<TranscriptViewport>`: a second one
//     would leave the find walk reading a virtualizer with no element under it, which
//     is a jump that reports success and scrolls nothing.
//   • Find's result is derived from the same window the feed renders — the viewport's
//     own reconciled snapshot, after the cap — so the boundary find states is the
//     boundary that is actually true of what is on screen. Matches outside that window
//     are counted beside the field rather than walked into and lost — in TWO counts,
//     because a match the cap took and one a folded chapter holds are two states with
//     two different exits.
//   • A row body is the SEAT's, handed down whole. This file supplies only the three
//     decisions the seat says the list makes.
//
// AND WHAT THIS FILE RENDERS IS A FEW CHILDREN, NOT TWENTY ELEMENTS. What the transcript
// says ABOVE its rows is `TranscriptFeedHeader.tsx`' — the find field and the counts a
// person can still act on, one subject. It DERIVES NOTHING: every value it takes is a
// reading already held here, so it cannot become a second answer to a question the
// derivations next door already answer.
//
// AND ONE SEAT THIS MOUNT CLAIMS, for a caller composed before it existed: the
// palette's, so a transcript chord acts on the feed that is up when it fires. Its five
// acts are built in `transcript-structure-acts.ts`.
//
// THE STRUCTURAL CONTROL OFFERS NO LOAD-EARLIER ACT, and the reason is that it is
// about a different absence. `useVisibleTranscriptWindow` sets `hasEarlierRows` exactly
// when the window CAP took rows — rows this store still HOLDS — so an offer behind that
// clip would re-admit rows already in memory, which is a decision about the cap and the
// reading pin in `viewport/` and not a fetch. Wiring the backward read to it would send
// the daemon after rows the window is already holding. The backward read is `history/`'s,
// offered off the viewport this mount already composes, over the producer's verdict
// about the LOG rather than over the cap's fact about the window.

import { useCallback, useMemo } from "react";
import { useConsoleClock } from "@renderer/services/platform/hooks/useClock.js";
import { RetainedRowStateProvider } from "../../viewport/components/RetainedRowStateProvider.js";
import { LedgerRowRevealProvider } from "../../reveal/components/RowRevealProvider.js";
import { TranscriptViewport } from "../../viewport/components/TranscriptViewport.js";
import { TranscriptFeedHeader } from "./TranscriptFeedHeader.js";
import { TranscriptWindowNotices } from "../../window/components/TranscriptWindowNotices.js";
import { TranscriptReadState } from "../../window/components/TranscriptReadState.js";
import { useTranscriptRowRenderer } from "../hooks/useTranscriptRowRenderer.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { type TimelineRowRenderer } from "@renderer/console/seats/index.js";
import { useTranscriptFeedWindows } from "../hooks/useTranscriptFeedWindows.js";
import { useTranscriptFindAndJump } from "../hooks/useTranscriptFindAndJump.js";
import { useTranscriptStructureActs } from "../hooks/useTranscriptStructureActs.js";

/** What the feed is a log of and the row body it draws each row through. */
export interface TranscriptFeedProps {
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
export function TranscriptFeed(props: TranscriptFeedProps): React.JSX.Element {
  const clock = useConsoleClock();
  const windows = useTranscriptFeedWindows({ sessionStore: props.sessionStore, clock });
  const { chapterDisclosure, ledgerWindow, viewport, visible } = windows;
  const jumpToRow = viewport.jumpToRow;
  // THE FIELD AND ITS WALK — one seam, wired next door.
  const findAndJump = useTranscriptFindAndJump({
    foldedAwayRows: windows.chapterFold.removedRows,
    visible,
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
  // keystroke, a lease write — and `VirtualRow`'s memo compares it, so every
  // mounted row re-rendered for a change none of them could see.
  const renderTimelineRow = props.renderTimelineRow;
  const rowLeaseChannel = useMemo(() => ({ setLease: setRowLease }), [setRowLease]);
  const renderRow = useTranscriptRowRenderer({
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
  useTranscriptStructureActs({
    find,
    jumpToRow,
    jumpToTail: viewport.jumpToTail,
    collapseAllTerminalChapters,
  });

  return (
    <div className="meridian-ledger">
      <TranscriptFeedHeader findAndJump={findAndJump} />
      <div className="meridian-ledger__body">
        <RetainedRowStateProvider channel={rowLeaseChannel}>
          <LedgerRowRevealProvider channel={windows.reveal.channel}>
            <TranscriptViewport
              binding={viewport}
              renderRow={renderRow}
              feedLabel={props.feedLabel}
              firstReadSettled={windows.firstReadSettled}
              hasActiveTurn={ledgerWindow.hasActiveTurn}
              earlierPaging={windows.earlierPaging}
            />
          </LedgerRowRevealProvider>
        </RetainedRowStateProvider>
      </div>
      <TranscriptReadState sessionStore={props.sessionStore} />
      <TranscriptWindowNotices
        unprojectableEventCount={ledgerWindow.unprojectableEventCount}
        droppedRowCount={visible.prunedAwayRows.length}
        hasUnreceivedEntries={ledgerWindow.hasUnreceivedEntries}
      />
    </div>
  );
}
