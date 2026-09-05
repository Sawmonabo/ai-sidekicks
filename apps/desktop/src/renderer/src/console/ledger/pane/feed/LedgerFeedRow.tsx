// What one row of this feed draws, and the memo that keeps a frame from redrawing it.
//
// THE DISPATCH AND THE BOUNDARY ARE ONE JOB, so they are one module: three of the
// list's rows are the ledger's own — a chapter header, a seam, and the named absence
// of a row the cap took mid-frame — and only the fourth is the seat's. Deciding which
// of the four a key is takes four map reads; drawing the fourth is a whole card. The
// hook does the reads and the component holds the card behind a memo.
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
//
// AND THE RENDERER IS THE SEAT'S, handed down from the pane and stable for the life of
// the registration. A caller that rebuilt it per render would move this memo on every
// render, which is the defect `LedgerFeedRenders.test.tsx` drives one level up.

import { memo, useCallback } from "react";

import {
  type LedgerRowLease,
  type LedgerRowRenderer,
  type LedgerViewportRow,
} from "../../frame/index.js";
import { ChapterHeader, SeamRow, type LedgerChapter } from "../../structure/index.js";
import { Nothing } from "../../../primitives/index.js";
import { type TimelineRowRenderer, type TimelineRowSlotProps } from "../../../seats/index.js";
import { type ParticipantHueAssignment } from "../../../tokens/index.js";
import { densityFor } from "./ledger-chapter-fold.js";
import { type LedgerWindowModel } from "../window/index.js";

/** Everything the dispatch below reads. Each member is stable except the window. */
export interface LedgerRowRendererOptions {
  readonly ledgerWindow: LedgerWindowModel;
  readonly openedTerminalRunIds: ReadonlySet<string>;
  readonly hueForActor: (participantId: string) => ParticipantHueAssignment | undefined;
  readonly toggleChapter: (chapter: LedgerChapter) => void;
  readonly rowLease: (rowKey: string) => LedgerRowLease | undefined;
  /** The seat's renderer. STABLE across renders, or the memo below moves with it. */
  readonly renderTimelineRow: TimelineRowRenderer;
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
        />
      );
    },
    [hueForActor, ledgerWindow, openedTerminalRunIds, renderTimelineRow, rowLease, toggleChapter],
  );
}

export interface LedgerFeedRowProps extends TimelineRowSlotProps {
  /** The seat's renderer. STABLE across renders, or this memo moves with it. */
  readonly renderTimelineRow: TimelineRowRenderer;
}

/**
 * Draw one row through the seat.
 *
 * Adds no markup of its own: the box, the error boundary and the ARIA position are the
 * viewport's, and a wrapper element here would put a second box between the feed and
 * the article the row role is declared on.
 *
 * An ARROW WITH A DECLARED RETURN TYPE rather than a named function expression, so
 * this module resolves as the one component it declares: the source walk
 * `one-component-per-module.test.ts` runs reads declarations, and a function
 * EXPRESSION inside `memo(...)` is neither a declaration nor an arrow, so the module
 * scored as declaring none — clean against a rule that was never applied to it.
 */
const LedgerFeedRow = memo(
  (props: LedgerFeedRowProps): React.ReactNode =>
    props.renderTimelineRow({
      row: props.row,
      participantHue: props.participantHue,
      isSuperseded: props.isSuperseded,
      density: props.density,
    }),
);
LedgerFeedRow.displayName = "LedgerFeedRow";
