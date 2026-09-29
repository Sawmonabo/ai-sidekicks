import { useCallback } from "react";

import { Nothing } from "@renderer/console/primitives/index.js";
import { type ActorHueAssignment } from "@renderer/styles/agent-hue.js";
import { RunGroupHeader } from "../../run-groups/components/RunGroupHeader.js";
import { type RunGroup } from "../../run-groups/run-groups.js";
import { SystemMessage } from "../../system-messages/components/SystemMessage.js";
import { type RetainedRowState } from "../../viewport/retained-row-state-table.js";
import { type TranscriptRowRenderer } from "../../viewport/components/VirtualRow.js";
import { type ViewportRow } from "../../viewport/viewport-snapshot.js";
import { type TranscriptWindowModel } from "../../window/transcript-window.js";
import { findTranscriptRowFooterRenderer } from "../../transcript-row-footer-renderer.js";
import { type TimelineRowRenderer } from "../../transcript-row-renderer.js";
import { TranscriptFeedRow } from "../components/TranscriptFeedRow.js";
import { densityFor } from "../run-group-fold.js";

/** Everything the dispatch below reads. Each member is stable except the window. */
export interface TranscriptRowRendererOptions {
  readonly ledgerWindow: TranscriptWindowModel;
  readonly openedTerminalRunIds: ReadonlySet<string>;
  readonly hueForActor: (userId: string) => ActorHueAssignment | undefined;
  readonly toggleChapter: (chapter: RunGroup) => void;
  readonly rowLease: (rowKey: string) => RetainedRowState | undefined;
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
export function useTranscriptRowRenderer(
  options: TranscriptRowRendererOptions,
): TranscriptRowRenderer {
  const { ledgerWindow, openedTerminalRunIds, hueForActor, toggleChapter, rowLease } = options;
  const renderTimelineRow = options.renderTimelineRow;
  // The FOOTER seat, read here rather than threaded from the pane: unlike the row
  // body it is filled by a plan this window does not compose, so there is no props
  // chain to carry it down. A plain read of a module-scope registration filled
  // before first paint, and identity-stable for the life of that registration —
  // which is what the memo below compares.
  const renderTimelineRowFooter = findTranscriptRowFooterRenderer();
  return useCallback(
    (row: ViewportRow) => {
      // A CHAPTER HEADER IS A ROW OF THE LIST, keyed by the run it heads, so it is
      // dispatched before the body lookup — there is no projected row behind it and
      // there was never meant to be. Every terminal chapter has one; a live chapter
      // has none and its rows stay top-level.
      const chapter = ledgerWindow.chapterByHeaderKey.get(row.key);
      if (chapter !== undefined) {
        return (
          <RunGroupHeader
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
      // A SEAM IS THE TRANSCRIPT'S OWN ROW, so it is drawn before the seat is asked.
      // The seat fills with whichever renderer owns a session's row BODIES, and a
      // seam has none: it is a change in the run's condition, laid on one line from
      // parts `system-message-classifier.ts` derived. Delegating it would render a rollback, a
      // compaction or a switch as an ordinary receipt and drop the boundary position,
      // the continuity, the losses and the reason.
      const seam = ledgerWindow.seamByRowId.get(projected.id);
      if (seam !== undefined) {
        return <SystemMessage seam={seam} actorHue={actorHue} isSuperseded={isSuperseded} />;
      }
      // THROUGH `TranscriptFeedRow` RATHER THAN STRAIGHT INTO THE SEAT, and the
      // indirection is the memo boundary — see that file. This callback's identity
      // moves on every admitted event because it closes over the window, so the
      // viewport's own row memo cannot hold across one; the four values below are
      // identity-stable when nothing about the row moved, so the card behind them
      // does hold. What runs per row per event is these lookups, not the card.
      return (
        <TranscriptFeedRow
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
