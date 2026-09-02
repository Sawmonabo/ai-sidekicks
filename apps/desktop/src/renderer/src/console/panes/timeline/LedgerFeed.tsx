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
//   • The replay dock's reveal is the caller's, per §5.5: the dock is hidden until
//     the rail is hovered or focused, because both triggers are facts about this
//     surface rather than about replay. What the dock's POSITION reveals is the
//     rows: the viewport is given the rows the position has reached, so playing or
//     scrubbing moves the ledger rather than only its timestamp.
//   • Find's result and the rail's marks are derived from the same window the feed
//     renders — the viewport's own reconciled snapshot, after the cap — so the
//     boundary find states is the boundary that is actually true of what is on
//     screen, and every tick the rail draws is a row the viewport can scroll to.
//     Matches the cap has taken out of the window are counted beside the field
//     rather than walked into and lost.
//   • A row body is the SEAT's, handed down whole. This file supplies only the three
//     decisions the seat says the list makes.
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

import { useCallback } from "react";

import { useConsoleClock } from "../../bridge/index.js";
import {
  LedgerViewport,
  type LedgerViewportRow,
  useLedgerViewport,
} from "../../ledger/frame/index.js";
import { FindInLedger, ProvenanceRail, ReplayControls } from "../../ledger/structure/index.js";
import { Nothing } from "../../primitives/index.js";
import { type SessionStore } from "../../store/index.js";
import { type TimelineRowRenderer } from "../../workspace/index.js";
import { useActorFollowSeat, useLedgerStructureActs } from "./ledger-feed-acts.js";
import {
  useLedgerFind,
  useLedgerReplay,
  useRailGeometry,
  useReplayRevealedRows,
  useVisibleLedgerWindow,
} from "./ledger-feed-model.js";
import { densityFor, useLedgerWindow } from "./ledger-window.js";

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
  const replay = useLedgerReplay(ledgerWindow);
  // What the replay position has reached. The whole window while nobody is
  // replaying, so a ledger with the dock closed pays nothing and reconciles nothing.
  const revealedViewportRows = useReplayRevealedRows(ledgerWindow, replay.position);

  const viewport = useLedgerViewport({
    clock,
    rows: revealedViewportRows,
    hasActiveTurn: ledgerWindow.hasActiveTurn,
    isRevealDraining: false,
  });

  // Read back off the viewport's own reconciled snapshot, so find and the rail are
  // looking at the window on screen rather than at the log behind it.
  const visible = useVisibleLedgerWindow(ledgerWindow, viewport.snapshot.rows);
  const find = useLedgerFind(visible);

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
        participantHue: projected.actor === undefined ? undefined : hueForActor(projected.actor),
        isSuperseded: ledgerWindow.supersededRowIds.has(projected.id),
        density: densityFor(projected.id, ledgerWindow.collapsedRowIds),
      });
    },
    [hueForActor, ledgerWindow, props],
  );

  const geometry = useRailGeometry(viewport.virtualItems, viewport.snapshot.rows.length);
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

  // The palette's chords and the cast bar's chips both act on whichever ledger is
  // mounted when they fire, and neither can import this component. Both seats are
  // claimed here for the mount's lifetime; what each act does is `ledger-feed-acts.ts`'.
  useLedgerStructureActs({ find, replay, jumpToRow, jumpToTail: viewport.jumpToTail });
  useActorFollowSeat({ visibleRows: visible.rows, jumpToRow });

  return (
    <div className="meridian-ledger">
      {find.isOpen ? (
        <FindInLedger
          query={find.query}
          result={find.result}
          currentMatchIndex={find.currentMatchIndex}
          onQueryChange={find.setQuery}
          onStep={onStepFind}
          onClose={find.close}
        />
      ) : null}
      <LedgerMatchesOutsideWindowNotice count={find.beyondWindowMatchCount} />
      <div className="meridian-ledger__body">
        <LedgerViewport
          binding={viewport}
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
          />
        </div>
      </div>
      <LedgerWindowAbsences
        unprojectableEventCount={ledgerWindow.unprojectableEventCount}
        droppedRowCount={visible.prunedAwayRows.length}
        hasUnreceivedEntries={ledgerWindow.hasUnreceivedEntries}
      />
    </div>
  );
}

/** Matches the query found in rows the cap has taken out of this window. */
function LedgerMatchesOutsideWindowNotice(props: {
  readonly count: number;
}): React.JSX.Element | null {
  if (props.count === 0) {
    return null;
  }
  return (
    <Nothing
      kind="not-loaded"
      placement="inline"
      title="Some matches are outside this window."
      detail={`${String(props.count)} more entr${props.count === 1 ? "y" : "ies"} match, in older rows this window no longer holds. The walk steps only through rows the feed can scroll to.`}
    />
  );
}

interface LedgerWindowAbsencesProps {
  /** Events the contract package registers no category for. */
  readonly unprojectableEventCount: number;
  /** Rows the log holds and this window does not, because the cap took them. */
  readonly droppedRowCount: number;
  /** The store recorded sequences it never received. */
  readonly hasUnreceivedEntries: boolean;
}

/**
 * The three ways this window is not the whole session, each said out loud.
 *
 * Three separate sentences because a person's next move differs for each: an
 * unrecognised type is this build's limit, a dropped row is the window's cap, and a
 * sequence that never arrived is the stream's. Collapsing any two would tell
 * somebody the console failed where it merely stopped holding, or the reverse.
 *
 * Each of them names the read that is missing rather than offering a control for
 * it, which is what replaced the "load earlier" button: this console holds one live
 * subscription and a whole-session snapshot read, and neither takes a cursor.
 */
function LedgerWindowAbsences(props: LedgerWindowAbsencesProps): React.JSX.Element | null {
  if (
    props.unprojectableEventCount === 0 &&
    props.droppedRowCount === 0 &&
    !props.hasUnreceivedEntries
  ) {
    return null;
  }
  return (
    <>
      {props.unprojectableEventCount === 0 ? null : (
        <Nothing
          kind="not-checked"
          placement="surface"
          title="Some entries could not be placed."
          detail={`${String(props.unprojectableEventCount)} event${props.unprojectableEventCount === 1 ? "" : "s"} arrived with a type this build does not recognise, so they are not shown.`}
        />
      )}
      {props.droppedRowCount === 0 ? null : (
        <Nothing
          kind="not-loaded"
          placement="surface"
          title="Older entries are no longer in this window."
          detail={`${String(props.droppedRowCount)} entr${props.droppedRowCount === 1 ? "y" : "ies"} left the window as the session grew. This console subscribes to the log and holds no read that fetches a range of it, so there is nothing to press here.`}
        />
      )}
      {props.hasUnreceivedEntries ? (
        <Nothing
          kind="not-loaded"
          placement="surface"
          title="Some entries never arrived."
          detail="The session numbered entries this window did not receive. They come back only when the whole session is read again, which the store asks for on its own; no read here fetches a range."
        />
      ) : null}
    </>
  );
}
