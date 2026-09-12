// What one row of this feed draws, and the memo that keeps a frame from redrawing it.
//
// THE DISPATCH AND THE BOUNDARY ARE ONE JOB, so they are one module: most of the
// list's rows are the ledger's OWN — a chapter header, a superseded-band header, a
// seam, a child-run summary, a handoff, and the named absence of a row the cap took
// mid-frame — and exactly one arm is the seat's. Deciding which arm a key is takes a
// handful of map reads; drawing the seat's is a whole card. The hook does the reads
// and the component holds the card behind a memo. The arms are enumerated rather than
// counted here, because a count in prose is a claim that goes stale the next time one
// is added and nothing reports it.
//
// WHY THE BOUNDARY IS HERE AND NOT ON `LedgerRowMount`. The viewport already memoizes
// each row's box, and that memo compares the `renderRow` callback — which closes over
// the whole derived window. The window is a new object on every admitted event, so
// the callback's identity moves on every admitted event, so that memo cannot hold
// across one. It was never meant to: the callback is where a row's body is LOOKED UP,
// and a lookup that could not see a changed window would draw a stale card.
//
// So the boundary is drawn one level lower, where the lookups have already happened.
// `renderRow` runs — cheap, and correct — and what it returns for the seat's arm is a
// component whose props are the four values the seat is actually handed. React
// compares those and bails out of the body when none of them moved. The row's own memo
// keeps the box; this one keeps the CARD, which is where a frame's work is.
//
// EVERY ONE OF THE FOUR IS IDENTITY-STABLE WHEN NOTHING MOVED, which is what makes the
// comparison meaningful rather than decorative:
//
//   • `row` — held across projections by `ledger-window.ts`'s retention table. Without
//     that this memo would compare a fresh object every event and never hold.
//   • `participantHue` — the store's own assignment object, read and never minted.
//   • `isSuperseded` and `density` — a boolean and a two-value union.
//   • `chapterRunId` — a string or `undefined`, resolved by the lookup below rather
//     than by the card. The WINDOW is what answers whether this row's run has a
//     chapter here, and handing the window down instead would put a fresh object on
//     every admitted event into the comparison and stop the memo holding at all.
//   • `rowOffers` — the feed's binding, minted once and reading its live surfaces
//     through a ref, which is what lets a press act on the committed window without
//     the binding moving when that window does.
//
// AND THE RENDERER IS THE SEAT'S, handed down from the pane and stable for the life of
// the registration. A caller that rebuilt it per render would move this memo on every
// render, which is the defect `LedgerFeed.renders.test.tsx` drives one level up.

import { memo, useCallback } from "react";

import type { FilePathRef } from "@ai-sidekicks/contracts";

import {
  type LedgerRowLease,
  type LedgerRowRenderer,
  type LedgerViewportRow,
} from "../../../frame/index.js";
import { ChapterHeader, type LedgerChapter } from "../../../structure/index.js";
// The seam row through its own directory's door rather than the family's: that door
// owns the seam vocabulary this row draws AND the sheet that dresses it.
import { SeamRow, SupersededBandRow } from "../../../structure/seams/index.js";
// The child-run and handoff rows through their own directory's door, for the seam
// row's reason: that door owns the two treatments AND the sheet that dresses them.
import {
  ChildRunSummaryRow,
  HandoffRow,
  type ChildRunDisclosure,
} from "../../../structure/child-runs/index.js";
import { densityFor, type LedgerSupersededBandDisclosure } from "../model/index.js";
import { chapterRunIdInWindow } from "../../find/index.js";
import { LedgerRowMenu, type LedgerRowOffersBinding } from "../row-offers/index.js";
import { Nothing } from "../../../../primitives/index.js";
import {
  timelineRowFooterRenderer,
  type TimelineRowFooterRenderer,
  type TimelineRowRenderer,
  type TimelineRowSlotProps,
} from "../../../../seats/index.js";
import { TimelineRowFooter } from "./TimelineRowFooter.js";
import { type ParticipantHueAssignment } from "../../../../tokens/index.js";
import { type LedgerWindowModel } from "../../window/index.js";

/** Everything the dispatch below reads. Each member is stable except the window. */
export interface LedgerRowRendererOptions {
  readonly ledgerWindow: LedgerWindowModel;
  readonly openedTerminalRunIds: ReadonlySet<string>;
  readonly hueForActor: (participantId: string) => ParticipantHueAssignment | undefined;
  readonly toggleChapter: (chapter: LedgerChapter) => void;
  readonly rowLease: (rowKey: string) => LedgerRowLease | undefined;
  /** The seat's renderer. STABLE across renders, or the memo below moves with it. */
  readonly renderTimelineRow: TimelineRowRenderer;
  /** This mount's child-run expansions. STABLE, for the same reason. */
  readonly childRunDisclosure: ChildRunDisclosure;
  /** This mount's superseded-band folds. STABLE, for the same reason. */
  readonly supersededBandDisclosure: LedgerSupersededBandDisclosure;
  /** This mount's per-row offers. STABLE, for the same reason. */
  readonly rowOffers: LedgerRowOffersBinding;
}

