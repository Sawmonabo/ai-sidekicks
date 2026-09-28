// What one row of this feed draws, and the memo that keeps a frame from redrawing it.
//
// THE DISPATCH AND THE BOUNDARY ARE ONE JOB, so they are one module: most of the
// list's rows are the ledger's OWN — a chapter header, a seam, and the named absence of
// a row the cap took mid-frame — and exactly one arm is the seat's. Deciding which arm a
// key is takes a handful of map reads; drawing the seat's is a whole card. The hook does
// the reads and the component holds the card behind a memo. The arms are enumerated
// rather than counted here, because a count in prose is a claim that goes stale the next
// time one is added and nothing reports it.
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
// component whose props are the values the seat is actually handed. React
// compares those and bails out of the body when none of them moved. The row's own memo
// keeps the box; this one keeps the CARD, which is where a frame's work is.
//
// EVERY ONE OF THEM IS IDENTITY-STABLE WHEN NOTHING MOVED, which is what makes the
// comparison meaningful rather than decorative:
//
//   • `row` — held across projections by `ledger-window.ts`'s retention table. Without
//     that this memo would compare a fresh object every event and never hold.
//   • `actorHue` — the store's own assignment object, read and never minted.
//   • `isSuperseded` and `density` — a boolean and a two-value union.
//
// AND THE RENDERER IS THE SEAT'S, handed down from the pane and stable for the life of
// the registration. A caller that rebuilt it per render would move this memo on every
// render, which is the defect `LedgerFeed.renders.test.tsx` drives one level up.

import { memo, useCallback } from "react";

import {
  type LedgerRowLease,
  type LedgerRowRenderer,
  type LedgerViewportRow,
} from "../../../frame/index.js";
import { ChapterHeader, type LedgerChapter } from "../../../structure/index.js";
// The seam row through its own directory's door rather than the family's: that door
// owns the seam vocabulary this row draws AND the sheet that dresses it.
import { SeamRow } from "../../../structure/seams/index.js";
import { densityFor } from "../model/index.js";
import { Nothing } from "../../../../primitives/index.js";
import {
  timelineRowFooterRenderer,
  type TimelineRowFooterRenderer,
  type TimelineRowRenderer,
  type TimelineRowSlotProps,
} from "../../../../seats/index.js";
import { TimelineRowFooter } from "./TimelineRowFooter.js";
import { type ActorHueAssignment } from "../../../../tokens/index.js";
import { type LedgerWindowModel } from "../../window/index.js";

/** Everything the dispatch below reads. Each member is stable except the window. */
export interface LedgerRowRendererOptions {
  readonly ledgerWindow: LedgerWindowModel;
  readonly openedTerminalRunIds: ReadonlySet<string>;
  readonly hueForActor: (userId: string) => ActorHueAssignment | undefined;
  readonly toggleChapter: (chapter: LedgerChapter) => void;
  readonly rowLease: (rowKey: string) => LedgerRowLease | undefined;
  /** The seat's renderer. STABLE across renders, or the memo below moves with it. */
  readonly renderTimelineRow: TimelineRowRenderer;
}

/** What one row hands the seat's renderer and the footer seat. */
export interface LedgerFeedRowProps extends TimelineRowSlotProps {
  /** The seat's renderer. STABLE across renders, or this memo moves with it. */
  readonly renderTimelineRow: TimelineRowRenderer;
  /** The footer seat's renderer, or `undefined` while nobody has filled it. */
  readonly renderTimelineRowFooter: TimelineRowFooterRenderer | undefined;
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
  // The FOOTER seat, read here rather than threaded from the pane: unlike the row
  // body it is filled by a plan this console does not compose, so there is no props
  // chain to carry it down. A plain read of a module-scope registration filled
  // before first paint, and identity-stable for the life of that registration —
  // which is what the memo below compares.
  const renderTimelineRowFooter = timelineRowFooterRenderer();
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
            actorHue={chapter.actorId === undefined ? undefined : hueForActor(chapter.actorId)}
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
      const actorHue = projected.actor === undefined ? undefined : hueForActor(projected.actor);
      const isSuperseded = ledgerWindow.supersededRowIds.has(projected.id);
      // A SEAM IS THE LEDGER'S OWN ROW, so it is drawn before the seat is asked.
      // The seat fills with whichever renderer owns a session's row BODIES, and a
      // seam has none: it is a change in the run's condition, laid on one line from
      // parts `seams.ts` derived. Delegating it would render a rollback, a
      // compaction, a switch or a block as an ordinary receipt and drop the boundary
      // position, the continuity, the losses, the reason and the blocked-on state.
      const seam = ledgerWindow.seamByRowId.get(projected.id);
      if (seam !== undefined) {
        return <SeamRow seam={seam} actorHue={actorHue} isSuperseded={isSuperseded} />;
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
          actorHue={actorHue}
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
        />
      );
    },
    [
      hueForActor,
      ledgerWindow,
      openedTerminalRunIds,
      renderTimelineRow,
      rowLease,
      renderTimelineRowFooter,
      toggleChapter,
    ],
  );
}

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
        actorHue: props.actorHue,
        isSuperseded: props.isSuperseded,
        density: props.density,
      })}
      <TimelineRowFooter
        row={props.row}
        isSuperseded={props.isSuperseded}
        renderFooter={props.renderTimelineRowFooter}
      />
    </>
  ),
);
LedgerFeedRow.displayName = "LedgerFeedRow";