export interface LedgerFeedRowProps extends TimelineRowSlotProps {
  /** The seat's renderer. STABLE across renders, or this memo moves with it. */
  readonly renderTimelineRow: TimelineRowRenderer;
  /** The footer seat's renderer, or `undefined` while nobody has filled it. */
  readonly renderTimelineRowFooter: TimelineRowFooterRenderer | undefined;
  /** The run whose chapter this window holds for this row, or `undefined`. */
  readonly chapterRunId: string | undefined;
  /** This window's offer binding. STABLE, or this memo moves with it. */
  readonly rowOffers: LedgerRowOffersBinding;
}

/**
 * Build the feed's row renderer.
 *
 * Its identity moves whenever the window does, and that is deliberate: the window is
 * what a row's body is looked up in, so a callback pinned across a changed window
 * would hand the viewport a lookup that could not see the change.
 */
export function useLedgerRowRenderer(options: LedgerRowRendererOptions): LedgerRowRenderer {
  const { ledgerWindow, openedTerminalRunIds, hueForActor, toggleChapter, rowLease } = options;
  const renderTimelineRow = options.renderTimelineRow;
  const childRunDisclosure = options.childRunDisclosure;
  const supersededBandDisclosure = options.supersededBandDisclosure;
  // The FOOTER seat, read here rather than threaded from the pane: unlike the row
  // body it is filled by a plan this console does not compose, so there is no props
  // chain to carry it down. A plain read of a module-scope registration filled
  // before first paint, and identity-stable for the life of that registration —
  // which is what the memo below compares.
  const renderTimelineRowFooter = timelineRowFooterRenderer();
  const rowOffers = options.rowOffers;
  return useCallback(
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
      // A BAND HEADER IS A ROW OF THE LIST TOO, keyed by the band it heads, and
      // dispatched here for the chapter header's reason: no projected row backs it
      // and none was ever meant to. It says what one rollback rewound — the turn it
      // landed on and how many rows it moved — which until now reached a person only
      // as a dim on each of those rows, one at a time.
      const band = ledgerWindow.supersededBandByHeaderKey.get(row.key);
      if (band !== undefined) {
        return (
          <SupersededBandRow
            band={band}
            isFolded={supersededBandDisclosure.foldedBandKeys.has(row.key)}
            onToggle={supersededBandDisclosure.toggle}
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
      // A CHILD RUN AND A HANDOFF ARE THE LEDGER'S OWN ROWS TOO, drawn before the
      // seat is asked and for the seam's reason: both are structure over the log
      // rather than a body somebody wrote, and both were falling through to the
      // generic renderer — a child run as a receipt with its state, count and
      // producing node dropped, and a handoff as a message with the two actors it
      // moved work between nowhere on screen.
      const childRunEntry = ledgerWindow.childRunEntryByRowId.get(projected.id);
      if (childRunEntry !== undefined) {
        return (
          <ChildRunSummaryRow
            entry={childRunEntry}
            wireType={projected.type}
            participantHue={participantHue}
            isSuperseded={isSuperseded}
            expansion={childRunDisclosure.expansionFor(childRunEntry.summary.runId)}
            onToggleExpansion={childRunDisclosure.toggle}
            // THE SAME SEAT AND THE SAME ALLOCATOR THE LIST'S OWN ROWS TAKE, handed
            // down rather than looked up again inside the row: an expansion draws the
            // child run's entries, and a child's row and its parent's are the same
            // kind of thing. Two lookups would be two chances for them to differ.
            renderTimelineRow={renderTimelineRow}
            hueForActor={hueForActor}
          />
        );
      }
      const handoffEntry = ledgerWindow.handoffEntryByRowId.get(projected.id);
      if (handoffEntry !== undefined) {
        return (
          <HandoffRow
            entry={handoffEntry}
            participantHue={participantHue}
            isSuperseded={isSuperseded}
            // The thread reaches a CHAPTER, so it is drawn only where the child run
            // has one in this window. A chapter the fold has not produced is a
            // chapter the line would point past.
            hasThreadTarget={
              handoffEntry.childRunId !== undefined &&
              ledgerWindow.chapterByHeaderKey.has(handoffEntry.childRunId)
            }
          />
        );
      }
      // THROUGH `LedgerFeedRow` RATHER THAN STRAIGHT INTO THE SEAT, and the
      // indirection is the memo boundary — see that file. This callback's identity
      // moves on every admitted event because it closes over the window, so the
      // viewport's own row memo cannot hold across one; the four values below are
      // identity-stable when nothing about the row moved, so the card behind them
      // does hold. What runs per row per event is these lookups, not the card.
      return (
        <LedgerFeedRow
          row={projected}
          participantHue={participantHue}
          isSuperseded={isSuperseded}
          // THE LEASE OVERLAYS THE LIST, and the list is the fallback rather than the
          // other way round: a row nobody has touched holds no lease and follows the
          // chapter fold, and a row somebody opened keeps that choice across an
          // unmount and across a prune, because the window re-parks it.
          density={
            rowLease(projected.id)?.density ??
            densityFor(projected.id, ledgerWindow.collapsedRowIds)
          }
          renderTimelineRow={renderTimelineRow}
          renderTimelineRowFooter={renderTimelineRowFooter}
          // RESOLVED HERE AND NOT IN THE MENU, because the question is about the
          // WINDOW and not about the row: a row names its run, and whether this
          // window draws that run's header is what decides whether a jump can land.
          // `chapterRunIdInWindow` is the find walk's own reading of exactly that,
          // taken rather than restated so a jump from the menu and a jump from the
          // find field open the same chapter.
          chapterRunId={chapterRunIdInWindow(projected, ledgerWindow)}
          rowOffers={rowOffers}
        />
      );
    },
    [
      childRunDisclosure,
      hueForActor,
      ledgerWindow,
      openedTerminalRunIds,
      renderTimelineRow,
      rowLease,
      rowOffers,
      supersededBandDisclosure,
      renderTimelineRowFooter,
      toggleChapter,
    ],
  );
}

/**
 * The body a row carries into its offers, which on this build is none.
 *
 * The seat a row is rendered through carries the row and the list's three decisions
 * about it, and no body: a machine-authored body reaches a reader through the
 * hydrated read, which the growth slate carries as the unregistered
 * `hydrated-event-read` row, so `MachineBody` renders its named absence on every
 * machine row here. A constant with the reason on it, rather than a literal at the
 * mount below, so the fact has one home and one line to edit the day the read lands.
 */
const NO_ROW_BODY: string | undefined = undefined;

/**
 * The path token a row carries into its offers, which on this build is none.
 *
 * `FilePathRef` is branded so that only the main process can mint one, so this
 * absence is structural rather than a convention: it ends the day the timeline read
 * serves a validated path reference, which is the growth slate's
 * `timeline-path-reference` row, and nothing else here changes.
 */
const NO_ROW_PATH_REFERENCE: FilePathRef | undefined = undefined;

/**
 * Draw one row through the seat.
 *
 * Adds no BOX of its own: the row box, the error boundary and the ARIA position are
 * the viewport's, and a wrapper element here would put a second box between the feed
 * and the article the row role is declared on. The footer is a SIBLING of the body
 * inside that article rather than a wrapper around it, which is why it does not
 * break that rule — and it is drawn under the body because that is where the design
 * puts a row-level control.
 *
 * THE MENU IS A SIBLING OF THE FOOTER AND NOT INSIDE IT, and the two are different
 * offers about different things. The footer is one seat another plan fills with the
 * affordance that corrects what a participant SENT, and it is offered on participant
 * message rows alone; the menu is this family's own, offered on every row, and it
 * carries the offers the row vocabulary states — open, close, copy the id, copy the
 * body, jump to the run chapter, reveal the file. Folding either
 * into the other would give one plan's seat a say over every row, or put this
 * family's control inside a body it does not own.
 *
 * An ARROW WITH A DECLARED RETURN TYPE rather than a named function expression, so
 * this module resolves as the one component it declares: the one-component rule is
 * read off declarations, and a function
 * EXPRESSION inside `memo(...)` is neither a declaration nor an arrow, so the module
 * would declare none — clean against a rule that was never applied to it.
 */
const LedgerFeedRow = memo(
  (props: LedgerFeedRowProps): React.ReactNode => (
    <>
      {props.renderTimelineRow({
        row: props.row,
        participantHue: props.participantHue,
        isSuperseded: props.isSuperseded,
        density: props.density,
      })}
      <TimelineRowFooter
        row={props.row}
        isSuperseded={props.isSuperseded}
        renderFooter={props.renderTimelineRowFooter}
      />
      <LedgerRowMenu
        row={props.row}
        density={props.density}
        chapterRunId={props.chapterRunId}
        bodyText={NO_ROW_BODY}
        pathReference={NO_ROW_PATH_REFERENCE}
        offers={props.rowOffers}
      />
    </>
  ),
);
LedgerFeedRow.displayName = "LedgerFeedRow";
